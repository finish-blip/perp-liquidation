# frozen_string_literal: true

module PerpLiquidation
  module Workers
    class ReconciliationWorker
      ORDER_STATES = [
        Liquidation::ORDER_SUBMITTING,
        Liquidation::ORDER_ACCEPTED,
        Liquidation::PARTIALLY_FILLED
      ].freeze
      SETTLEMENT_STATES = [Liquidation::FILLED, Liquidation::SETTLEMENT_PENDING].freeze
      RECOVERABLE_STATES = (ORDER_STATES + SETTLEMENT_STATES + [Liquidation::RESULT_PUBLISHING]).freeze

      def initialize(repository:, orchestrator:, position_client:, scanner: nil)
        @repository = repository
        @scanner = scanner || Reconciliation::StuckTaskScanner.new(repository: repository)
        @order_reconciler = Reconciliation::OrderReconciler.new(orchestrator: orchestrator)
        @settlement_reconciler = Reconciliation::SettlementReconciler.new(
          repository: repository, orchestrator: orchestrator, position_client: position_client
        )
        @outbox_reconciler = Reconciliation::OutboxReconciler.new(repository: repository)
        @metrics = nil
      end


      attr_writer :metrics

      def perform(limit: 100)
        @repository.with_connection do
          @scanner.call(limit: limit).each { |task| reconcile(task) }
        end
      end

      def reconcile(task)
        issue_type = nil
        @repository.with_connection do
          issue_type, reconciler = route(task)
          result = reconciler.call(task)
          @repository.resolve_reconciliation_issues!(task.task_id, issue_type: issue_type)
          @repository.mark_reconciliation_checked!(task, issue_type: issue_type, outcome: 'SUCCEEDED')
          result
        end
      rescue RetryableError, ManualReviewRequired, NotFound, InvalidTransition => e
        @repository.with_connection do
          @repository.record_reconciliation_issue!(
            task,
            issue_type: issue_type || 'UNSUPPORTED_RECONCILIATION',
            expected_payload: { status: task.status },
            actual_payload: { error_class: e.class.name, message: e.message }
          )
          @metrics&.increment('liquidation_reconciliation_issue_total', labels: { type: issue_type || 'UNKNOWN' })
          @repository.mark_reconciliation_checked!(
            task, issue_type: issue_type || 'UNSUPPORTED_RECONCILIATION', outcome: 'FAILED'
          )
          task
        end
      end

      private

      def route(task)
        if ORDER_STATES.include?(task.status)
          ['ORDER_RECONCILIATION', @order_reconciler]
        elsif SETTLEMENT_STATES.include?(task.status)
          ['SETTLEMENT_RECONCILIATION', @settlement_reconciler]
        elsif task.status == Liquidation::RESULT_PUBLISHING
          ['OUTBOX_RECONCILIATION', @outbox_reconciler]
        else
          raise InvalidTransition, "task #{task.task_id} in #{task.status} is not reconcilable"
        end
      end
    end
  end
end
