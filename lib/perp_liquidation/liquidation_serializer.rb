# frozen_string_literal: true

module PerpLiquidation
  class LiquidationSerializer
    def self.call(task)
      normalize(task.snapshot)
    end

    def self.event(event)
      {
        task_id: event.task_id,
        event_type: event.event_type,
        external_event_id: event.external_event_id,
        payload: normalize(event.payload),
        created_at: event.created_at.iso8601
      }
    end

    def self.normalize(value)
      case value
      when Hash
        value.each_with_object({}) { |(key, item), result| result[key] = normalize(item) }
      when Array
        value.map { |item| normalize(item) }
      when Time
        value.iso8601
      else
        value.respond_to?(:precs) ? value.to_s('F') : value
      end
    end
  end
end
