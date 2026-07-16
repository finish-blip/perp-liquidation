# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class ExecutionStep
    STATUSES = %w[PLANNED SUBMITTING WORKING FILLED PARTIAL_SETTLEMENT_PENDING SETTLED SKIPPED].freeze

    ATTRIBUTES = %i[
      task_id step_sequence quantity order_type time_in_force max_slippage
      status executed_quantity created_at updated_at completed_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize(name, value))
      end
      self.status ||= 'PLANNED'
      self.executed_quantity ||= BigDecimal('0')
      self.created_at ||= Time.now.utc
      self.updated_at ||= created_at
      validate!
    end

    def remaining_quantity
      remaining = quantity - executed_quantity
      remaining.positive? ? remaining : BigDecimal('0')
    end

    def settled?
      status == 'SETTLED'
    end

    def terminal?
      %w[SETTLED SKIPPED].include?(status)
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result|
        value = public_send(name)
        result[name] = value.is_a?(BigDecimal) ? value.to_s('F') : value
      end
    end

    private

    def validate!
      raise InvalidCommand, 'execution step sequence must be positive' unless step_sequence.to_i.positive?
      raise InvalidCommand, 'execution step quantity must be positive' unless quantity&.positive?
      raise InvalidCommand, 'execution step order_type is required' if order_type.to_s.empty?
      raise InvalidCommand, "unknown execution step status #{status.inspect}" unless STATUSES.include?(status)
    end

    def normalize(name, value)
      return nil if value.nil?
      return BigDecimal(value.to_s) if %i[quantity max_slippage executed_quantity].include?(name)
      return Integer(value) if name == :step_sequence
      return Time.parse(value).utc if %i[created_at updated_at completed_at].include?(name) && value.is_a?(String)

      value
    end
  end
end
