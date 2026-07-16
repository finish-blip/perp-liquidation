# frozen_string_literal: true

module PerpLiquidation
  module Reconciliation
    class CompletionReconciler
      def initialize(orchestrator:)
        @orchestrator = orchestrator
      end

      def call(task)
        @orchestrator.recover_settled_completion(task)
      end
    end
  end
end
