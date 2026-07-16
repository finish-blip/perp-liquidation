# frozen_string_literal: true

describe 'Production scheduling and delivery' do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }

  it 'claims higher-priority liquidation tasks before position reductions' do
    reduce = receiver.call(command_payload(
      risk_decision_id: 'risk_reduce_priority', risk_unit_id: 'position:reduce',
      position_id: 901, decision_sequence: 1, action: 'REDUCE_POSITION', execution_priority: 200
    ))
    liquidate = receiver.call(command_payload(
      risk_decision_id: 'risk_liquidate_priority', risk_unit_id: 'position:liquidate',
      position_id: 902, decision_sequence: 1, action: 'LIQUIDATE_POSITION', execution_priority: 5
    ))

    claimed = repository.claim_next_task!(worker_id: 'worker-priority')

    expect(claimed).to equal(liquidate)
    expect(claimed.priority).to eq(5)
    expect(reduce.priority).to eq(200)
    expect(claimed.claimed_by).to eq('worker-priority')
    expect(claimed.claim_expires_at).to be > Time.now.utc
  end

  it 'ages waiting priorities so an old lower-priority task cannot starve forever' do
    older = receiver.call(command_payload(
      risk_decision_id: 'risk_older_aged', risk_unit_id: 'position:older-aged',
      position_id: 903, decision_sequence: 1, execution_priority: 50
    ))
    newer = receiver.call(command_payload(
      risk_decision_id: 'risk_newer_priority', risk_unit_id: 'position:newer-priority',
      position_id: 904, decision_sequence: 1, execution_priority: 45
    ))
    older.created_at = Time.now.utc - 100

    claimed = repository.claim_next_task!(
      worker_id: 'worker-aging', priority_aging_seconds: 10
    )

    expect(claimed).to equal(older)
    expect(newer.status).to eq(PerpLiquidation::Liquidation::PENDING)
  end

  it 'recovers an expired pre-execution claim with a new worker lease' do
    task = receiver.call(command_payload)
    repository.claim_next_task!(worker_id: 'worker-dead')
    task.claim_expires_at = Time.now.utc - 1

    reclaimed = repository.claim_next_task!(worker_id: 'worker-live')

    expect(reclaimed).to equal(task)
    expect(task.status).to eq(PerpLiquidation::Liquidation::CLAIMED)
    expect(task.claimed_by).to eq('worker-live')
    expect(repository.events_for(task.task_id).map(&:event_type)).to include('EXPIRED_CLAIM_RECOVERED')
  end

  it 'recovers an expired task that crashed after entering execution' do
    task = receiver.call(command_payload)
    repository.claim_next_task!(worker_id: 'worker-dead')
    repository.transition!(task, PerpLiquidation::Liquidation::LOCKING, 'TEST_LOCKING')
    repository.transition!(task, PerpLiquidation::Liquidation::VALIDATING, 'TEST_VALIDATING')
    repository.transition!(task, PerpLiquidation::Liquidation::EXECUTING, 'TEST_EXECUTING')
    task.claim_expires_at = Time.now.utc - 1

    reclaimed = repository.claim_next_task!(worker_id: 'worker-live')

    expect(reclaimed).to equal(task)
    expect(task.status).to eq(PerpLiquidation::Liquidation::CLAIMED)
    expect(task.claimed_by).to eq('worker-live')
  end

  it 'persists one active risk-unit owner and advances the fencing token across owners' do
    first_token = repository.acquire_risk_unit_lease!(
      risk_unit_id: 'position:lease', owner_task_id: 'task-1', fencing_token: 1, lease_seconds: 30
    )

    expect do
      repository.acquire_risk_unit_lease!(
        risk_unit_id: 'position:lease', owner_task_id: 'task-2', fencing_token: 1, lease_seconds: 30
      )
    end.to raise_error(PerpLiquidation::PositionLocked)

    repository.release_risk_unit_lease!(
      risk_unit_id: 'position:lease', owner_task_id: 'task-1', fencing_token: first_token
    )
    second_token = repository.acquire_risk_unit_lease!(
      risk_unit_id: 'position:lease', owner_task_id: 'task-2', fencing_token: 1, lease_seconds: 30
    )

    expect(second_token).to be > first_token
  end

  it 'locks each outbox event for only one dispatcher' do
    task = receiver.call(command_payload)
    repository.enqueue_outbox!(task, topic: 'result', payload: { event_id: 'locked_result' })

    first = repository.claim_outbox_events!(worker_id: 'dispatcher-1')
    second = repository.claim_outbox_events!(worker_id: 'dispatcher-2')

    expect(first.size).to eq(1)
    expect(second).to be_empty
    expect(first.first.locked_by).to eq('dispatcher-1')
  end

  it 'backs off failed outbox delivery and dead-letters at the configured limit' do
    publisher = Class.new do
      def publish(topic:, payload:, event_id:)
        raise PerpLiquidation::RetryableError, "cannot publish #{event_id} to #{topic}"
      end
    end.new
    task = receiver.call(command_payload)
    event = repository.enqueue_outbox!(task, topic: 'result', payload: { event_id: 'dead_result' })
    dispatcher = PerpLiquidation::Workers::OutboxDispatcher.new(
      repository: repository,
      publisher: publisher,
      worker_id: 'dispatcher-failing',
      max_attempts: 2,
      base_delay_seconds: 0
    )

    dispatcher.perform
    expect(event.attempt_count).to eq(1)
    expect(event.dead_lettered_at).to be_nil
    dispatcher.perform

    expect(event.attempt_count).to eq(2)
    expect(event.dead_lettered_at).not_to be_nil
    expect(repository.pending_outbox).not_to include(event)
  end

  it 'renders counters, gauges and observation summaries in Prometheus format' do
    metrics = PerpLiquidation::MetricsRegistry.new
    metrics.increment('liquidation_task_received_total', labels: { action: 'LIQUIDATE_POSITION' })
    metrics.set('liquidation_workers_active', 2)
    metrics.observe('liquidation_order_submit_latency_seconds', 0.25)

    output = metrics.render

    expect(output).to include(
      'liquidation_task_received_total{action="LIQUIDATE_POSITION"} 1',
      'liquidation_workers_active 2.0',
      'liquidation_order_submit_latency_seconds_count 1',
      'liquidation_order_submit_latency_seconds_sum 0.25'
    )
  end

  it 'routes stream topics through the existing idempotent consumers' do
    order_client = PerpLiquidation::FakeOrderClient.new
    position_client = PerpLiquidation::FakePositionClient.new([position_snapshot])
    orchestrator = PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    reconciliation_worker = PerpLiquidation::Workers::ReconciliationWorker.new(
      repository: repository, orchestrator: orchestrator, position_client: position_client
    )
    router = PerpLiquidation::Messaging::EventRouter.new(
      command_receiver: receiver,
      orchestrator: orchestrator,
      reconciliation_worker: reconciliation_worker
    )
    router.repository = repository

    task = router.call('risk.liquidation.command', command_payload)
    duplicate = router.call('risk.liquidation.command', command_payload)

    expect(task).to equal(duplicate)
    expect(repository.all.size).to eq(1)
  end
end
