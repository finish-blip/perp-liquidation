# frozen_string_literal: true

require 'spec_helper'
require 'timeout'

RSpec.describe PerpLiquidation::RedisLockClient do
  class FakeRenewableRedis
    attr_reader :renewals

    def initialize
      @values = {}
      @counters = Hash.new(0)
      @renewals = 0
      @mutex = Mutex.new
    end

    def incr(key)
      @mutex.synchronize { @counters[key] += 1 }
    end

    def set(key, value, nx:, px:)
      @mutex.synchronize do
        return false if nx && @values.key?(key)

        @values[key] = value
        true
      end
    end

    def eval(script, keys:, argv:)
      @mutex.synchronize do
        key = keys.first
        return 0 unless @values[key] == argv.first

        if script.include?('pexpire')
          @renewals += 1
          1
        else
          @values.delete(key)
          1
        end
      end
    end
  end

  it 'renews the owned Redis lock and invokes the durable lease callback' do
    redis = FakeRenewableRedis.new
    renewals = 0
    renewal_signals = Queue.new
    client = described_class.new(redis: redis, ttl_seconds: 0.09, renewal_interval_seconds: 0.01)

    result = client.with_lock(
      risk_unit_id: 'position:888',
      owner: 'task-1',
      on_renew: -> { renewals += 1; renewal_signals << true }
    ) do |token|
      2.times { Timeout.timeout(1) { renewal_signals.pop } }
      token
    end

    expect(result).to eq(1)
    expect(redis.renewals).to be >= 2
    expect(renewals).to eq(redis.renewals)
  end
end
