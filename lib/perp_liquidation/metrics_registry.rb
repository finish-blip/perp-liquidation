# frozen_string_literal: true

require 'monitor'

module PerpLiquidation
  class MetricsRegistry
    def initialize
      @monitor = Monitor.new
      @counters = Hash.new(0)
      @gauges = {}
      @observations = Hash.new { |hash, key| hash[key] = { count: 0, sum: 0.0 } }
    end

    def increment(name, value: 1, labels: {})
      @monitor.synchronize { @counters[key(name, labels)] += value }
    end

    def set(name, value, labels: {})
      @monitor.synchronize { @gauges[key(name, labels)] = value.to_f }
    end

    def observe(name, value, labels: {})
      @monitor.synchronize do
        observation = @observations[key(name, labels)]
        observation[:count] += 1
        observation[:sum] += value.to_f
      end
    end

    def render
      @monitor.synchronize do
        lines = []
        @counters.sort.each { |metric, value| lines << "#{format_key(metric)} #{value}" }
        @gauges.sort.each { |metric, value| lines << "#{format_key(metric)} #{value}" }
        @observations.sort.each do |metric, observation|
          name, labels = metric
          lines << "#{format_key(["#{name}_count", labels])} #{observation[:count]}"
          lines << "#{format_key(["#{name}_sum", labels])} #{observation[:sum]}"
        end
        "#{lines.join("\n")}\n"
      end
    end

    private

    def key(name, labels)
      [name.to_s, labels.map { |label, value| [label.to_s, value.to_s] }.sort]
    end

    def format_key(metric)
      name, labels = metric
      return name if labels.empty?

      encoded = labels.map { |label, value| %(#{label}="#{escape(value)}") }.join(',')
      "#{name}{#{encoded}}"
    end

    def escape(value)
      value.gsub('\\', '\\\\').gsub('"', '\\"').gsub("\n", '\\n')
    end
  end
end
