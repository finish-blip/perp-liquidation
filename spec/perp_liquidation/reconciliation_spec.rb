# frozen_string_literal: true

describe PerpLiquidation::Workers::ReconciliationWorker do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }
  let(:order_client) { PerpLiquidation::FakeOrderClient.new }
  let(:position_client) { PerpLiquidation::FakePositionClient.new([position_snapshot]) }
  let(:orchestrator) do
    PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
  end
  let(:liquidation_worker) do
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator)
  end
  let(:reconciliation_worker) do
    described_class.new(
      repository: repository,
      orchestrator: orchestrator,
      position_client: position_client
    )
  end
  let(:recovery_worker) do
    PerpLiquidation::Workers::RecoveryWorker.new(reconciliation_worker: reconciliation_worker)
  end

  it 'recovers a missed fill event by querying the existing order' do
    task = receiver.call(command_payload)
    liquidation_worker.perform_once
    attempt = repository.order_attempts_for(task.task_id).first
    order_client.submitted_orders[attempt.client_order_id] = PerpLiquidation::OrderResult.new(
      order_id: attempt.order_id,
      client_order_id: attempt.client_order_id,
      status: 'FILLED',
      filled_quantity: '0.01',
      average_price: '54180',
      fee: '0.2'
    )
    task.updated_at = Time.now.utc - 60

    recovery_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::SETTLEMENT_PENDING)
    expect(task.executed_quantity.to_s('F')).to eq('0.01')
    expect(repository.reconciliation_issues(task_id: task.task_id)).to be_empty
  end

  it 'deduplicates an open issue and resolves it after order service recovery' do
    task = receiver.call(command_payload)
    liquidation_worker.perform_once
    attempt = repository.order_attempts_for(task.task_id).first
    result = order_client.submitted_orders.delete(attempt.client_order_id)
    task.updated_at = Time.now.utc - 60

    recovery_worker.perform
    task.updated_at = Time.now.utc - 60
    recovery_worker.perform

    issues = repository.reconciliation_issues(task_id: task.task_id)
    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(issues.size).to eq(1)
    expect(issues.first.status).to eq('OPEN')
    expect(issues.first.issue_type).to eq('ORDER_RECONCILIATION')

    order_client.submitted_orders[attempt.client_order_id] = result
    task.updated_at = Time.now.utc - 60
    recovery_worker.perform

    expect(repository.reconciliation_issues(task_id: task.task_id).first.status).to eq('RESOLVED')
  end

  it 'recovers a missed settlement event from the authoritative settlement query' do
    task = receiver.call(command_payload)
    liquidation_worker.perform_once
    orchestrator.handle_order_event(
      event_id: 'reconcile_fill_1', order_id: task.order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.01', average_price: '54180', fee: '0.2'
    )
    position_client.put_settlement(order_id: task.order_id, position_id: 888, position_version: 43)
    task.updated_at = Time.now.utc - 60

    recovery_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(task.settled_position_version).to eq(43)
    expect(repository.pending_outbox.size).to eq(1)
  end

  it 'records an issue while settlement is not yet confirmed' do
    task = receiver.call(command_payload)
    liquidation_worker.perform_once
    orchestrator.handle_order_event(
      event_id: 'reconcile_fill_2', order_id: task.order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.01', average_price: '54180'
    )
    task.updated_at = Time.now.utc - 60

    recovery_worker.perform

    issue = repository.reconciliation_issues(task_id: task.task_id).first
    expect(task.status).to eq(PerpLiquidation::Liquidation::SETTLEMENT_PENDING)
    expect(issue.issue_type).to eq('SETTLEMENT_RECONCILIATION')
    expect(issue.status).to eq('OPEN')
  end

  it 'finishes a task left in result publishing when its outbox record exists' do
    task = receiver.call(command_payload)
    task.status = PerpLiquidation::Liquidation::RESULT_PUBLISHING
    task.updated_at = Time.now.utc - 60
    repository.enqueue_outbox!(task, topic: 'liquidation.execution.result', payload: { event_id: 'result_stuck' })

    recovery_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
  end

  it 'uses the adaptive child-order timeout instead of the static reconciliation age' do
    now = Time.now.utc
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(child_order_timeout_ms: 100)
    ))
    task.status = PerpLiquidation::Liquidation::ORDER_ACCEPTED
    task.updated_at = now - 0.2
    scanner = PerpLiquidation::Reconciliation::StuckTaskScanner.new(
      repository: repository,
      clock: -> { now }
    )

    expect(scanner.call).to include(task)
  end
end
