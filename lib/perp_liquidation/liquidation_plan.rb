# frozen_string_literal: true

module PerpLiquidation
  class LiquidationPlan
    attr_reader :task_id, :steps

    def initialize(task_id:, steps:)
      @task_id = task_id
      @steps = steps.sort_by(&:step_sequence)
      validate!
    end

    def next_step
      steps.find { |step| !step.settled? }
    end

    def complete?
      steps.all?(&:settled?)
    end

    def total_quantity
      steps.reduce(BigDecimal('0')) { |total, step| total + step.quantity }
    end

    private

    def validate!
      raise InvalidCommand, 'liquidation execution plan requires at least one step' if steps.empty?
      expected = (1..steps.length).to_a
      actual = steps.map(&:step_sequence)
      raise InvalidCommand, 'execution step sequences must be contiguous' unless actual == expected
    end
  end
end
