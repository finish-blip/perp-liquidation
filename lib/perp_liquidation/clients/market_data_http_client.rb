# frozen_string_literal: true

require 'faraday'
require 'json'
require 'uri'

module PerpLiquidation
  class MarketDataHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def find(symbol:)
      encoded = URI.encode_www_form_component(symbol.to_s)
      response = @connection.get("/api/v1/internal/market/quotes/#{encoded}") do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
      end
      raise RetryableError, "market data service returned #{response.status}" if response.status >= 500
      raise RetryableError, "market quote for #{symbol} is unavailable" if response.status == 404
      if response.status >= 400
        raise PreconditionsFailed, "market data service returned #{response.status}: #{response.body}"
      end

      body = JSON.parse(response.body)
      data = body['data'] || body
      MarketQuote.new(
        symbol: data.fetch('symbol'),
        best_bid: data.fetch('best_bid'),
        best_ask: data.fetch('best_ask'),
        observed_at: data.fetch('observed_at'),
        sequence: data['sequence'],
        bids: data['bids'],
        asks: data['asks'],
        quantity_increment: data['quantity_increment']
      )
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "market data service unavailable: #{e.message}"
    end
  end
end
