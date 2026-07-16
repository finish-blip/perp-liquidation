# frozen_string_literal: true

require 'json'
require 'rack/mock'

describe PerpLiquidation::API::RackApp do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }
  let(:portfolio_coordinator) { PerpLiquidation::PortfolioPlanCoordinator.new(repository: repository) }
  let(:account_client) do
    PerpLiquidation::FakeAccountClient.new([
      PerpLiquidation::AccountSnapshot.new(
        account_id: 'acc_1001', user_id: '1001', version: 88,
        margin_mode: 'CROSS', settlement_currency: 'USDT'
      )
    ])
  end
  let(:portfolio_receiver) do
    PerpLiquidation::PortfolioPlanReceiver.new(
      repository: repository,
      account_client: account_client,
      coordinator: portfolio_coordinator
    )
  end
  let(:position_client) { PerpLiquidation::FakePositionClient.new([position_snapshot]) }
  let(:order_client) { PerpLiquidation::FakeOrderClient.new }
  let(:orchestrator) do
    PerpLiquidation::Orchestrator.new(
      repository: repository, order_client: order_client, position_client: position_client,
      portfolio_plan_coordinator: portfolio_coordinator,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
  end
  let(:reconciliation_worker) do
    PerpLiquidation::Workers::ReconciliationWorker.new(
      repository: repository, orchestrator: orchestrator, position_client: position_client
    )
  end
  let(:approval_client) { PerpLiquidation::FakeApprovalClient.new }
  let(:app) do
    operator_service = PerpLiquidation::OperatorActionService.new(
      repository: repository,
      portfolio_plan_receiver: portfolio_receiver,
      reconciliation_worker: reconciliation_worker,
      approval_client: approval_client
    )
    described_class.new(
      repository: repository,
      command_receiver: receiver,
      portfolio_plan_receiver: portfolio_receiver,
      operator_action_service: operator_service,
      orchestrator: orchestrator,
      reconciliation_worker: reconciliation_worker
    )
  end
  let(:request) { Rack::MockRequest.new(app) }

  it 'returns health status' do
    response = request.get('/health')

    expect(response.status).to eq(200)
    expect(JSON.parse(response.body)['status']).to eq('ok')
  end

  it 'returns Prometheus metrics when a registry is configured' do
    metrics = PerpLiquidation::MetricsRegistry.new
    metrics.increment('liquidation_task_received_total')
    metrics_app = described_class.new(repository: repository, metrics: metrics)

    response = Rack::MockRequest.new(metrics_app).get('/metrics')

    expect(response.status).to eq(200)
    expect(response['Content-Type']).to include('text/plain')
    expect(response.body).to include('liquidation_task_received_total 1')
  end

  it 'requires the configured service token for internal endpoints' do
    protected_app = described_class.new(
      repository: repository, command_receiver: receiver,
      orchestrator: orchestrator, service_token: 'secret'
    )
    protected_request = Rack::MockRequest.new(protected_app)

    denied = protected_request.get('/api/v1/internal/liquidation/tasks')
    allowed = protected_request.get(
      '/api/v1/internal/liquidation/tasks',
      'HTTP_AUTHORIZATION' => 'Bearer secret'
    )

    expect(denied.status).to eq(401)
    expect(allowed.status).to eq(200)
  end

  it 'accepts a risk command and returns the idempotent task' do
    first = request.post(
      '/api/v1/internal/liquidation/commands',
      'CONTENT_TYPE' => 'application/json', input: JSON.generate(command_payload)
    )
    second = request.post(
      '/api/v1/internal/liquidation/commands',
      'CONTENT_TYPE' => 'application/json', input: JSON.generate(command_payload)
    )

    expect(first.status).to eq(202)
    expect(JSON.parse(first.body).dig('data', 'task_id')).to eq('liq_risk_103')
    expect(JSON.parse(second.body).dig('data', 'task_id')).to eq('liq_risk_103')
    expect(repository.all.size).to eq(1)
  end

  it 'returns task details, the risk snapshot, execution and audit events' do
    task = receiver.call(command_payload)

    response = request.get("/api/v1/internal/liquidation/tasks/#{task.task_id}")
    body = JSON.parse(response.body)

    expect(response.status).to eq(200)
    expect(body.dig('data', 'risk_decision_id')).to eq('risk_103')
    expect(body.dig('risk_snapshot', 'margin_ratio')).to eq('0.004')
    expect(body['execution_plan'].first).to include(
      'step_sequence' => 1, 'quantity' => '0.01', 'status' => 'PLANNED'
    )
    expect(body['order_attempts']).to eq([])
    expect(body['events'].map { |event| event['event_type'] }).to include('COMMAND_RECEIVED', 'TASK_PENDING')
  end

  it 'allows risk to cancel a pending decision' do
    receiver.call(command_payload)

    response = request.post(
      '/api/v1/internal/liquidation/commands/risk_103/cancel',
      'CONTENT_TYPE' => 'application/json', input: JSON.generate(reason: 'risk_recovered')
    )

    expect(response.status).to eq(200)
    expect(JSON.parse(response.body).dig('data', 'status')).to eq('CANCELLED')
  end

  it 'accepts order and settlement callbacks' do
    task = receiver.call(command_payload)
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator).perform_once

    order_response = request.post(
      '/api/v1/internal/liquidation/events/orders',
      'CONTENT_TYPE' => 'application/json',
      input: JSON.generate(
        event_id: 'order_api_1', order_id: task.order_id, status: 'FILLED', order_event_sequence: 1,
        filled_quantity: '0.01', average_price: '54180'
      )
    )
    settlement_response = request.post(
      '/api/v1/internal/liquidation/events/settlements',
      'CONTENT_TYPE' => 'application/json',
      input: JSON.generate(
        event_id: 'settlement_api_1', task_id: task.task_id,
        order_id: task.order_id, position_id: 888, position_version: 43
      )
    )

    expect(order_response.status).to eq(202)
    expect(settlement_response.status).to eq(202)
    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
  end

  it 'rejects direct task reconciliation that bypasses dual approval' do
    task = receiver.call(command_payload)
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator).perform_once
    attempt = repository.order_attempts_for(task.task_id).first
    order_client.submitted_orders.delete(attempt.client_order_id)

    reconcile_response = request.post("/api/v1/internal/liquidation/tasks/#{task.task_id}/reconcile")
    expect(reconcile_response.status).to eq(403)
    expect(JSON.parse(reconcile_response.body).fetch('error')).to eq('dual_approval_required')
    expect(repository.reconciliation_issues(task_id: task.task_id)).to be_empty
  end

  it 'rejects direct outbox replay that bypasses dual approval' do
    task = receiver.call(command_payload)
    event = repository.enqueue_outbox!(
      task,
      topic: 'liquidation.execution.result',
      payload: { event_id: 'result_replay' }
    )
    repository.mark_outbox_published!(event)

    response = request.post("/api/v1/internal/liquidation/tasks/#{task.task_id}/replay-outbox")

    expect(response.status).to eq(403)
    expect(JSON.parse(response.body).fetch('error')).to eq('dual_approval_required')
    expect(repository.pending_outbox.map(&:event_id)).not_to include(event.event_id)
  end

  it 'accepts and queries an account-level portfolio liquidation plan' do
    create_response = request.post(
      '/api/v1/internal/liquidation/portfolio-plans',
      'CONTENT_TYPE' => 'application/json', input: JSON.generate(portfolio_command_payload)
    )
    show_response = request.get(
      '/api/v1/internal/liquidation/portfolio-plans/portfolio_plan_201'
    )

    expect(create_response.status).to eq(202)
    expect(show_response.status).to eq(200)
    body = JSON.parse(show_response.body)
    expect(body.dig('data', 'status')).to eq('EXECUTING')
    expect(body['items'].map { |item| item['status'] }).to eq(%w[RUNNING WAITING])
    expect(body['items'].map { |item| item.dig('task', 'status') }).to eq(%w[PENDING PLAN_WAITING])
  end

  it 'executes and queries an audited dual-approval operator action' do
    portfolio_receiver.call(portfolio_command_payload)
    response = request.post(
      '/api/v1/internal/liquidation/operator-actions',
      'CONTENT_TYPE' => 'application/json',
      input: JSON.generate(
        operation_id: 'api_operator_cancel_1',
        action: 'CANCEL_PORTFOLIO_PLAN',
        target_type: 'PORTFOLIO_PLAN',
        target_id: 'portfolio_plan_201',
        operator_id: 'operator-a',
        approver_id: 'operator-b',
        approval_id: 'approval-api-1',
        reason: 'maintenance'
      )
    )
    show = request.get('/api/v1/internal/liquidation/operator-actions/api_operator_cancel_1')

    expect(response.status).to eq(202)
    expect(show.status).to eq(200)
    expect(JSON.parse(show.body).dig('data', 'status')).to eq('COMPLETED')
    expect(repository.find_portfolio_plan!('portfolio_plan_201').status).to eq('CANCELLED')
    expect(approval_client.verified.map { |evidence| evidence[:approval_id] }).to include('approval-api-1')
  end

  it 'rejects direct portfolio cancellation that bypasses dual approval' do
    portfolio_receiver.call(portfolio_command_payload)

    response = request.post(
      '/api/v1/internal/liquidation/portfolio-plans/portfolio_plan_201/cancel',
      'CONTENT_TYPE' => 'application/json',
      input: JSON.generate(reason: 'bypass approval')
    )

    expect(response.status).to eq(403)
    expect(JSON.parse(response.body).fetch('error')).to eq('dual_approval_required')
    expect(repository.find_portfolio_plan!('portfolio_plan_201').status).to eq('EXECUTING')
  end
end
