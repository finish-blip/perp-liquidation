# frozen_string_literal: true

module PerpLiquidation
  module Consumers
    class SettlementEventConsumer
      def initialize(orchestrator)
        @orchestrator = orchestrator
      end

      def call(message)
        @orchestrator.handle_settlement_event(message)
      end
    end
  end
end
