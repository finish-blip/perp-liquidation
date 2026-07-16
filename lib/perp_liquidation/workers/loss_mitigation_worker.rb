# frozen_string_literal: true

module PerpLiquidation
  module Workers
    class LossMitigationWorker
      def initialize(repository:, orchestrator:, min_age_seconds: 1, clock: -> { Time.now.utc })
        @repository = repository
        @orchestrator = orchestrator
        @min_age_seconds = min_age_seconds
        @clock = clock
      end

      def perform(limit: 100)
        @repository.with_connection do
          tasks = @repository.loss_mitigation_tasks(
            updated_before: @clock.call - @min_age_seconds,
            limit: limit
          )
          tasks.each { |task| process(task) }
        end
      end

      private

      def process(task)
        @orchestrator.process_loss_mitigation(task)
        @repository.resolve_reconciliation_issues!(task.task_id, issue_type: 'LOSS_MITIGATION')
        @repository.mark_reconciliation_checked!(task, issue_type: 'LOSS_MITIGATION', outcome: 'SUCCEEDED')
      rescue RetryableError, ManualReviewRequired, NotFound, InvalidTransition, PreconditionsFailed => e
        @repository.record_reconciliation_issue!(
          task,
          issue_type: 'LOSS_MITIGATION',
          expected_payload: { status: task.status },
          actual_payload: { error_class: e.class.name, message: e.message }
        )
        @repository.mark_reconciliation_checked!(task, issue_type: 'LOSS_MITIGATION', outcome: 'FAILED')
      end
    end
  end
end
