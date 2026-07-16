# frozen_string_literal: true

module PerpLiquidation
  module Reconciliation
    class OutboxReconciler
      def initialize(repository:)
        @repository = repository
      end

      def call(task)
        event = @repository.outbox_for_task(task.task_id)
        raise ManualReviewRequired, "task #{task.task_id} has no outbox result" unless event

        if task.status == Liquidation::RESULT_PUBLISHING
          @repository.transition!(task, Liquidation::COMPLETED, 'RESULT_PUBLISHING_RECONCILED')
        end
        event
      end
    end
  end
end
