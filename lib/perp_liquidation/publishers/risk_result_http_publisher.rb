# frozen_string_literal: true

require 'faraday'
require 'json'

module PerpLiquidation
  class RiskResultHttpPublisher
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def publish(topic:, payload:, event_id:)
      response = @connection.post('/api/v1/internal/risk/liquidation-results') do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
        request.headers['Content-Type'] = 'application/json'
        request.headers['Idempotency-Key'] = event_id
        request.body = JSON.generate(topic: topic, event_id: event_id, data: payload)
      end
      raise RetryableError, "risk result endpoint returned #{response.status}" if response.status >= 500
      raise PreconditionsFailed, "risk result endpoint returned #{response.status}" if response.status >= 400

      true
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "risk result endpoint unavailable: #{e.message}"
    end
  end
end
