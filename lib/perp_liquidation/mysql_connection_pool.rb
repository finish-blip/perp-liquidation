# frozen_string_literal: true

require 'monitor'

module PerpLiquidation
  class MysqlConnectionPool
    class CheckoutTimeout < StandardError; end

    def initialize(size:, checkout_timeout:, &connection_factory)
      raise ArgumentError, 'connection factory is required' unless connection_factory

      @size = Integer(size)
      @checkout_timeout = Float(checkout_timeout)
      raise ArgumentError, 'pool size must be positive' unless @size.positive?
      raise ArgumentError, 'checkout timeout must be positive' unless @checkout_timeout.positive?

      @monitor = Monitor.new
      @connection_available = @monitor.new_cond
      @available = []
      @thread_key = :"perp_liquidation_mysql_pool_#{object_id}"
      @size.times { @available << connection_factory.call }
    rescue StandardError
      @available&.each { |connection| connection.close if connection.respond_to?(:close) }
      raise
    end

    def with_connection
      context = Thread.current[@thread_key]
      if context
        context[:depth] += 1
        begin
          return yield(context[:connection])
        ensure
          context[:depth] -= 1
        end
      end

      connection = checkout
      Thread.current[@thread_key] = { connection: connection, depth: 1 }
      begin
        yield connection
      ensure
        Thread.current[@thread_key] = nil
        checkin(connection)
      end
    end

    def current_connection
      context = Thread.current[@thread_key]
      context && context[:connection]
    end

    def close
      connections = @monitor.synchronize do
        raise ThreadError, 'cannot close pool while connections are checked out' unless @available.length == @size

        @available.shift(@available.length)
      end
      connections.each { |connection| connection.close if connection.respond_to?(:close) }
    end

    private

    def checkout
      deadline = monotonic_time + @checkout_timeout
      @monitor.synchronize do
        loop do
          connection = @available.shift
          return connection if connection

          remaining = deadline - monotonic_time
          raise CheckoutTimeout, "database connection checkout timed out after #{@checkout_timeout} seconds" unless remaining.positive?

          @connection_available.wait(remaining)
        end
      end
    end

    def checkin(connection)
      @monitor.synchronize do
        @available << connection
        @connection_available.signal
      end
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end

  class SingleMysqlConnectionPool
    def initialize(connection)
      @connection = connection
      @monitor = Monitor.new
      @thread_key = :"perp_liquidation_single_mysql_pool_#{object_id}"
    end

    def with_connection
      context = Thread.current[@thread_key]
      return yield(context) if context

      @monitor.synchronize do
        Thread.current[@thread_key] = @connection
        begin
          yield @connection
        ensure
          Thread.current[@thread_key] = nil
        end
      end
    end

    def current_connection
      Thread.current[@thread_key]
    end

    def close
      @connection.close if @connection.respond_to?(:close)
    end
  end
end
