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
        Liquidation::RESULT_PUBLISHING => 15
      }.freeze

      def initialize(repository:, age_seconds: DEFAULT_AGE_SECONDS, clock: -> { Time.now.utc })
        @repository = repository
        @age_seconds = age_seconds
        @clock = clock
      end

      def call(limit: 100)
        tasks = @age_seconds.flat_map do |status, age|
          cutoff = order_status?(status) ? @clock.call : @clock.call - age
          candidates = @repository.stuck_tasks(
            statuses: [status],
            updated_before: cutoff,
            limit: limit
          )
          candidates.select do |task|
            task.updated_at <= @clock.call - effective_age(task, status, age)
          end
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
