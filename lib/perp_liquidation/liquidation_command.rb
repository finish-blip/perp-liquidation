# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class LiquidationCommand
    ACTIONS = %w[CANCEL_RISK_ORDERS REDUCE_POSITION LIQUIDATE_POSITION].freeze
    POSITION_ACTIONS = %w[REDUCE_POSITION LIQUIDATE_POSITION].freeze
    QUANTITY_MODES = %w[EXACT UP_TO].freeze

    ATTRIBUTES = %i[
      schema_version risk_decision_id risk_unit_id decision_sequence action execution_priority
      user_id account_id position_id position_version symbol position_side
      target_quantity max_executable_quantity quantity_mode order_type reduce_only
      time_in_force max_slippage bankruptcy_price max_liquidation_deviation quote_max_age_ms
      execution_strategy execution_urgency max_child_orders max_child_quantity
      min_child_quantity max_book_participation child_order_cooldown_ms child_order_timeout_ms
      execution_scope_id portfolio_plan_id plan_item_sequence authorized_notional
      execution_plan risk_snapshot expire_at created_at raw_payload
    ].freeze

    attr_reader(*ATTRIBUTES)

    def self.from_hash(payload)
      instruction = fetch(payload, :instruction, required: false) || {}
      price_protection = fetch(payload, :price_protection, required: false) || {}
      execution_policy = fetch(payload, :execution_policy, required: false) || {}
      new(
        schema_version: fetch(payload, :schema_version),
        risk_decision_id: fetch(payload, :risk_decision_id),
        risk_unit_id: fetch(payload, :risk_unit_id),
        decision_sequence: fetch(payload, :decision_sequence),
        action: fetch(payload, :action),
        execution_priority: fetch(payload, :execution_priority, required: false),
        user_id: fetch(payload, :user_id),
        account_id: fetch(payload, :account_id),
        position_id: fetch(payload, :position_id),
        position_version: fetch(payload, :position_version),
        symbol: fetch(payload, :symbol),
        position_side: fetch(payload, :position_side),
        target_quantity: fetch(instruction, :target_quantity, required: false),
        max_executable_quantity: fetch(instruction, :max_executable_quantity, required: false),
        quantity_mode: fetch(instruction, :quantity_mode, required: false),
        order_type: fetch(instruction, :order_type, required: false),
        reduce_only: fetch(instruction, :reduce_only, required: false),
        time_in_force: fetch(instruction, :time_in_force, required: false),
        max_slippage: fetch(instruction, :max_slippage, required: false),
        bankruptcy_price: fetch(price_protection, :bankruptcy_price, required: false),
        max_liquidation_deviation: fetch(price_protection, :max_deviation, required: false),
        quote_max_age_ms: fetch(price_protection, :quote_max_age_ms, required: false),
        execution_strategy: fetch(execution_policy, :strategy, required: false),
        execution_urgency: fetch(execution_policy, :urgency, required: false),
        max_child_orders: fetch(execution_policy, :max_child_orders, required: false),
        max_child_quantity: fetch(execution_policy, :max_child_quantity, required: false),
        min_child_quantity: fetch(execution_policy, :min_child_quantity, required: false),
        max_book_participation: fetch(execution_policy, :max_book_participation, required: false),
        child_order_cooldown_ms: fetch(execution_policy, :child_order_cooldown_ms, required: false),
        child_order_timeout_ms: fetch(execution_policy, :child_order_timeout_ms, required: false),
        execution_scope_id: fetch(payload, :execution_scope_id, required: false),
        portfolio_plan_id: fetch(payload, :portfolio_plan_id, required: false),
        plan_item_sequence: fetch(payload, :plan_item_sequence, required: false),
        authorized_notional: fetch(payload, :authorized_notional, required: false),
        execution_plan: fetch(payload, :execution_plan, required: false),
        risk_snapshot: fetch(payload, :risk_snapshot, required: false) || {},
        expire_at: fetch(payload, :expire_at),
        created_at: fetch(payload, :created_at, required: false),
        raw_payload: payload
      )
    end

    def self.fetch(hash, key, required: true)
      return hash[key] if hash.key?(key)
      return hash[key.to_s] if hash.key?(key.to_s)
      return nil unless required

      raise MissingField, "missing #{key} in liquidation command"
    end

    def initialize(attributes)
      @schema_version = Integer(attributes[:schema_version])
      @risk_decision_id = attributes[:risk_decision_id].to_s
      @risk_unit_id = attributes[:risk_unit_id].to_s
      @decision_sequence = Integer(attributes[:decision_sequence])
      @action = attributes[:action].to_s
      @execution_priority = attributes[:execution_priority].nil? ? nil : Integer(attributes[:execution_priority])
      @user_id = attributes[:user_id]
      @account_id = attributes[:account_id]
      @position_id = attributes[:position_id]
      @position_version = Integer(attributes[:position_version])
      @symbol = attributes[:symbol].to_s
      @position_side = attributes[:position_side].to_s
      @target_quantity = decimal(attributes[:target_quantity])
      @max_executable_quantity = decimal(attributes[:max_executable_quantity])
      @quantity_mode = (attributes[:quantity_mode] || 'EXACT').to_s
      @order_type = attributes[:order_type]&.to_s
      @reduce_only = attributes[:reduce_only]
      @time_in_force = attributes[:time_in_force]&.to_s
      @max_slippage = decimal(attributes[:max_slippage])
      @bankruptcy_price = decimal(attributes[:bankruptcy_price])
      @max_liquidation_deviation = decimal(attributes[:max_liquidation_deviation])
      @quote_max_age_ms = attributes[:quote_max_age_ms].nil? ? nil : Integer(attributes[:quote_max_age_ms])
      @execution_strategy = (attributes[:execution_strategy] || 'STATIC').to_s
      @execution_urgency = (attributes[:execution_urgency] || 'NORMAL').to_s
      @max_child_orders = attributes[:max_child_orders].nil? ? nil : Integer(attributes[:max_child_orders])
      @max_child_quantity = decimal(attributes[:max_child_quantity])
      @min_child_quantity = decimal(attributes[:min_child_quantity])
      @max_book_participation = decimal(attributes[:max_book_participation])
      @child_order_cooldown_ms = attributes[:child_order_cooldown_ms].nil? ? nil : Integer(attributes[:child_order_cooldown_ms])
      @child_order_timeout_ms = attributes[:child_order_timeout_ms].nil? ? nil : Integer(attributes[:child_order_timeout_ms])
      @execution_scope_id = (attributes[:execution_scope_id] || @risk_unit_id).to_s
      @portfolio_plan_id = attributes[:portfolio_plan_id]&.to_s
      @plan_item_sequence = attributes[:plan_item_sequence].nil? ? nil : Integer(attributes[:plan_item_sequence])
      @authorized_notional = decimal(attributes[:authorized_notional])
      @execution_plan = normalize_execution_plan(attributes[:execution_plan])
      @risk_snapshot = attributes[:risk_snapshot]
      @expire_at = timestamp(attributes[:expire_at])
      @created_at = timestamp(attributes[:created_at]) || Time.now.utc
      @raw_payload = attributes[:raw_payload]
      validate!
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, e.message
    end

    def position_action?
      POSITION_ACTIONS.include?(action)
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result|
        value = public_send(name)
        result[name] = normalize(value)
      end
    end

    private

    def validate!
      raise InvalidCommand, 'schema_version must be 1' unless schema_version == 1
      raise InvalidCommand, 'risk_decision_id is required' if risk_decision_id.empty?
      raise InvalidCommand, 'risk_unit_id is required' if risk_unit_id.empty?
      raise InvalidCommand, 'decision_sequence must be positive' unless decision_sequence.positive?
      raise InvalidCommand, "unsupported action #{action.inspect}" unless ACTIONS.include?(action)
      if execution_priority && !execution_priority.between?(0, 1000)
        raise InvalidCommand, 'execution_priority must be between 0 and 1000'
      end
      raise InvalidCommand, "invalid position_side #{position_side.inspect}" unless %w[LONG SHORT].include?(position_side)
      return unless position_action?

      raise InvalidCommand, 'target_quantity must be positive' unless target_quantity&.positive?
      unless max_executable_quantity&.positive? && target_quantity <= max_executable_quantity
        raise InvalidCommand, 'max_executable_quantity must cover target_quantity'
      end
      raise InvalidCommand, 'reduce_only must be true' unless reduce_only == true
      raise InvalidCommand, "invalid quantity_mode #{quantity_mode.inspect}" unless QUANTITY_MODES.include?(quantity_mode)
      raise InvalidCommand, 'order_type is required' if order_type.to_s.empty?
      validate_price_protection!
      validate_execution_plan!
      validate_execution_policy!
      validate_portfolio_metadata!
    end

    def validate_price_protection!
      configured = bankruptcy_price || max_liquidation_deviation || quote_max_age_ms
      if action == 'LIQUIDATE_POSITION' && !configured
        raise InvalidCommand, 'LIQUIDATE_POSITION requires price_protection'
      end
      return unless configured

      raise InvalidCommand, 'bankruptcy_price must be positive' unless bankruptcy_price&.positive?
      unless max_liquidation_deviation&.positive? && max_liquidation_deviation < 1
        raise InvalidCommand, 'max_deviation must be greater than 0 and less than 1'
      end
      unless quote_max_age_ms&.between?(1, 60_000)
        raise InvalidCommand, 'quote_max_age_ms must be between 1 and 60000'
      end
      market_data_timestamp = self.class.fetch(risk_snapshot, :market_data_timestamp, required: false)
      raise InvalidCommand, 'risk_snapshot.market_data_timestamp is required' unless market_data_timestamp

      timestamp(market_data_timestamp)
    end

    def validate_execution_plan!
      return unless execution_plan

      steps = execution_plan[:steps]
      raise InvalidCommand, 'execution_plan.steps must not be empty' if steps.empty?
      raise InvalidCommand, 'execution_plan supports at most 32 steps' if steps.length > 32

      total = steps.reduce(BigDecimal('0')) do |sum, step|
        raise InvalidCommand, 'execution step quantity must be positive' unless step[:quantity]&.positive?
        effective_order_type = step[:order_type] || order_type
        raise InvalidCommand, 'execution step order_type is required' if effective_order_type.to_s.empty?

        sum + step[:quantity]
      end
      unless total == target_quantity
        raise InvalidCommand, 'execution step quantities must equal target_quantity'
      end
    end

    def validate_execution_policy!
      unless %w[STATIC ADAPTIVE].include?(execution_strategy)
        raise InvalidCommand, "unsupported execution strategy #{execution_strategy.inspect}"
      end
      unless %w[NORMAL HIGH CRITICAL].include?(execution_urgency)
        raise InvalidCommand, "unsupported execution urgency #{execution_urgency.inspect}"
      end
      return if execution_strategy == 'STATIC'

      raise InvalidCommand, 'ADAPTIVE execution requires price_protection' unless bankruptcy_price
      unless max_child_orders&.between?(1, 32)
        raise InvalidCommand, 'max_child_orders must be between 1 and 32'
      end
      unless max_child_quantity&.positive? && max_child_quantity <= target_quantity
        raise InvalidCommand, 'max_child_quantity must be positive and not exceed target_quantity'
      end
      unless min_child_quantity&.positive? && min_child_quantity <= max_child_quantity
        raise InvalidCommand, 'min_child_quantity must be positive and not exceed max_child_quantity'
      end
      unless max_book_participation&.positive? && max_book_participation <= 1
        raise InvalidCommand, 'max_book_participation must be greater than 0 and at most 1'
      end
      unless child_order_cooldown_ms&.between?(0, 60_000)
        raise InvalidCommand, 'child_order_cooldown_ms must be between 0 and 60000'
      end
      unless child_order_timeout_ms&.between?(100, 300_000)
        raise InvalidCommand, 'child_order_timeout_ms must be between 100 and 300000'
      end
      if execution_plan && max_child_orders < execution_plan[:steps].length
        raise InvalidCommand, 'max_child_orders must cover every configured execution step'
      end
    end

    def validate_portfolio_metadata!
      raise InvalidCommand, 'execution_scope_id is required' if execution_scope_id.empty?
      configured = portfolio_plan_id || plan_item_sequence || authorized_notional
      return unless configured

      raise InvalidCommand, 'portfolio_plan_id is required' if portfolio_plan_id.to_s.empty?
      raise InvalidCommand, 'plan_item_sequence must be positive' unless plan_item_sequence&.positive?
      raise InvalidCommand, 'authorized_notional must be positive' unless authorized_notional&.positive?
    end

    def normalize_execution_plan(plan)
      return nil if plan.nil?
      raise InvalidCommand, 'execution_plan must be an object' unless plan.respond_to?(:key?)

      steps = self.class.fetch(plan, :steps, required: false)
      raise InvalidCommand, 'execution_plan.steps must be an array' unless steps.is_a?(Array)

      {
        steps: steps.map do |step|
          raise InvalidCommand, 'execution plan step must be an object' unless step.respond_to?(:key?)

          {
            quantity: decimal(self.class.fetch(step, :quantity, required: false)),
            order_type: self.class.fetch(step, :order_type, required: false)&.to_s,
            time_in_force: self.class.fetch(step, :time_in_force, required: false)&.to_s,
            max_slippage: decimal(self.class.fetch(step, :max_slippage, required: false))
          }
        end
      }
    end

    def decimal(value)
      value.nil? ? nil : BigDecimal(value.to_s)
    end

    def timestamp(value)
      return nil if value.nil?
      return value.utc if value.respond_to?(:utc)

      Time.parse(value.to_s).utc
    end

    def normalize(value)
      case value
      when BigDecimal then value.to_s('F')
      when Time then value.iso8601
      when Array then value.map { |item| normalize(item) }
      when Hash then value.each_with_object({}) { |(key, item), result| result[key] = normalize(item) }
      else value
      end
    end
  end
end
