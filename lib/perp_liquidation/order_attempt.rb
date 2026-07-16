# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class OrderAttempt
    STATUSES = %w[SUBMITTING ACCEPTED PARTIALLY_FILLED FILLED REJECTED CANCELLED].freeze
    STATUS_RANK = {
      'SUBMITTING' => 0,
      'ACCEPTED' => 1,
      'PARTIALLY_FILLED' => 2,
      'REJECTED' => 3,
      'CANCELLED' => 3,
      'FILLED' => 4
    }.freeze

    ATTRIBUTES = %i[
      task_id step_sequence attempt_sequence client_order_id order_id
      requested_quantity executed_quantity average_price fee status last_event_sequence
      request response created_at updated_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize(name, value))
      end
      self.status ||= 'SUBMITTING'
      self.executed_quantity ||= BigDecimal('0')
      self.last_event_sequence ||= 0
      self.request ||= {}
      self.response ||= {}
      self.created_at ||= Time.now.utc
      self.updated_at ||= created_at
      validate!
    end

    def submission_uncertain?
      status == 'SUBMITTING'
    end

    def retryable_terminal?
      %w[REJECTED CANCELLED].include?(status)
    end

    def update_disposition(status:, executed_quantity:, event_sequence: nil)
      next_sequence = event_sequence.nil? ? nil : Integer(event_sequence)
      raise InvalidCommand, 'order event sequence must be positive' if next_sequence && !next_sequence.positive?
      return :stale if next_sequence && next_sequence <= last_event_sequence

      quantity = BigDecimal(executed_quantity.to_s)
      raise ManualReviewRequired, 'cumulative filled quantity cannot be negative' if quantity.negative?
      if quantity < self.executed_quantity
        raise ManualReviewRequired,
              "cumulative filled quantity regressed from #{self.executed_quantity.to_s('F')} to #{quantity.to_s('F')}"
      end
      if quantity > requested_quantity
        raise ManualReviewRequired,
              "cumulative filled quantity #{quantity.to_s('F')} exceeds requested #{requested_quantity.to_s('F')}"
      end
      if status == 'FILLED' && quantity != requested_quantity
        raise ManualReviewRequired,
              "filled order reported #{quantity.to_s('F')} of requested #{requested_quantity.to_s('F')}"
      end
      if status == 'PARTIALLY_FILLED' && (!quantity.positive? || quantity >= requested_quantity)
        raise ManualReviewRequired, 'partially filled order must be between zero and requested quantity'
      end
      raise InvalidCommand, "unknown order attempt status #{status.inspect}" unless STATUSES.include?(status)

      return :status_regression if STATUS_RANK.fetch(status) < STATUS_RANK.fetch(self.status)
      if retryable_terminal? && status != self.status
        return :status_regression
      end

      :applied
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result|
        value = public_send(name)
        result[name] = value.is_a?(BigDecimal) ? value.to_s('F') : value
      end
    end

    private

    def validate!
      raise InvalidCommand, 'order attempt step_sequence must be positive' unless step_sequence.to_i.positive?
      raise InvalidCommand, 'order attempt sequence must be positive' unless attempt_sequence.to_i.positive?
      raise InvalidCommand, 'order attempt client_order_id is required' if client_order_id.to_s.empty?
      raise InvalidCommand, 'order attempt requested_quantity must be positive' unless requested_quantity&.positive?
      raise InvalidCommand, 'order attempt event sequence cannot be negative' if last_event_sequence.negative?
      raise InvalidCommand, "unknown order attempt status #{status.inspect}" unless STATUSES.include?(status)
    end

    def normalize(name, value)
      return nil if value.nil?
      if %i[requested_quantity executed_quantity average_price fee].include?(name)
        return BigDecimal(value.to_s)
      end
      return Integer(value) if %i[step_sequence attempt_sequence last_event_sequence].include?(name)
      return Time.parse(value).utc if %i[created_at updated_at].include?(name) && value.is_a?(String)

      value
    end
  end
end
