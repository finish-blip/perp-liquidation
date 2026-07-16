# frozen_string_literal: true

module PerpLiquidation
  class FakeOrderClient
    attr_reader :cancel_requests, :submitted_orders
    attr_accessor :order_status

    def initialize(order_status: 'ACCEPTED')
      @order_status = order_status
      @cancel_requests = []
      @submitted_orders = {}
    end

    def cancel_risk_orders(task_id:, risk_decision_id:, user_id:, symbol:)
      request = { task_id: task_id, risk_decision_id: risk_decision_id, user_id: user_id, symbol: symbol }
      @cancel_requests << request
      OrderResult.new(status: 'CANCELLED', cancelled_order_ids: ["open_#{user_id}_#{symbol}"], payload: request)
    end

    def submit_liquidation_order(attributes)
      client_order_id = attributes.fetch(:client_order_id)
      return @submitted_orders[client_order_id] if @submitted_orders.key?(client_order_id)

      result = OrderResult.new(
        order_id: "ord_#{client_order_id}",
        client_order_id: client_order_id,
        status: order_status,
        filled_quantity: order_status == 'FILLED' ? attributes.fetch(:quantity) : '0',
        payload: attributes
      )
      @submitted_orders[client_order_id] = result
    end

    def find_by_client_order_id(client_order_id:)
      @submitted_orders[client_order_id]
    end

    def cancel_liquidation_order(client_order_id:, task_id:, risk_decision_id:, fencing_token:)
      current = @submitted_orders.fetch(client_order_id) do
        raise NotFound, "liquidation order #{client_order_id} not found"
      end
      return current if current.status == 'FILLED'

      result = OrderResult.new(
        order_id: current.order_id,
        client_order_id: current.client_order_id,
        status: 'CANCELLED',
        filled_quantity: current.filled_quantity,
        average_price: current.average_price,
        fee: current.fee,
        payload: {
          task_id: task_id,
          risk_decision_id: risk_decision_id,
          fencing_token: fencing_token,
          cancelled_client_order_id: client_order_id
        }
      )
      @submitted_orders[client_order_id] = result
    end
  end
end
