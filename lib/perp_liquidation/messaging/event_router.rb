# frozen_string_literal: true

module PerpLiquidation
  module Messaging
    class EventRouter
      TOPICS = [
        'risk.liquidation.command',
        'risk.liquidation.portfolio.command',
        'order.lifecycle',
        'position.settlement.confirmed',
        'adl.settlement.confirmed',
        'liquidation.reconcile.requested'
      ].freeze

      def initialize(command_receiver:, orchestrator:, reconciliation_worker:, portfolio_plan_receiver: nil,
                     operator_action_service: nil)
        @command_receiver = command_receiver
        @portfolio_plan_receiver = portfolio_plan_receiver
        @orchestrator = orchestrator
        @reconciliation_worker = reconciliation_worker
        @operator_action_service = operator_action_service
      end

      def call(topic, payload)
        repository.with_connection do
          case topic
          when 'risk.liquidation.command' then @command_receiver.call(payload)
          when 'risk.liquidation.portfolio.command'
            raise InvalidCommand, 'portfolio plan receiver is not configured' unless @portfolio_plan_receiver

            @portfolio_plan_receiver.call(payload)
          when 'order.lifecycle' then @orchestrator.handle_order_event(payload)
          when 'position.settlement.confirmed' then @orchestrator.handle_settlement_event(payload)
          when 'adl.settlement.confirmed' then @orchestrator.handle_adl_settlement(payload)
          when 'liquidation.reconcile.requested'
            raise InvalidCommand, 'operator action service is not configured' unless @operator_action_service
            unless (value(payload, :schema_version) || 0).to_i == 2
              raise InvalidCommand, 'liquidation.reconcile.requested requires schema_version 2 approval evidence'
            end

            @operator_action_service.call(payload)
          else
            raise InvalidCommand, "unsupported event topic #{topic.inspect}"
          end
        end
      end

      attr_writer :repository

      private

      def repository
        @repository || raise(InvalidCommand, 'event router repository is not configured')
      end

      def value(hash, key)
        hash.key?(key) ? hash[key] : hash[key.to_s]
      end
    end
  end
end
