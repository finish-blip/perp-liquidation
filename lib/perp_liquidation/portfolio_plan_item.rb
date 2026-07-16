# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class PortfolioPlanItem
    STATUSES = %w[WAITING RUNNING COMPLETED FAILED SKIPPED CANCELLED].freeze

    ATTRIBUTES = %i[
      plan_id item_sequence task_id position_id symbol authorized_notional
      status result created_at updated_at completed_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize(name, value))
      end
      self.status ||= 'WAITING'
      self.result ||= {}
      self.created_at ||= Time.now.utc
      self.updated_at ||= created_at
      validate!
    end

    def terminal?
      %w[COMPLETED FAILED SKIPPED CANCELLED].include?(status)
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result_hash|
        value = public_send(name)
        result_hash[name] = value.is_a?(BigDecimal) ? value.to_s('F') : value
      end
    end

    private

    def validate!
      raise InvalidCommand, 'portfolio item sequence must be positive' unless item_sequence.to_i.positive?
      raise InvalidCommand, 'portfolio item task_id is required' if task_id.to_s.empty?
      raise InvalidCommand, 'portfolio item authorized_notional must be positive' unless authorized_notional&.positive?
      raise InvalidCommand, "unknown portfolio item status #{status.inspect}" unless STATUSES.include?(status)
    end

    def normalize(name, value)
      return nil if value.nil?
      return BigDecimal(value.to_s) if name == :authorized_notional
      return Integer(value) if name == :item_sequence
      if %i[created_at updated_at completed_at].include?(name) && value.is_a?(String)
        return Time.parse(value).utc
      end

      value
    end
  end
end
