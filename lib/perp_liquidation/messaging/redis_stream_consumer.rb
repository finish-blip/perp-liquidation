# frozen_string_literal: true

require 'json'

module PerpLiquidation
  module Messaging
    class RedisStreamConsumer
      def initialize(redis:, router:, topics:, group:, consumer:, max_delivery_attempts: 5,
                     block_ms: 1000, claim_idle_ms: 30_000)
        @redis = redis
        @router = router
        @topics = topics
        @group = group
        @consumer = consumer
        @max_delivery_attempts = max_delivery_attempts
        @block_ms = block_ms
        @claim_idle_ms = Integer(claim_idle_ms)
        raise InvalidCommand, 'stream claim idle time must be positive' unless @claim_idle_ms.positive?
        ensure_groups!
      end

      def poll(count: 20)
        messages = reclaim_stale(count)
        messages = read('0', count: count, block_ms: 1) if messages.empty?
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

      def reclaim_stale(count)
        @topics.each_with_object([]) do |topic, messages|
          break messages if messages.length >= count

          response = @redis.call(
            'XAUTOCLAIM', topic, @group, @consumer, @claim_idle_ms, '0-0',
            'COUNT', count - messages.length
          )
          Array(response && response[1]).each do |id, fields|
            messages << [topic, id, normalize_fields(fields)]
          end
        end
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

      def normalize_fields(fields)
        return fields if fields.is_a?(Hash)

        Array(fields).each_slice(2).to_h
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
