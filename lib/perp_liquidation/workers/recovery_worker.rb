# frozen_string_literal: true

module PerpLiquidation
  module Workers
    class RecoveryWorker
      def initialize(repository: nil, orchestrator: nil, position_client: nil, reconciliation_worker: nil)
        @reconciliation_worker = reconciliation_worker || ReconciliationWorker.new(
          repository: repository,
          orchestrator: orchestrator,
          position_client: position_client
        )
      end

      def perform(limit: 100)
        @reconciliation_worker.perform(limit: limit)
      end
    end
  end
end
