# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class PortfolioLiquidationCommand
    MARGIN_MODES = %w[CROSS PORTFOLIO].freeze
    ITEM_ACTIONS = %w[REDUCE_POSITION LIQUIDATE_POSITION].freeze

    attr_reader :schema_version, :plan_id, :risk_decision_id, :risk_unit_id,
                :decision_sequence, :action, :execution_priority, :user_id, :account_id,
                :account_version, :margin_mode, :max_total_authorized_notional,
                :failure_mode, :items, :expire_at, :created_at, :raw_payload

    def self.from_hash(payload)
      new(payload)
    end

    def initialize(payload)
      @schema_version = Integer(fetch(payload, :schema_version))
      @plan_id = fetch(payload, :plan_id).to_s
      @risk_decision_id = fetch(payload, :risk_decision_id).to_s
      @risk_unit_id = fetch(payload, :risk_unit_id).to_s
      @decision_sequence = Integer(fetch(payload, :decision_sequence))
      @action = fetch(payload, :action).to_s
      @execution_priority = Integer(fetch(payload, :execution_priority, required: false) || 10)
      @user_id = fetch(payload, :user_id)
      @account_id = fetch(payload, :account_id).to_s
      @account_version = Integer(fetch(payload, :account_version))
      @margin_mode = fetch(payload, :margin_mode).to_s
      @max_total_authorized_notional = BigDecimal(fetch(payload, :max_total_authorized_notional).to_s)
      @failure_mode = (fetch(payload, :failure_mode, required: false) || 'STOP_ON_FAILURE').to_s
      @expire_at = timestamp(fetch(payload, :expire_at))
      @created_at = timestamp(fetch(payload, :created_at, required: false)) || Time.now.utc
      @raw_payload = payload
      @items = normalize_items(fetch(payload, :items))
      validate!
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, e.message
    end

    def child_commands
      items.map do |item|
        LiquidationCommand.from_hash(child_payload(item))
      end
    end

    def snapshot
      {
        schema_version: schema_version,
        plan_id: plan_id,
        risk_decision_id: risk_decision_id,
        risk_unit_id: risk_unit_id,
        decision_sequence: decision_sequence,
        action: action,
        execution_priority: execution_priority,
        user_id: user_id,
        account_id: account_id,
        account_version: account_version,
        margin_mode: margin_mode,
        max_total_authorized_notional: max_total_authorized_notional.to_s('F'),
        failure_mode: failure_mode,
        items: items,
        expire_at: expire_at.iso8601,
        created_at: created_at.iso8601
      }
    end

    private

    def validate!
      raise InvalidCommand, 'portfolio schema_version must be 2' unless schema_version == 2
      raise InvalidCommand, 'plan_id is required' if plan_id.empty?
      raise InvalidCommand, 'risk_decision_id is required' if risk_decision_id.empty?
      raise InvalidCommand, 'risk_unit_id must identify an account scope' unless risk_unit_id.start_with?('account:')
      raise InvalidCommand, 'decision_sequence must be positive' unless decision_sequence.positive?
      raise InvalidCommand, 'action must be LIQUIDATE_PORTFOLIO' unless action == 'LIQUIDATE_PORTFOLIO'
      raise InvalidCommand, 'account_version must be positive' unless account_version.positive?
      raise InvalidCommand, "unsupported margin_mode #{margin_mode.inspect}" unless MARGIN_MODES.include?(margin_mode)
      raise InvalidCommand, 'max_total_authorized_notional must be positive' unless max_total_authorized_notional.positive?
      raise InvalidCommand, 'failure_mode must be STOP_ON_FAILURE' unless failure_mode == 'STOP_ON_FAILURE'
      raise InvalidCommand, 'execution_priority must be between 0 and 1000' unless execution_priority.between?(0, 1000)
      raise InvalidCommand, 'portfolio plan supports between 1 and 32 items' unless items.length.between?(1, 32)
      raise InvalidCommand, 'portfolio expire_at must be after created_at' unless expire_at > created_at

      position_ids = items.map { |item| item.fetch(:position_id).to_s }
      raise InvalidCommand, 'portfolio position_id values must be unique' unless position_ids.uniq.length == position_ids.length
      total = items.reduce(BigDecimal('0')) { |sum, item| sum + item.fetch(:authorized_notional) }
      if total > max_total_authorized_notional
        raise InvalidCommand, 'portfolio item notionals exceed max_total_authorized_notional'
      end
    end

    def normalize_items(raw_items)
      raise InvalidCommand, 'portfolio items must be an array' unless raw_items.is_a?(Array)

      raw_items.each_with_index.map do |item, index|
        raise InvalidCommand, 'portfolio item must be an object' unless item.respond_to?(:key?)

        action = fetch(item, :action).to_s
        raise InvalidCommand, "unsupported portfolio item action #{action.inspect}" unless ITEM_ACTIONS.include?(action)
        authorized_notional = BigDecimal(fetch(item, :authorized_notional).to_s)
        raise InvalidCommand, 'portfolio item authorized_notional must be positive' unless authorized_notional.positive?

        {
          item_sequence: index + 1,
          action: action,
          execution_priority: Integer(fetch(item, :execution_priority, required: false) || execution_priority),
          position_id: fetch(item, :position_id),
          position_version: Integer(fetch(item, :position_version)),
          symbol: fetch(item, :symbol).to_s,
          position_side: fetch(item, :position_side).to_s,
          authorized_notional: authorized_notional,
          instruction: fetch(item, :instruction),
          price_protection: fetch(item, :price_protection, required: false),
          execution_policy: fetch(item, :execution_policy, required: false),
          execution_plan: fetch(item, :execution_plan, required: false),
          risk_snapshot: fetch(item, :risk_snapshot)
        }
      end
    end

    def child_payload(item)
      payload = {
        schema_version: 1,
        risk_decision_id: "#{risk_decision_id}:item:#{item.fetch(:item_sequence)}",
        risk_unit_id: "portfolio:#{plan_id}:item:#{item.fetch(:item_sequence)}",
        decision_sequence: decision_sequence,
        action: item.fetch(:action),
        execution_priority: item.fetch(:execution_priority),
        user_id: user_id,
        account_id: account_id,
        position_id: item.fetch(:position_id),
        position_version: item.fetch(:position_version),
        symbol: item.fetch(:symbol),
        position_side: item.fetch(:position_side),
        instruction: item.fetch(:instruction),
        price_protection: item[:price_protection],
        execution_policy: item[:execution_policy],
        execution_plan: item[:execution_plan],
        risk_snapshot: item.fetch(:risk_snapshot),
        portfolio_plan_id: plan_id,
        plan_item_sequence: item.fetch(:item_sequence),
        execution_scope_id: risk_unit_id,
        authorized_notional: item.fetch(:authorized_notional).to_s('F'),
        expire_at: expire_at.iso8601,
        created_at: created_at.iso8601
      }
      payload.delete_if { |_key, value| value.nil? }
    end

    def fetch(hash, key, required: true)
      return hash[key] if hash.key?(key)
      return hash[key.to_s] if hash.key?(key.to_s)
      return nil unless required

      raise MissingField, "missing #{key} in portfolio liquidation command"
    end

    def timestamp(value)
      value.respond_to?(:utc) ? value.utc : Time.parse(value.to_s).utc
    end
  end
end
