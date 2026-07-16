# frozen_string_literal: true

require 'json'

module PerpLiquidation
  module Messaging
    class RedisStreamPublisher
      def initialize(redis:)
        @redis = redis
      end

      def publish(topic:, payload:, event_id:)
        @redis.xadd(
          topic,
          { 'event_id' => event_id.to_s, 'payload' => JSON.generate(LiquidationSerializer.normalize(payload)) },
          id: '*'
        )
      end
    end
  end
end
