# frozen_string_literal: true

module PerpLiquidation
  class MemoryEventPublisher
    attr_reader :messages

    def initialize
      @messages = []
    end

    def publish(topic:, payload:, event_id:)
      @messages << { topic: topic, payload: payload, event_id: event_id }
    end
  end
end
