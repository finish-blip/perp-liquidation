# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class PortfolioLiquidationPlan
    STATUSES = %w[RECEIVED EXECUTING COMPLETED FAILED CANCELLED MANUAL_REVIEW].freeze
    TERMINAL_STATUSES = %w[COMPLETED FAILED CANCELLED MANUAL_REVIEW].freeze

    ATTRIBUTES = %i[
      plan_id risk_decision_id risk_unit_id decision_sequence action user_id account_id
      account_version current_account_version margin_mode execution_priority max_total_authorized_notional
      failure_mode status current_item_sequence item_count completed_item_count
      error_code error_message expire_at created_at updated_at completed_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize(name, value))
      end
      self.action ||= 'LIQUIDATE_PORTFOLIO'
      self.status ||= 'RECEIVED'
      self.execution_priority ||= 10
      self.failure_mode ||= 'STOP_ON_FAILURE'
      self.current_account_version ||= account_version
      self.completed_item_count ||= 0
      self.created_at ||= Time.now.utc
      self.updated_at ||= created_at
      validate!
    end

    def terminal?
      TERMINAL_STATUSES.include?(status)
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result|
        value = public_send(name)
        result[name] = value.is_a?(BigDecimal) ? value.to_s('F') : value
      end
    end

    private

    def validate!
      raise InvalidCommand, 'portfolio plan_id is required' if plan_id.to_s.empty?
      raise InvalidCommand, 'portfolio risk_decision_id is required' if risk_decision_id.to_s.empty?
      raise InvalidCommand, 'portfolio risk_unit_id is required' if risk_unit_id.to_s.empty?
      raise InvalidCommand, 'portfolio item_count must be positive' unless item_count.to_i.positive?
      raise InvalidCommand, "unknown portfolio plan status #{status.inspect}" unless STATUSES.include?(status)
    end

    def normalize(name, value)
      return nil if value.nil?
      return BigDecimal(value.to_s) if name == :max_total_authorized_notional
      return Integer(value) if %i[decision_sequence account_version current_account_version execution_priority current_item_sequence item_count completed_item_count].include?(name)
      if %i[expire_at created_at updated_at completed_at].include?(name) && value.is_a?(String)
        return Time.parse(value).utc
      end

      value
    end
  end
end
