# frozen_string_literal: true

describe PerpLiquidation::Workers::LossMitigationWorker do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }
  let(:order_client) { PerpLiquidation::FakeOrderClient.new }
  let(:position_client) { PerpLiquidation::FakePositionClient.new([position_snapshot]) }
  let(:loss_client) { PerpLiquidation::FakeLossMitigationClient.new }
  let(:orchestrator) do
    PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new,
      loss_mitigation_client: loss_client
    )
  end
  let(:liquidation_worker) do
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator)
  end
  let(:loss_worker) do
    described_class.new(
      repository: repository,
      orchestrator: orchestrator,
      min_age_seconds: 0,
      clock: -> { Time.now.utc + 1 }
    )
  end

  def execute_and_settle_position
    task = receiver.call(command_payload)
    liquidation_worker.perform_once
    orchestrator.handle_order_event(
      event_id: "loss_fill_#{task.task_id}", order_id: task.order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.01', average_price: '54180', fee: '0.2'
    )
    orchestrator.handle_settlement_event(
      event_id: "loss_settlement_#{task.task_id}", task_id: task.task_id,
      order_id: task.order_id, position_id: 888, position_version: 43
    )
    task
  end

  it 'completes after an authoritative check reports no bankruptcy loss' do
    task = execute_and_settle_position

    expect(task.status).to eq(PerpLiquidation::Liquidation::BANKRUPTCY_CHECKING)
    loss_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(repository.bankruptcy_check_for(task.task_id)[:bankruptcy_loss]).to eq('0.0')
    expect(repository.insurance_claim_for(task.task_id)).to be_nil
    expect(repository.pending_outbox.last.payload).to include(
      bankruptcy_loss: '0.0', insurance_fund_covered: '0', adl_triggered: false
    )
  end

  it 'claims the insurance fund and completes when the loss is fully covered' do
    allow(loss_client).to receive(:check_bankruptcy).and_return(
      check_id: 'bankruptcy_full', status: 'COMPLETED', bankruptcy_price: '54000',
      bankruptcy_loss: '10', currency: 'USDT'
    )
    task = execute_and_settle_position

    loss_worker.perform
    expect(task.status).to eq(PerpLiquidation::Liquidation::INSURANCE_CLAIMING)
    loss_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(repository.pending_outbox.last.payload).to include(
      bankruptcy_price: '54000', bankruptcy_loss: '10',
      insurance_fund_covered: '10.0', adl_triggered: false
    )
  end

  it 'requests ADL for residual loss and completes after ADL settlement' do
    adl_client = PerpLiquidation::FakeLossMitigationClient.new(
      bankruptcy_loss: '10', bankruptcy_price: '54000', insurance_covered_amount: '4'
    )
    adl_orchestrator = PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new,
      loss_mitigation_client: adl_client
    )
    adl_liquidation_worker = PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: adl_orchestrator
    )
    adl_worker = described_class.new(
      repository: repository, orchestrator: adl_orchestrator,
      min_age_seconds: 0, clock: -> { Time.now.utc + 1 }
    )
    task = receiver.call(command_payload)
    adl_liquidation_worker.perform_once
    adl_orchestrator.handle_order_event(
      event_id: 'adl_fill', order_id: task.order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.01', average_price: '54180'
    )
    adl_orchestrator.handle_settlement_event(
      event_id: 'adl_position_settlement', task_id: task.task_id,
      order_id: task.order_id, position_id: 888, position_version: 43
    )

    adl_worker.perform
    adl_worker.perform
    expect(task.status).to eq(PerpLiquidation::Liquidation::ADL_REQUIRED)
    adl_worker.perform

    request = repository.adl_request_for(task.task_id)
    expect(task.status).to eq(PerpLiquidation::Liquidation::ADL_SETTLEMENT_PENDING)
    expect(request[:requested_amount]).to eq('6.0')

    adl_client.complete_adl(task.task_id)
    adl_worker.perform

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(repository.pending_outbox.last.payload).to include(
      bankruptcy_loss: '10.0', insurance_fund_covered: '4.0',
      adl_triggered: true, adl_covered_amount: '6.0'
    )
  end

  it 'records and deduplicates an issue when the bankruptcy service is unavailable' do
    failing_client = PerpLiquidation::FakeLossMitigationClient.new
    allow(failing_client).to receive(:check_bankruptcy)
      .and_raise(PerpLiquidation::RetryableError, 'bankruptcy service timeout')
    failing_orchestrator = PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new,
      loss_mitigation_client: failing_client
    )
    task = receiver.call(command_payload)
    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: failing_orchestrator
    ).perform_once
    failing_orchestrator.handle_order_event(
      event_id: 'loss_failure_fill', order_id: task.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.01'
    )
    failing_orchestrator.handle_settlement_event(
      event_id: 'loss_failure_settlement', task_id: task.task_id,
      order_id: task.order_id, position_id: 888, position_version: 43
    )
    worker = described_class.new(
      repository: repository, orchestrator: failing_orchestrator,
      min_age_seconds: 0, clock: -> { Time.now.utc + 1 }
    )

    worker.perform
    worker.perform

    issues = repository.reconciliation_issues(task_id: task.task_id)
    expect(task.status).to eq(PerpLiquidation::Liquidation::BANKRUPTCY_CHECKING)
    expect(issues.size).to eq(1)
    expect(issues.first.issue_type).to eq('LOSS_MITIGATION')
    expect(issues.first.status).to eq('OPEN')
  end
end
