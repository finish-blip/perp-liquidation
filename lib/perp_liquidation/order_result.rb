# frozen_string_literal: true

require 'bigdecimal'

module PerpLiquidation
  class OrderResult
    attr_reader :order_id, :client_order_id, :status, :cancelled_order_ids,
                :filled_quantity, :average_price, :fee, :event_sequence, :payload

    def initialize(order_id: nil, client_order_id: nil, status:, cancelled_order_ids: [],
                   filled_quantity: '0', average_price: nil, fee: nil, event_sequence: nil, payload: {})
      @order_id = order_id
      @client_order_id = client_order_id
      @status = status
      @cancelled_order_ids = cancelled_order_ids
      @filled_quantity = BigDecimal(filled_quantity.to_s)
      @average_price = average_price.nil? ? nil : BigDecimal(average_price.to_s)
      @fee = fee.nil? ? nil : BigDecimal(fee.to_s)
      @event_sequence = event_sequence.nil? ? nil : Integer(event_sequence)
      @payload = payload
    end

    def snapshot
      {
        order_id: order_id,
        client_order_id: client_order_id,
        status: status,
        cancelled_order_ids: cancelled_order_ids,
        filled_quantity: filled_quantity.to_s('F'),
        average_price: average_price&.to_s('F'),
        fee: fee&.to_s('F'),
        order_event_sequence: event_sequence,
        payload: payload
      }
    end
  end
end
