# frozen_string_literal: true

require 'bigdecimal'

module PerpLiquidation
  class AdaptiveExecutionStrategy
    def plan(task:, step:, execution_protection:, submitted_child_orders:)
      return static_plan(step) unless task.execution_strategy == 'ADAPTIVE'

      if submitted_child_orders >= task.max_child_orders
        raise ExecutionPolicyExhausted,
              "adaptive execution exhausted #{task.max_child_orders} authorized child orders"
      end

      depth = decimal(execution_protection, :market_depth_quantity)
      increment = decimal(execution_protection, :quantity_increment)
      unless depth&.positive? && increment&.positive?
        raise InsufficientMarketLiquidity, 'adaptive execution requires positive protected market depth and quantity increment'
      end

      depth_cap = floor_to_increment(depth * task.max_book_participation, increment)
      child_quantity = [step.remaining_quantity, task.max_child_quantity, depth_cap].min
      child_quantity = floor_to_increment(child_quantity, increment)
      minimum = [task.min_child_quantity, step.remaining_quantity].min
      if child_quantity < minimum
        raise InsufficientMarketLiquidity,
              "protected market depth permits #{child_quantity.to_s('F')}, below required #{minimum.to_s('F')}"
      end

      order_type = task.execution_urgency == 'NORMAL' ? 'LIMIT' : 'MARKET'
      {
        quantity: child_quantity,
        order_type: order_type,
        time_in_force: 'IOC',
        limit_price: order_type == 'LIMIT' ? execution_protection.fetch(:worst_acceptable_price) : nil,
        child_order_sequence: submitted_child_orders + 1,
        market_depth_quantity: depth,
        depth_quantity_cap: depth_cap,
        quantity_increment: increment
      }
    end

    private

    def static_plan(step)
      {
        quantity: step.remaining_quantity,
        order_type: step.order_type,
        time_in_force: step.time_in_force,
        limit_price: nil,
        child_order_sequence: nil,
        market_depth_quantity: nil,
        depth_quantity_cap: nil,
        quantity_increment: nil
      }
    end

    def decimal(hash, key)
      value = hash[key] || hash[key.to_s]
      value.nil? ? nil : BigDecimal(value.to_s)
    end

    def floor_to_increment(quantity, increment)
      return BigDecimal('0') unless quantity.positive?

      (quantity / increment).floor * increment
    end
  end
end
