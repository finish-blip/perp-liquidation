# frozen_string_literal: true

require 'spec_helper'

RSpec.describe PerpLiquidation::AdaptiveExecutionStrategy do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }

  it 'rounds protected book participation down to the market quantity increment' do
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(max_book_participation: '0.5')
    ))
    step = repository.next_execution_step(task.task_id)

    decision = described_class.new.plan(
      task: task,
      step: step,
      execution_protection: {
        market_depth_quantity: '0.005',
        quantity_increment: '0.001',
        worst_acceptable_price: '52380'
      },
      submitted_child_orders: 0
    )

    expect(decision[:quantity].to_s('F')).to eq('0.002')
    expect(decision[:order_type]).to eq('LIMIT')
    expect(decision[:limit_price]).to eq('52380')
  end

  it 'rejects a new child order after the authorized budget is exhausted' do
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      execution_policy: adaptive_execution_policy(max_child_orders: 1)
    ))

    expect do
      described_class.new.plan(
        task: task,
        step: repository.next_execution_step(task.task_id),
        execution_protection: {
          market_depth_quantity: '1', quantity_increment: '0.001', worst_acceptable_price: '52380'
        },
        submitted_child_orders: 1
      )
    end.to raise_error(PerpLiquidation::ExecutionPolicyExhausted)
  end
end
