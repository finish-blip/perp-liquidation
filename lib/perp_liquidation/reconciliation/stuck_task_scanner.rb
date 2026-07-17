# frozen_string_literal: true

module PerpLiquidation
  module Reconciliation
    class StuckTaskScanner
      DEFAULT_AGE_SECONDS = {
        Liquidation::ORDER_SUBMITTING => 15,
        Liquidation::ORDER_ACCEPTED => 30,
        Liquidation::PARTIALLY_FILLED => 30,
        Liquidation::FILLED => 15,
        Liquidation::SETTLEMENT_PENDING => 30,
        Liquidation::SETTLED => 15,
        Liquidation::RESULT_PUBLISHING => 15
      }.freeze

      def initialize(repository:, age_seconds: DEFAULT_AGE_SECONDS, clock: -> { Time.now.utc })
        @repository = repository
        @age_seconds = age_seconds
        @clock = clock
      end

      def call(limit: 100)
        now = @clock.call
        cutoffs = @age_seconds.each_with_object({}) do |(status, age), result|
          result[status] = order_status?(status) ? now : now - age
        end
        candidates = @repository.stuck_tasks_by_status(
          status_cutoffs: cutoffs,
          per_status_limit: limit
        )
        tasks = candidates.select do |task|
          age = @age_seconds.fetch(task.status)
          task.updated_at <= now - effective_age(task, task.status, age)
        end
        tasks.uniq { |task| task.task_id }
             .sort_by(&:updated_at)
             .first(limit)
      end

      private

      def order_status?(status)
        [Liquidation::ORDER_SUBMITTING, Liquidation::ORDER_ACCEPTED, Liquidation::PARTIALLY_FILLED].include?(status)
      end

      def effective_age(task, status, default_age)
        return default_age unless order_status?(status)
        return default_age unless task.execution_strategy == 'ADAPTIVE' && task.child_order_timeout_ms

        task.child_order_timeout_ms / 1000.0
      end
    end
  end
end
