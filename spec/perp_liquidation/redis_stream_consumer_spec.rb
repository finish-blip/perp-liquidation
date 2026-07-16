# frozen_string_literal: true

require 'json'

RSpec.describe PerpLiquidation::Messaging::RedisStreamConsumer do
  it 'claims stale pending messages left by another consumer before reading new messages' do
    redis = Class.new do
      attr_reader :acked

      def initialize
        @claimed = false
        @acked = []
      end

      def xgroup(*_args, **_options)
        true
      end

      def call(*_args)
        return ['0-0', [], []] if @claimed

        @claimed = true
        payload = JSON.generate(event_id: 'event-1', order_id: 'order-1')
        ['0-0', [['1-0', ['payload', payload]]], []]
      end

      def xreadgroup(*_args)
        []
      end

      def xack(stream, group, id)
        @acked << [stream, group, id]
      end

      def hdel(*_args)
        true
      end
    end.new
    routed = []
    router = Class.new do
      def initialize(routed)
        @routed = routed
      end

      def call(topic, payload)
        @routed << [topic, payload]
      end
    end.new(routed)
    consumer = described_class.new(
      redis: redis,
      router: router,
      topics: ['order.lifecycle'],
      group: 'liquidation',
      consumer: 'worker-2',
      claim_idle_ms: 1000
    )

    expect(consumer.poll(count: 1)).to eq(1)
    expect(routed).to eq([['order.lifecycle', { 'event_id' => 'event-1', 'order_id' => 'order-1' }]])
    expect(redis.acked).to eq([['order.lifecycle', 'liquidation', '1-0']])
  end
end
