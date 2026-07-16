# frozen_string_literal: true

describe 'Perp liquidation contracts' do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }

  it 'routes risk commands through the thin consumer' do
    consumer = PerpLiquidation::Consumers::RiskCommandConsumer.new(receiver)

    task = consumer.call(command_payload)

    expect(task.status).to eq(PerpLiquidation::Liquidation::PENDING)
    expect(task.risk_decision_id).to eq('risk_103')
  end

  it 'validates that position actions are reduce-only and bounded' do
    payload = command_payload(instruction: { reduce_only: false })

    expect { PerpLiquidation::LiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /reduce_only/)
  end

  it 'rejects an execution plan whose step quantities do not match the authorized target' do
    payload = command_payload(
      execution_plan: {
        steps: [
          { quantity: '0.004', order_type: 'LIMIT' },
          { quantity: '0.005', order_type: 'MARKET' }
        ]
      }
    )

    expect { PerpLiquidation::LiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /must equal target_quantity/)
  end

  it 'requires price protection authorization for a liquidation action' do
    payload = command_payload(action: 'LIQUIDATE_POSITION', price_protection: nil)

    expect { PerpLiquidation::LiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /requires price_protection/)
  end

  it 'validates risk-authorized execution priority and quantity mode' do
    command = PerpLiquidation::LiquidationCommand.from_hash(
      command_payload(
        execution_priority: 7,
        instruction: { quantity_mode: 'UP_TO' }
      )
    )

    expect(command.execution_priority).to eq(7)
    expect(command.quantity_mode).to eq('UP_TO')
  end

  it 'validates a complete adaptive execution authorization' do
    command = PerpLiquidation::LiquidationCommand.from_hash(
      command_payload(
        action: 'LIQUIDATE_POSITION',
        execution_policy: adaptive_execution_policy
      )
    )

    expect(command.execution_strategy).to eq('ADAPTIVE')
    expect(command.execution_urgency).to eq('NORMAL')
    expect(command.max_child_orders).to eq(8)
    expect(command.max_child_quantity.to_s('F')).to eq('0.004')
    expect(command.max_book_participation.to_s('F')).to eq('1.0')
  end

  it 'rejects an adaptive policy that can exceed protected book participation' do
    payload = command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(max_book_participation: '1.01')
    )

    expect { PerpLiquidation::LiquidationCommand.from_hash(payload) }
      .to raise_error(PerpLiquidation::InvalidCommand, /max_book_participation/)
  end

  it 'serializes task execution fields without calculating risk' do
    task = receiver.call(command_payload)

    serialized = PerpLiquidation::LiquidationSerializer.call(task)

    expect(serialized).to include(
      task_id: 'liq_risk_103', risk_decision_id: 'risk_103',
      decision_sequence: 103, action: 'REDUCE_POSITION', target_quantity: '0.01'
    )
    expect(serialized).not_to have_key(:margin_ratio)
  end

  it 'configures an HTTP adapter and bounded timeouts for service calls' do
    client = PerpLiquidation::OrderHttpClient.new(
      endpoint: 'http://127.0.0.1:3101', open_timeout: 1.5, timeout: 4
    )
    connection = client.instance_variable_get(:@connection)
    adapter = begin
      connection.builder.adapter
    rescue ArgumentError
      connection.builder.handlers.last
    end

    expect(adapter).to eq(Faraday::Adapter::NetHttp)
    expect(connection.options.open_timeout).to eq(1.5)
    expect(connection.options.timeout).to eq(4.0)
  end
end
