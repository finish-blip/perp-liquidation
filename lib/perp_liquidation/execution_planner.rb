# frozen_string_literal: true

module PerpLiquidation
  class ExecutionPlanner
    def initialize(command)
      @command = command
    end

    def plan(task_id:)
      definitions = configured_steps || [default_step]
      steps = definitions.each_with_index.map do |definition, index|
        ExecutionStep.new(
          task_id: task_id,
          step_sequence: index + 1,
          quantity: value(definition, :quantity),
          order_type: value(definition, :order_type) || @command.order_type,
          time_in_force: value(definition, :time_in_force) || @command.time_in_force,
          max_slippage: value(definition, :max_slippage) || @command.max_slippage
        )
      end
      LiquidationPlan.new(task_id: task_id, steps: steps)
    end

    private

    def configured_steps
      plan = @command.execution_plan
      plan && value(plan, :steps)
    end

    def default_step
      {
        quantity: @command.target_quantity,
        order_type: @command.order_type,
        time_in_force: @command.time_in_force,
        max_slippage: @command.max_slippage
      }
    end

    def value(hash, key)
      hash.key?(key) ? hash[key] : hash[key.to_s]
    end
  end
end
