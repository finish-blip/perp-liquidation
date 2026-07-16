# frozen_string_literal: true

module PerpLiquidation
  module Consumers
    class RiskCommandConsumer
      def initialize(receiver)
        @receiver = receiver
      end

      def call(message)
        @receiver.call(message)
      end
    end
  end
end
