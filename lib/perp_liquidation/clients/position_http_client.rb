# frozen_string_literal: true

require 'faraday'
require 'json'
require 'uri'

module PerpLiquidation
  class PositionHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def find(position_id:)
      encoded = URI.encode_www_form_component(position_id.to_s)
      response = @connection.get("/api/v1/internal/positions/#{encoded}") do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
      end
      raise RetryableError, "position service returned #{response.status}" if response.status >= 500
      raise PreconditionsFailed, "position #{position_id} not found" if response.status == 404
      raise PreconditionsFailed, "position service returned #{response.status}: #{response.body}" if response.status >= 400

      body = JSON.parse(response.body)
      data = body['data'] || body
      PositionSnapshot.new(
        position_id: data.fetch('position_id'),
        version: data.fetch('version'),
        user_id: data.fetch('user_id'),
        account_id: data.fetch('account_id'),
        symbol: data.fetch('symbol'),
        side: data.fetch('side'),
        size: data.fetch('size')
      )
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "position service unavailable: #{e.message}"
    end

    def find_settlement(order_id:)
      encoded = URI.encode_www_form_component(order_id.to_s)
      response = @connection.get("/api/v1/internal/positions/settlements/by-order-id/#{encoded}") do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
      end
      return nil if response.status == 404
      raise RetryableError, "position service returned #{response.status}" if response.status >= 500
      if response.status >= 400
        raise PreconditionsFailed, "position service returned #{response.status}: #{response.body}"
      end

      body = JSON.parse(response.body)
      data = body['data'] || body
      {
        order_id: data.fetch('order_id'),
        position_id: data.fetch('position_id'),
        settled: data.fetch('settled'),
        position_version: data['position_version'],
        account_version: data['account_version']
      }
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "position service unavailable: #{e.message}"
    end
  end
end
