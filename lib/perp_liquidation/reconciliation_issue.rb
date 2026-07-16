# frozen_string_literal: true

require 'time'

module PerpLiquidation
  class ReconciliationIssue
    STATUSES = %w[OPEN RESOLVED].freeze

    ATTRIBUTES = %i[
      id task_id issue_type expected_payload actual_payload status created_at resolved_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize(name, value))
      end
      self.status ||= 'OPEN'
      self.created_at ||= Time.now.utc
    end

    def open?
      status == 'OPEN'
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) { |name, result| result[name] = public_send(name) }
    end

    private

    def normalize(name, value)
      return nil if value.nil?
      return Integer(value) if name == :id
      return Time.parse(value).utc if %i[created_at resolved_at].include?(name) && value.is_a?(String)

      value
    end
  end
end
