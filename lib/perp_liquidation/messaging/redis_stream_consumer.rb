# frozen_string_literal: true

require 'json'

module PerpLiquidation
  module Messaging
    class RedisStreamConsumer
      def initialize(redis:, router:, topics:, group:, consumer:, max_delivery_attempts: 5, block_ms: 1000)
        @redis = redis
        @router = router
        @topics = topics
        @group = group
        @consumer = consumer
        @max_delivery_attempts = max_delivery_attempts
        @block_ms = block_ms
        ensure_groups!
      end

      def poll(count: 20)
        messages = read('0', count: count, block_ms: 1)
        messages = read('>', count: count, block_ms: @block_ms) if messages.empty?
        messages.each { |stream, id, fields| process(stream, id, fields) }
        messages.length
      end

      private

      def ensure_groups!
        @topics.each do |topic|
          @redis.xgroup(:create, topic, @group, '$', mkstream: true)
        rescue Redis::CommandError => e
          raise unless e.message.include?('BUSYGROUP')
        end
      end

      def read(id, count:, block_ms:)
        response = @redis.xreadgroup(
          @group,
          @consumer,
          @topics,
          Array.new(@topics.length, id),
          { count: count, block: block_ms }
        )
        normalize(response)
      end

      def normalize(response)
        Array(response).flat_map do |stream_entry|
          stream, entries = stream_entry
          Array(entries).map do |entry|
            id, fields = entry
            [stream, id, fields]
          end
        end
      end

      def process(stream, id, fields)
        payload = JSON.parse(fields.fetch('payload'))
        @router.call(stream, payload)
        @redis.xack(stream, @group, id)
        @redis.hdel(attempt_key(stream), id)
      rescue StandardError => e
        attempts = @redis.hincrby(attempt_key(stream), id, 1)
        return if attempts < @max_delivery_attempts

        @redis.xadd(
          "#{stream}.dead",
          {
            'source_stream' => stream,
            'source_id' => id,
            'error' => e.message.to_s[0, 1024],
            'payload' => fields['payload'].to_s
          },
          id: '*'
        )
        @redis.xack(stream, @group, id)
        @redis.hdel(attempt_key(stream), id)
      end

      def attempt_key(stream)
        "#{stream}:#{@group}:delivery_attempts"
      end
    end
  end
end
