# frozen_string_literal: true

module PerpLiquidation
  class RedisLockClient
    RELEASE_SCRIPT = <<~LUA.freeze
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      end
      return 0
    LUA

    RENEW_SCRIPT = <<~LUA.freeze
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('pexpire', KEYS[1], ARGV[2])
      end
      return 0
    LUA

    def initialize(redis:, ttl_seconds: 30, renewal_interval_seconds: nil)
      @redis = redis
      ttl = Float(ttl_seconds)
      @renewal_interval_seconds = Float(renewal_interval_seconds || ttl / 3.0)
      raise ArgumentError, 'lock TTL must be positive' unless ttl.positive?
      unless @renewal_interval_seconds.positive? && @renewal_interval_seconds < ttl
        raise ArgumentError, 'lock renewal interval must be positive and shorter than TTL'
      end

      @ttl_milliseconds = Integer(ttl * 1000)
    end

    def with_lock(risk_unit_id:, owner:, on_renew: nil)
      lock_key = "liq:risk-unit:#{risk_unit_id}"
      token = @redis.incr("#{lock_key}:fencing-token")
      lock_value = "#{owner}:#{token}"
      acquired = @redis.set(lock_key, lock_value, nx: true, px: @ttl_milliseconds)
      raise PositionLocked, "risk unit #{risk_unit_id} is already locked" unless acquired

      renewal_mutex = Mutex.new
      renewal_condition = ConditionVariable.new
      renewal_stopped = false
      renewal_error = nil
      renewal_thread = Thread.new do
        loop do
          stopped = renewal_mutex.synchronize do
            renewal_condition.wait(renewal_mutex, @renewal_interval_seconds)
            renewal_stopped
          end
          break if stopped

          renewed = @redis.eval(
            RENEW_SCRIPT,
            keys: [lock_key],
            argv: [lock_value, @ttl_milliseconds]
          )
          raise PositionLocked, "risk unit #{risk_unit_id} lock was lost" unless renewed.to_i == 1

          on_renew&.call
        end
      rescue StandardError => e
        renewal_mutex.synchronize { renewal_error = e }
      end

      result = yield token
    ensure
      if renewal_thread
        renewal_mutex.synchronize do
          renewal_stopped = true
          renewal_condition.broadcast
        end
        renewal_thread.join
      end
      @redis.eval(RELEASE_SCRIPT, keys: [lock_key], argv: [lock_value]) if acquired
      raise renewal_error if renewal_error && !$!
    end
  end
end
