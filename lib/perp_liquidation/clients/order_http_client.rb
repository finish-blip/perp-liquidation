# frozen_string_literal: true

require 'faraday'
require 'json'
require 'uri'

module PerpLiquidation
  class OrderHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def cancel_risk_orders(task_id:, risk_decision_id:, user_id:, symbol:)
      payload = { task_id: task_id, risk_decision_id: risk_decision_id, user_id: user_id, symbol: symbol }
      response = request(:post, '/api/v1/internal/orders/cancel-risk', payload)
      build_result(response)
    end

    def submit_liquidation_order(attributes)
      response = request(:post, '/api/v1/internal/orders/liquidation', attributes)
      build_result(response)
    end

    def find_by_client_order_id(client_order_id:)
      encoded = URI.encode_www_form_component(client_order_id)
      response = request(:get, "/api/v1/internal/orders/by-client-order-id/#{encoded}")
      build_result(response)
    rescue PreconditionsFailed => e
      return nil if e.message.include?('404')

      raise
    end

    def cancel_liquidation_order(client_order_id:, task_id:, risk_decision_id:, fencing_token:)
      encoded = URI.encode_www_form_component(client_order_id)
      response = request(
        :post,
        "/api/v1/internal/orders/liquidation/#{encoded}/cancel",
        task_id: task_id,
        risk_decision_id: risk_decision_id,
        fencing_token: fencing_token
      )
      build_result(response)
    end

    private

    def request(method, path, payload = nil)
      response = @connection.public_send(method) do |request|
        request.url(path)
        request.headers['Authorization'] = "Bearer #{@token}" if @token
        request.headers['Content-Type'] = 'application/json'
        request.body = JSON.generate(LiquidationSerializer.normalize(payload)) if payload
      end
      raise RetryableError, "order service returned #{response.status}" if response.status >= 500
      raise PreconditionsFailed, "order service returned #{response.status}: #{response.body}" if response.status >= 400

      response
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "order service unavailable: #{e.message}"
    end

    def build_result(response)
      body = JSON.parse(response.body)
      data = body['data'] || body
      OrderResult.new(
        order_id: data['order_id'],
        client_order_id: data['client_order_id'],
        status: data.fetch('status'),
        cancelled_order_ids: data['cancelled_order_ids'] || [],
        filled_quantity: data['filled_quantity'] || '0',
        average_price: data['average_price'],
        fee: data['fee'],
        payload: data
      )
    end
  end
end
