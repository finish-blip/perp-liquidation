# frozen_string_literal: true

require 'json'

module PerpLiquidation
  class RedisMetricsRegistry
    def initialize(redis:, prefix: 'perp_liquidation:metrics')
      @redis = redis
      @prefix = prefix
    end

    def increment(name, value: 1, labels: {})
      @redis.hincrby(key('counters'), field(name, labels), value)
    end

    def set(name, value, labels: {})
      @redis.hset(key('gauges'), field(name, labels), value.to_f)
    end

    def observe(name, value, labels: {})
      metric = field(name, labels)
      @redis.pipelined do
        @redis.hincrby(key('observation_counts'), metric, 1)
        @redis.hincrbyfloat(key('observation_sums'), metric, value.to_f)
      end
    end

    def render
      counters = @redis.hgetall(key('counters'))
      gauges = @redis.hgetall(key('gauges'))
      counts = @redis.hgetall(key('observation_counts'))
      sums = @redis.hgetall(key('observation_sums'))
      lines = []
      counters.sort.each { |metric, value| lines << "#{format_field(metric)} #{value}" }
      gauges.sort.each { |metric, value| lines << "#{format_field(metric)} #{value}" }
      counts.sort.each do |metric, value|
        name, labels = parse_field(metric)
        lines << "#{format_metric("#{name}_count", labels)} #{value}"
        lines << "#{format_metric("#{name}_sum", labels)} #{sums.fetch(metric, '0')}"
      end
      "#{lines.join("\n")}\n"
    end

    private

    def key(suffix)
      "#{@prefix}:#{suffix}"
    end

    def field(name, labels)
      JSON.generate([name.to_s, labels.map { |label, value| [label.to_s, value.to_s] }.sort])
    end

    def parse_field(metric)
      JSON.parse(metric)
    end

    def format_field(metric)
      name, labels = parse_field(metric)
      format_metric(name, labels)
    end

    def format_metric(name, labels)
      return name if labels.empty?

      encoded = labels.map { |label, value| %(#{label}="#{escape(value)}") }.join(',')
      "#{name}{#{encoded}}"
    end

    def escape(value)
      value.gsub('\\', '\\\\').gsub('"', '\\"').gsub("\n", '\\n')
    end
  end
end
