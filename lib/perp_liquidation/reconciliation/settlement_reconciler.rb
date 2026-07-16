# frozen_string_literal: true

module PerpLiquidation
  module Reconciliation
    class SettlementReconciler
      def initialize(repository:, orchestrator:, position_client:)
        @repository = repository
        @orchestrator = orchestrator
        @position_client = position_client
      end

      def call(task)
        step = @repository.next_execution_step(task.task_id)
        raise ManualReviewRequired, 'no unsettled execution step found' unless step

        attempt = @repository.current_order_attempt(task.task_id, step.step_sequence)
        raise ManualReviewRequired, 'no order attempt found for settlement reconciliation' unless attempt&.order_id

        settlement = @position_client.find_settlement(order_id: attempt.order_id)
        unless settlement && value(settlement, :settled)
          raise RetryableError, "settlement for order #{attempt.order_id} is not confirmed"
        end
        unless value(settlement, :order_id).to_s == attempt.order_id.to_s
          raise ManualReviewRequired, 'settlement lookup returned a different order_id'
        end
        unless value(settlement, :position_id).to_s == task.position_id.to_s
          raise ManualReviewRequired, 'settlement lookup returned a different position_id'
        end

        @orchestrator.reconcile_settlement(
          task,
          order_id: attempt.order_id,
          position_version: value(settlement, :position_version),
          account_version: value(settlement, :account_version)
        )
      end

      private

      def value(hash, key)
        hash.key?(key) ? hash[key] : hash[key.to_s]
      end
    end
  end
end
