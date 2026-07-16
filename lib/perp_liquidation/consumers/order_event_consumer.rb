# frozen_string_literal: true

module PerpLiquidation
  module Consumers
    class OrderEventConsumer
      def initialize(orchestrator)
        @orchestrator = orchestrator
      end

      def call(message)
        @orchestrator.handle_order_event(message)
      end
    end
  end
end
