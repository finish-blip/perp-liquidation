# frozen_string_literal: true

describe PerpLiquidation::Orchestrator do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }
  let(:order_client) { PerpLiquidation::FakeOrderClient.new }
  let(:position_client) { PerpLiquidation::FakePositionClient.new([position_snapshot]) }
  let(:orchestrator) do
    described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
  end
  let(:worker) do
    PerpLiquidation::Workers::LiquidationWorker.new(repository: repository, orchestrator: orchestrator)
  end

  it 'creates one task for duplicate risk decisions and preserves the risk snapshot' do
    first = receiver.call(command_payload)
    second = receiver.call(command_payload)

    expect(second).to equal(first)
    expect(repository.all.size).to eq(1)
    expect(repository.risk_snapshot_for(first.task_id)[:margin_ratio]).to eq('0.004')
  end

  it 'submits an authorized reduce-only opposite-side order' do
    task = receiver.call(command_payload)

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    order = order_client.submitted_orders.values.first
    expect(order.payload).to include(
      risk_decision_id: 'risk_103',
      expected_position_version: 42,
      side: 'SELL',
      quantity: '0.01',
      reduce_only: true,
      source: 'LIQUIDATION'
    )
    expect(order.payload[:fencing_token]).to be > 0
    expect(repository.execution_plan_for(task.task_id).map(&:quantity).map { |value| value.to_s('F') })
      .to eq(['0.01'])
    expect(repository.order_attempts_for(task.task_id).map(&:attempt_sequence)).to eq([1])
  end

  it 'validates a fresh market quote and sends a hard price boundary to the order service' do
    market_data_client = PerpLiquidation::FakeMarketDataClient.new([
      PerpLiquidation::MarketQuote.new(
        symbol: 'BTCUSDT', best_bid: '54190', best_ask: '54210',
        observed_at: Time.now.utc, sequence: 101
      )
    ])
    protected_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: market_data_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    task = receiver.call(command_payload(action: 'LIQUIDATE_POSITION'))

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: protected_orchestrator
    ).perform_once

    order = order_client.submitted_orders.values.first
    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(order.payload).to include(
      bankruptcy_price: '54000.0',
      worst_acceptable_price: '52380.0',
      market_quote_price: '54190.0',
      market_quote_sequence: 101
    )
    expect(repository.events_for(task.task_id).map(&:event_type)).to include('EXECUTION_PRICE_PROTECTED')
  end

  it 'does not submit an order when the market crosses the protected liquidation price' do
    market_data_client = PerpLiquidation::FakeMarketDataClient.new([
      PerpLiquidation::MarketQuote.new(
        symbol: 'BTCUSDT', best_bid: '52000', best_ask: '52010', observed_at: Time.now.utc
      )
    ])
    protected_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: market_data_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    task = receiver.call(command_payload(action: 'LIQUIDATE_POSITION'))

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: protected_orchestrator
    ).perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    expect(task.error_code).to eq('PriceProtectionBreached')
    expect(order_client.submitted_orders).to be_empty
  end

  it 'caps an UP_TO multi-step plan to the current smaller position' do
    position_client.put(position_snapshot(version: 43, size: '0.003'))
    task = receiver.call(command_payload(
      instruction: { quantity_mode: 'UP_TO' },
      execution_plan: {
        steps: [
          { quantity: '0.004', order_type: 'LIMIT' },
          { quantity: '0.006', order_type: 'MARKET' }
        ]
      }
    ))

    worker.perform_once

    plan = repository.execution_plan_for(task.task_id)
    order = order_client.submitted_orders.values.first
    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(plan.map { |step| step.quantity.to_s('F') }).to eq(['0.003', '0.006'])
    expect(plan.map(&:status)).to eq(%w[WORKING SKIPPED])
    expect(order.payload).to include(quantity: '0.003', expected_position_version: 43)

    orchestrator.handle_order_event(
      event_id: 'up_to_fill', order_id: task.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.003', average_price: '54180'
    )
    orchestrator.handle_settlement_event(
      event_id: 'up_to_settlement', task_id: task.task_id, order_id: task.order_id,
      position_id: 888, position_version: 44
    )

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(task.executed_quantity.to_s('F')).to eq('0.003')
  end

  it 'completes an UP_TO instruction without an order when the position is already closed' do
    position_client.put(position_snapshot(version: 43, size: '0'))
    task = receiver.call(command_payload(instruction: { quantity_mode: 'UP_TO' }))

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(task.executed_quantity.to_s('F')).to eq('0.0')
    expect(task.settled_position_version).to eq(43)
    expect(repository.execution_plan_for(task.task_id).map(&:status)).to eq(['SKIPPED'])
    expect(order_client.submitted_orders).to be_empty
  end

  it 'rejects UP_TO execution when the position grew beyond the risk snapshot' do
    position_client.put(position_snapshot(version: 43, size: '0.02'))
    task = receiver.call(command_payload(instruction: { quantity_mode: 'UP_TO' }))

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::REJECTED)
    expect(task.error_message).to include('exceeds authorized snapshot')
    expect(order_client.submitted_orders).to be_empty
  end

  it 'executes a multi-step plan sequentially after each position settlement' do
    task = receiver.call(command_payload(
      execution_plan: {
        steps: [
          { quantity: '0.004', order_type: 'LIMIT', time_in_force: 'IOC', max_slippage: '0.002' },
          { quantity: '0.006', order_type: 'MARKET', time_in_force: 'IOC', max_slippage: '0.005' }
        ]
      }
    ))

    worker.perform_once
    first_order_id = task.order_id
    first_order = order_client.submitted_orders.values.first
    expect(first_order.payload).to include(
      execution_step: 1, order_attempt: 1, quantity: '0.004', type: 'LIMIT',
      expected_position_version: 42
    )

    orchestrator.handle_order_event(
      event_id: 'multi_fill_1', order_id: first_order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.004', average_price: '54200', fee: '0.04'
    )
    position_client.put(position_snapshot(version: 43, size: '0.006'))
    orchestrator.handle_settlement_event(
      event_id: 'multi_settlement_1', task_id: task.task_id,
      order_id: first_order_id, position_id: 888, position_version: 43
    )

    expect(task.status).to eq(PerpLiquidation::Liquidation::PENDING)
    expect(repository.execution_step(task.task_id, 1).status).to eq('SETTLED')
    worker.perform_once

    second_order_id = task.order_id
    second_order = order_client.submitted_orders.values.last
    expect(second_order_id).not_to eq(first_order_id)
    expect(second_order.payload).to include(
      execution_step: 2, order_attempt: 1, quantity: '0.006', type: 'MARKET',
      expected_position_version: 43
    )

    orchestrator.handle_order_event(
      event_id: 'multi_fill_2', order_id: second_order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.006', average_price: '54100', fee: '0.06'
    )
    orchestrator.handle_settlement_event(
      event_id: 'multi_settlement_2', task_id: task.task_id,
      order_id: second_order_id, position_id: 888, position_version: 44
    )

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(task.executed_quantity.to_s('F')).to eq('0.01')
    expect(task.fee.to_s('F')).to eq('0.1')
    expect(repository.execution_plan_for(task.task_id).map(&:status)).to eq(%w[SETTLED SETTLED])
  end

  it 'creates a new attempt after an explicit rejection' do
    order_client.order_status = 'REJECTED'
    task = receiver.call(command_payload)

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    expect(repository.order_attempts_for(task.task_id).map(&:status)).to eq(['REJECTED'])

    order_client.order_status = 'ACCEPTED'
    task.next_retry_at = Time.now.utc - 1
    worker.perform_once

    attempts = repository.order_attempts_for(task.task_id)
    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(attempts.map(&:attempt_sequence)).to eq([1, 2])
    expect(attempts.map(&:status)).to eq(%w[REJECTED ACCEPTED])
  end

  it 'reconciles an uncertain submission with the same order attempt' do
    uncertain_client_class = Class.new(PerpLiquidation::FakeOrderClient) do
      attr_reader :submit_calls

      def submit_liquidation_order(attributes)
        @submit_calls = @submit_calls.to_i + 1
        result = super
        raise PerpLiquidation::RetryableError, 'simulated response timeout' if @submit_calls == 1

        result
      end
    end
    uncertain_client = uncertain_client_class.new
    uncertain_orchestrator = described_class.new(
      repository: repository,
      order_client: uncertain_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    uncertain_worker = PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: uncertain_orchestrator
    )
    task = receiver.call(command_payload)

    uncertain_worker.perform_once
    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    task.next_retry_at = Time.now.utc - 1
    uncertain_worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::ORDER_ACCEPTED)
    expect(uncertain_client.submit_calls).to eq(1)
    expect(repository.order_attempts_for(task.task_id).map(&:attempt_sequence)).to eq([1])
  end

  it 'waits for settlement after fill and publishes the completed result through outbox' do
    task = receiver.call(command_payload)
    worker.perform_once
    order_id = task.order_id

    orchestrator.handle_order_event(
      event_id: 'order_event_1', order_id: order_id, status: 'FILLED', order_event_sequence: 1,
      filled_quantity: '0.01', average_price: '54180', fee: '0.2'
    )
    expect(task.status).to eq(PerpLiquidation::Liquidation::SETTLEMENT_PENDING)
    expect(repository.pending_outbox).to be_empty

    orchestrator.handle_settlement_event(
      event_id: 'settlement_1', task_id: task.task_id, order_id: order_id,
      position_id: 888, position_version: 43
    )
    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)

    publisher = PerpLiquidation::MemoryEventPublisher.new
    dispatcher = PerpLiquidation::Workers::OutboxDispatcher.new(repository: repository, publisher: publisher)
    dispatcher.perform
    dispatcher.perform

    expect(publisher.messages.size).to eq(1)
    expect(publisher.messages.first[:topic]).to eq('liquidation.execution.result')
    expect(publisher.messages.first[:payload]).to include(
      status: 'COMPLETED', executed_quantity: '0.01', position_version_after: 43
    )
  end

  it 'rejects settlement for an unknown order instead of falling back to the current attempt' do
    task = receiver.call(command_payload)
    worker.perform_once
    orchestrator.handle_order_event(
      event_id: 'strict_settlement_fill', order_id: task.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.01', average_price: '54180'
    )

    expect do
      orchestrator.handle_settlement_event(
        event_id: 'strict_settlement_wrong_order', task_id: task.task_id,
        order_id: 'ord_from_another_task', position_id: 888, position_version: 43
      )
    end.to raise_error(PerpLiquidation::NotFound, /does not belong/)

    expect(task.status).to eq(PerpLiquidation::Liquidation::SETTLEMENT_PENDING)
    expect(repository.execution_step(task.task_id, 1).status).to eq('FILLED')
    expect(repository.inbox_processed?('strict_settlement_wrong_order')).to be(false)
  end

  it 'handles partial fills and ignores a duplicated order event' do
    task = receiver.call(command_payload)
    worker.perform_once
    event = {
      event_id: 'partial_1', order_id: task.order_id, status: 'PARTIALLY_FILLED', order_event_sequence: 1,
      filled_quantity: '0.004', average_price: '54190', fee: '0.05'
    }

    first = orchestrator.handle_order_event(event)
    duplicate = orchestrator.handle_order_event(event)

    expect(first.status).to eq(PerpLiquidation::Liquidation::PARTIALLY_FILLED)
    expect(first.executed_quantity.to_s('F')).to eq('0.004')
    expect(duplicate).to be_nil
  end

  it 'ignores an order event with an older sequence without regressing cumulative fills' do
    task = receiver.call(command_payload)
    worker.perform_once
    orchestrator.handle_order_event(
      event_id: 'partial_sequence_2', order_id: task.order_id, status: 'PARTIALLY_FILLED',
      order_event_sequence: 2, filled_quantity: '0.006', average_price: '54190'
    )

    orchestrator.handle_order_event(
      event_id: 'partial_sequence_1', order_id: task.order_id, status: 'PARTIALLY_FILLED',
      order_event_sequence: 1, filled_quantity: '0.004', average_price: '54200'
    )

    attempt = repository.order_attempts_for(task.task_id).first
    expect(task.executed_quantity.to_s('F')).to eq('0.006')
    expect(attempt.executed_quantity.to_s('F')).to eq('0.006')
    expect(attempt.last_event_sequence).to eq(2)
    expect(repository.events_for(task.task_id).map(&:event_type)).to include('ORDER_EVENT_SEQUENCE_IGNORED')
  end

  it 'moves the task to manual review when cumulative fills exceed the requested quantity' do
    task = receiver.call(command_payload)
    worker.perform_once

    orchestrator.handle_order_event(
      event_id: 'overfill_1', order_id: task.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.011', average_price: '54180'
    )

    attempt = repository.order_attempts_for(task.task_id).first
    expect(task.status).to eq(PerpLiquidation::Liquidation::MANUAL_REVIEW)
    expect(task.executed_quantity.to_s('F')).to eq('0.0')
    expect(attempt.executed_quantity.to_s('F')).to eq('0.0')
    expect(attempt.last_event_sequence).to eq(0)
    expect(task.error_message).to include('exceeds requested')
  end

  it 'rejects a stale position version without submitting an order' do
    task = receiver.call(command_payload(position_version: 41))

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::REJECTED)
    expect(task.error_code).to eq('PRECONDITION_REJECTED')
    expect(order_client.submitted_orders).to be_empty
  end

  it 'expires an instruction without submitting an order' do
    task = receiver.call(command_payload(expire_at: (Time.now.utc - 1).iso8601))

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::EXPIRED)
    expect(order_client.submitted_orders).to be_empty
  end

  it 'executes a cancel-orders command without making a risk decision' do
    payload = command_payload(
      risk_decision_id: 'risk_cancel_1', action: 'CANCEL_RISK_ORDERS',
      instruction: {}, decision_sequence: 104
    )
    task = receiver.call(payload)

    worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(order_client.cancel_requests.size).to eq(1)
    expect(order_client.submitted_orders).to be_empty
  end

  it 'supersedes an older pending instruction for the same risk unit' do
    old_task = receiver.call(command_payload(risk_decision_id: 'risk_101', decision_sequence: 101))
    new_task = receiver.call(command_payload(risk_decision_id: 'risk_102', decision_sequence: 102))

    expect(old_task.status).to eq(PerpLiquidation::Liquidation::SUPERSEDED)
    expect(new_task.status).to eq(PerpLiquidation::Liquidation::PENDING)
  end

  it 'rejects an out-of-order decision' do
    receiver.call(command_payload(risk_decision_id: 'risk_105', decision_sequence: 105))
    stale = receiver.call(command_payload(risk_decision_id: 'risk_104', decision_sequence: 104))

    expect(stale.status).to eq(PerpLiquidation::Liquidation::REJECTED)
    expect(repository.pending_outbox.last.payload[:error_code]).to eq('STALE_DECISION')
  end

  it 'executes one adaptive step as multiple depth-bounded child orders with settlement between them' do
    adaptive_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: PerpLiquidation::FakeMarketDataClient.new([liquid_market_quote]),
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    adaptive_worker = PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: adaptive_orchestrator
    )
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy
    ))

    expected_quantities = %w[0.004 0.004 0.002]
    expected_sizes = %w[0.006 0.002 0]
    expected_quantities.each_with_index do |quantity, index|
      adaptive_worker.perform_once
      order = order_client.submitted_orders.values.last
      expect(order.payload).to include(
        quantity: quantity,
        type: 'LIMIT',
        time_in_force: 'IOC',
        limit_price: '52380.0',
        child_order_sequence: index + 1,
        execution_strategy: 'ADAPTIVE'
      )

      adaptive_orchestrator.handle_order_event(
        event_id: "adaptive_fill_#{index + 1}",
        order_id: order.order_id,
        client_order_id: order.client_order_id,
        status: 'FILLED',
        order_event_sequence: 1,
        filled_quantity: quantity,
        average_price: '54180'
      )
      next_version = 43 + index
      position_client.put(position_snapshot(version: next_version, size: expected_sizes[index]))
      adaptive_orchestrator.handle_settlement_event(
        event_id: "adaptive_settlement_#{index + 1}",
        task_id: task.task_id,
        order_id: order.order_id,
        position_id: 888,
        position_version: next_version
      )
    end

    expect(task.status).to eq(PerpLiquidation::Liquidation::COMPLETED)
    expect(task.executed_quantity.to_s('F')).to eq('0.01')
    expect(repository.execution_plan_for(task.task_id).map(&:status)).to eq(['SETTLED'])
    expect(repository.order_attempts_for(task.task_id).map { |attempt| attempt.requested_quantity.to_s('F') })
      .to eq(expected_quantities)
    expect(repository.pending_outbox.last.payload).to include(
      execution_strategy: 'ADAPTIVE', child_order_count: 3
    )
  end

  it 'defers adaptive execution without consuming retry budget when protected depth is insufficient' do
    shallow_quote = liquid_market_quote(bids: [], quantity_increment: '0.001')
    adaptive_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: PerpLiquidation::FakeMarketDataClient.new([shallow_quote]),
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new,
      execution_defer_seconds: 0.1
    )
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy
    ))

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: adaptive_orchestrator
    ).perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    expect(task.error_code).to eq('InsufficientMarketLiquidity')
    expect(task.retry_count).to eq(0)
    expect(order_client.submitted_orders).to be_empty
  end

  it 'rejects the remaining exposure after the risk-authorized child-order budget is exhausted' do
    adaptive_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: PerpLiquidation::FakeMarketDataClient.new([liquid_market_quote]),
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    adaptive_worker = PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: adaptive_orchestrator
    )
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(max_child_orders: 1)
    ))

    adaptive_worker.perform_once
    order = order_client.submitted_orders.values.last
    adaptive_orchestrator.handle_order_event(
      event_id: 'budget_fill_1', order_id: order.order_id, status: 'FILLED',
      order_event_sequence: 1, filled_quantity: '0.004', average_price: '54180'
    )
    position_client.put(position_snapshot(version: 43, size: '0.006'))
    adaptive_orchestrator.handle_settlement_event(
      event_id: 'budget_settlement_1', task_id: task.task_id,
      order_id: order.order_id, position_id: 888, position_version: 43
    )
    adaptive_worker.perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::REJECTED)
    expect(task.error_code).to eq('EXECUTION_POLICY_EXHAUSTED')
    expect(task.executed_quantity.to_s('F')).to eq('0.004')
    expect(order_client.submitted_orders.size).to eq(1)
  end

  it 'defers a symbol when the configured in-flight liquidation limit is reached' do
    blocker = receiver.call(command_payload(
      risk_decision_id: 'risk_symbol_blocker',
      risk_unit_id: 'position:symbol-blocker',
      decision_sequence: 1,
      position_id: 999
    ))
    blocker.status = PerpLiquidation::Liquidation::ORDER_ACCEPTED
    task = receiver.call(command_payload(
      risk_decision_id: 'risk_symbol_candidate',
      risk_unit_id: 'position:symbol-candidate',
      decision_sequence: 1
    ))
    constrained_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new,
      max_active_orders_per_symbol: 1,
      execution_defer_seconds: 0.1
    )

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: constrained_orchestrator
    ).perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    expect(task.error_code).to eq('ExecutionBackpressure')
    expect(task.retry_count).to eq(0)
    expect(order_client.submitted_orders).to be_empty
  end

  it 'cancels a timed-out adaptive child order and settles its partial fill before replanning' do
    adaptive_orchestrator = described_class.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: PerpLiquidation::FakeMarketDataClient.new([liquid_market_quote]),
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    adaptive_worker = PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: adaptive_orchestrator
    )
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(child_order_timeout_ms: 100)
    ))
    adaptive_worker.perform_once
    attempt = repository.order_attempts_for(task.task_id).first
    attempt.updated_at = Time.now.utc - 1
    order_client.submitted_orders[attempt.client_order_id] = PerpLiquidation::OrderResult.new(
      order_id: attempt.order_id,
      client_order_id: attempt.client_order_id,
      status: 'PARTIALLY_FILLED',
      filled_quantity: '0.002',
      average_price: '54190'
    )

    adaptive_orchestrator.reconcile_order(task)

    step = repository.execution_step(task.task_id, 1)
    expect(task.status).to eq(PerpLiquidation::Liquidation::SETTLEMENT_PENDING)
    expect(step.status).to eq('PARTIAL_SETTLEMENT_PENDING')
    expect(task.executed_quantity.to_s('F')).to eq('0.002')
    expect(repository.order_attempts_for(task.task_id).first.status).to eq('CANCELLED')

    adaptive_orchestrator.handle_settlement_event(
      event_id: 'cancelled_partial_settlement',
      task_id: task.task_id,
      order_id: attempt.order_id,
      position_id: 888,
      position_version: 43
    )

    expect(task.status).to eq(PerpLiquidation::Liquidation::PENDING)
    expect(repository.execution_step(task.task_id, 1).status).to eq('PLANNED')
    expect(repository.execution_step(task.task_id, 1).remaining_quantity.to_s('F')).to eq('0.008')

    adaptive_orchestrator.handle_settlement_event(
      event_id: 'cancelled_partial_settlement_delayed_duplicate',
      task_id: task.task_id,
      order_id: attempt.order_id,
      position_id: 888,
      position_version: 43
    )
    expect(repository.events_for(task.task_id).map(&:event_type))
      .to include('HISTORICAL_CHILD_SETTLEMENT_IGNORED')
  end
end
