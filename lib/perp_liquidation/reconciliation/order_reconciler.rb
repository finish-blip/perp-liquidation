# frozen_string_literal: true

module PerpLiquidation
  module Reconciliation
    class OrderReconciler
      def initialize(orchestrator:)
        @orchestrator = orchestrator
      end

      def call(task)
        @orchestrator.reconcile_order(task)
      end
    end
  end
end
