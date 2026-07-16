# frozen_string_literal: true

require 'spec_helper'

RSpec.describe 'Portfolio liquidation plans' do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:coordinator) { PerpLiquidation::PortfolioPlanCoordinator.new(repository: repository) }
  let(:account_client) do
    PerpLiquidation::FakeAccountClient.new([
      PerpLiquidation::AccountSnapshot.new(
        account_id: 'acc_1001', user_id: '1001', version: 88,
        margin_mode: 'CROSS', settlement_currency: 'USDT'
      )
    ])
  end
  let(:receiver) do
    PerpLiquidation::PortfolioPlanReceiver.new(
      repository: repository, account_client: account_client, coordinator: coordinator
    )
  end
  let(:order_client) { PerpLiquidation::FakeOrderClient.new }
  let(:position_client) do
    PerpLiquidation::FakePositionClient.new([
      position_snapshot,
      position_snapshot(
        position_id: 889, version: 70, symbol: 'ETHUSDT', side: 'LONG', size: '2'
      )
    ])
  end
  let(:market_data_client) do
    PerpLiquidation::FakeMarketDataClient.new([
      liquid_market_quote,
      liquid_market_quote(
        symbol: 'ETHUSDT', best_bid: '3010', best_ask: '3011',
        bids: [{ price: '3010', quantity: '10' }],
        asks: [{ price: '3011', quantity: '10' }]
      )
    ])
  end
  let(:orchestrator) do
    PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: market_data_client,
      portfolio_plan_coordinator: coordinator,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
  end
  let(:worker) do
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator)
  end

  it 'validates account-level authorization without calculating portfolio risk' do
    command = PerpLiquidation::PortfolioLiquidationCommand.from_hash(portfolio_command_payload)

    expect(command.margin_mode).to eq('CROSS')
    expect(command.items.map { |item| item[:authorized_notional].to_s('F') }).to eq(%w[60000.0 30000.0])
    expect(command.child_commands.map(&:execution_scope_id).uniq)
      .to eq(['account:acc_1001:settlement:USDT'])
  end

  it 'rejects a plan whose item notionals exceed the parent authorization' do
    payload = portfolio_command_payload(max_total_authorized_notional: '80000')

    expect { PerpLiquidation::PortfolioLiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /notionals exceed/)
  end

  it 'rejects a plan item whose target notional exceeds its authorization' do
    payload = portfolio_command_payload
    payload[:items][0][:authorized_notional] = '500'

    expect { PerpLiquidation::PortfolioLiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /exceeds authorized_notional/)
  end

  it 'creates child tasks atomically and activates only the first item' do
    plan = receiver.call(portfolio_command_payload)
    duplicate = receiver.call(portfolio_command_payload)
    items = repository.portfolio_plan_items_for(plan.plan_id)

    expect(duplicate).to equal(plan)
    expect(plan.status).to eq('EXECUTING')
    expect(items.map(&:status)).to eq(%w[RUNNING WAITING])
    expect(items.map { |item| repository.find!(item.task_id).status })
      .to eq(%w[PENDING PLAN_WAITING])
  end

  it 'admits only one concurrent portfolio plan for an account scope' do
    payloads = [
      portfolio_command_payload,
      portfolio_command_payload(
        plan_id: 'portfolio_plan_202', risk_decision_id: 'portfolio_risk_202', decision_sequence: 202
      )
    ]
    gate = Queue.new
    results = Queue.new
    threads = payloads.map do |payload|
      Thread.new do
        gate.pop
        results << receiver.call(payload)
      rescue StandardError => e
        results << e
      end
    end
    threads.length.times { gate << true }
    threads.each(&:join)
    outcomes = threads.length.times.map { results.pop }

    expect(repository.portfolio_plans.size).to eq(1)
    expect(outcomes.count { |outcome| outcome.is_a?(PerpLiquidation::PortfolioLiquidationPlan) }).to eq(1)
    expect(outcomes.count { |outcome| outcome.is_a?(StandardError) }).to eq(1)
  end

  it 'executes portfolio items serially under one account fencing scope and publishes one parent result' do
    plan = receiver.call(portfolio_command_payload)
    items = repository.portfolio_plan_items_for(plan.plan_id)
    first_task = repository.find!(items[0].task_id)
    second_task = repository.find!(items[1].task_id)

    worker.perform_once
    first_order = order_client.submitted_orders.values.last
    expect(first_order.payload[:risk_unit_id]).to eq(plan.risk_unit_id)
    expect(first_order.payload[:expected_account_version]).to eq(88)
    expect(first_order.payload[:authorized_notional]).to eq('60000.0')
    expect(first_order.payload[:notional_reference_price]).to eq('54200')
    orchestrator.handle_order_event(
      event_id: 'portfolio_fill_1', order_id: first_order.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.01', average_price: '54180'
    )
    position_client.put(position_snapshot(version: 43, size: '0'))
    orchestrator.handle_settlement_event(
      event_id: 'portfolio_settlement_1', task_id: first_task.task_id,
      order_id: first_order.order_id, position_id: 888, position_version: 43,
      account_version: 89
    )

    expect(first_task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(second_task.status).to eq(PerpLiquidation::Liquidation::PENDING)
    expect(repository.pending_outbox).to be_empty

    worker.perform_once
    second_order = order_client.submitted_orders.values.last
    expect(second_order.payload[:risk_unit_id]).to eq(plan.risk_unit_id)
    expect(second_order.payload[:expected_account_version]).to eq(89)
    expect(second_order.payload[:fencing_token]).to be > first_order.payload[:fencing_token]
    orchestrator.handle_order_event(
      event_id: 'portfolio_fill_2', order_id: second_order.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '2', average_price: '3010'
    )
    position_client.put(position_snapshot(
      position_id: 889, version: 71, symbol: 'ETHUSDT', side: 'LONG', size: '0'
    ))
    orchestrator.handle_settlement_event(
      event_id: 'portfolio_settlement_2', task_id: second_task.task_id,
      order_id: second_order.order_id, position_id: 889, position_version: 71,
      account_version: 90
    )

    refreshed_plan = repository.find_portfolio_plan!(plan.plan_id)
    expect(refreshed_plan.status).to eq('COMPLETED')
    expect(refreshed_plan.completed_item_count).to eq(2)
    expect(refreshed_plan.current_account_version).to eq(90)
    expect(repository.portfolio_plan_items_for(plan.plan_id).map(&:status)).to eq(%w[COMPLETED COMPLETED])
    expect(repository.pending_outbox.size).to eq(1)
    expect(repository.pending_outbox.first.payload).to include(
      schema_version: 1,
      plan_id: plan.plan_id,
      risk_decision_id: 'portfolio_risk_201',
      status: 'COMPLETED',
      completed_item_count: 2
    )
    expect(repository.pending_outbox.first.payload[:items].map { |item| item[:status] })
      .to eq(%w[COMPLETED COMPLETED])
  end

  it 'renews the durable lease with the shared account execution scope' do
    payload = portfolio_command_payload
    payload[:items] = [payload[:items].first]
    plan = receiver.call(payload)
    task = repository.find!(repository.portfolio_plan_items_for(plan.plan_id).first.task_id)
    renewing_lock_manager = Class.new do
      def with_lock(risk_unit_id:, owner:, on_renew: nil)
        result = yield 1
        on_renew&.call
        result
      end
    end.new
    renewing_orchestrator = PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: market_data_client,
      portfolio_plan_coordinator: coordinator,
      risk_unit_lock_manager: renewing_lock_manager
    )

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: renewing_orchestrator
    ).perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(task.error_code).to be_nil
  end

  it 'stops the plan and skips later items when the current item fails' do
    position_client.put(position_snapshot(version: 41))
    plan = receiver.call(portfolio_command_payload)

    worker.perform_once

    items = repository.portfolio_plan_items_for(plan.plan_id)
    expect(plan.status).to eq('FAILED')
    expect(items.map(&:status)).to eq(%w[FAILED SKIPPED])
    expect(repository.find!(items[1].task_id).status).to eq(PerpLiquidation::Liquidation::CANCELLED)
    expect(repository.pending_outbox.size).to eq(1)
    expect(repository.pending_outbox.first.payload[:status]).to eq('FAILED')
    expect(order_client.submitted_orders).to be_empty
  end

  it 'rejects a portfolio plan when the authoritative account version changed' do
    account_client.put(PerpLiquidation::AccountSnapshot.new(
      account_id: 'acc_1001', user_id: '1001', version: 89,
      margin_mode: 'CROSS', settlement_currency: 'USDT'
    ))

    expect { receiver.call(portfolio_command_payload) }
      .to raise_error(PerpLiquidation::PreconditionsFailed, /account_version mismatch/)
    expect(repository.portfolio_plans).to be_empty
  end

  it 'requires dual approval and audits a controlled portfolio cancellation' do
    plan = receiver.call(portfolio_command_payload)
    first_task = repository.find!(repository.portfolio_plan_items_for(plan.plan_id).first.task_id)
    repository.transition!(first_task, PerpLiquidation::Liquidation::CLAIMED, 'TEST_TASK_CLAIMED')
    reconciliation_worker = PerpLiquidation::Workers::ReconciliationWorker.new(
      repository: repository, orchestrator: orchestrator, position_client: position_client
    )
    service = PerpLiquidation::OperatorActionService.new(
      repository: repository,
      portfolio_plan_receiver: receiver,
      reconciliation_worker: reconciliation_worker,
      approval_client: PerpLiquidation::FakeApprovalClient.new
    )
    payload = {
      operation_id: 'operator_cancel_plan_1',
      action: 'CANCEL_PORTFOLIO_PLAN',
      target_type: 'PORTFOLIO_PLAN',
      target_id: plan.plan_id,
      operator_id: 'operator-a',
      approver_id: 'operator-b',
      approval_id: 'approval-1001',
      reason: 'exchange maintenance'
    }

    action = service.call(payload)
    duplicate = service.call(payload)

    expect(duplicate.operation_id).to eq(action.operation_id)
    expect(action.status).to eq('COMPLETED')
    expect(plan.status).to eq('CANCELLED')
    expect(repository.portfolio_plan_items_for(plan.plan_id).map(&:status)).to eq(%w[CANCELLED CANCELLED])
    expect(repository.pending_outbox.size).to eq(1)

    expect do
      service.call(payload.merge(operation_id: 'operator_cancel_plan_2', approver_id: 'operator-a'))
    end.to raise_error(PerpLiquidation::InvalidCommand, /must be different/)
  end

  it 'does not execute an operator action when the approval service rejects it' do
    plan = receiver.call(portfolio_command_payload)
    reconciliation_worker = PerpLiquidation::Workers::ReconciliationWorker.new(
      repository: repository, orchestrator: orchestrator, position_client: position_client
    )
    service = PerpLiquidation::OperatorActionService.new(
      repository: repository,
      portfolio_plan_receiver: receiver,
      reconciliation_worker: reconciliation_worker,
      approval_client: PerpLiquidation::FakeApprovalClient.new(approved: false)
    )

    expect do
      service.call(
        operation_id: 'operator_cancel_rejected', action: 'CANCEL_PORTFOLIO_PLAN',
        target_type: 'PORTFOLIO_PLAN', target_id: plan.plan_id,
        operator_id: 'operator-a', approver_id: 'operator-b',
        approval_id: 'approval-rejected', reason: 'maintenance'
      )
    end.to raise_error(PerpLiquidation::PreconditionsFailed, /not approved/)
    expect(plan.status).to eq('EXECUTING')
    expect(repository.operator_action('operator_cancel_rejected')).to be_nil
  end

  it 'keeps every pre-execution cancellable state aligned with the task state machine' do
    PerpLiquidation::PortfolioPlanCoordinator::CANCELLABLE_TASK_STATUSES.each do |status|
      expect(PerpLiquidation::Liquidation::ALLOWED_TRANSITIONS.fetch(status))
        .to include(PerpLiquidation::Liquidation::CANCELLED)
    end
  end

  it 'routes portfolio commands through the Redis Streams event contract' do
    reconciliation_worker = PerpLiquidation::Workers::ReconciliationWorker.new(
      repository: repository, orchestrator: orchestrator, position_client: position_client
    )
    router = PerpLiquidation::Messaging::EventRouter.new(
      command_receiver: PerpLiquidation::CommandReceiver.new(repository: repository),
      portfolio_plan_receiver: receiver,
      orchestrator: orchestrator,
      reconciliation_worker: reconciliation_worker
    )
    router.repository = repository

    plan = router.call('risk.liquidation.portfolio.command', portfolio_command_payload)

    expect(plan.plan_id).to eq('portfolio_plan_201')
    expect(repository.portfolio_plan_items_for(plan.plan_id).size).to eq(2)
  end
end
