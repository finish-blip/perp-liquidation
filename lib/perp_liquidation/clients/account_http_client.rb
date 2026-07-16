# frozen_string_literal: true

require 'faraday'
require 'json'
require 'uri'

module PerpLiquidation
  class AccountHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def find(account_id:)
      encoded = URI.encode_www_form_component(account_id.to_s)
      response = @connection.get("/api/v1/internal/accounts/#{encoded}/liquidation-state") do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
      end
      raise RetryableError, "account service returned #{response.status}" if response.status >= 500
      raise PreconditionsFailed, "account #{account_id} not found" if response.status == 404
      raise PreconditionsFailed, "account service returned #{response.status}: #{response.body}" if response.status >= 400

      body = JSON.parse(response.body)
      data = body['data'] || body
      AccountSnapshot.new(
        account_id: data.fetch('account_id'),
        user_id: data.fetch('user_id'),
        version: data.fetch('version'),
        margin_mode: data.fetch('margin_mode'),
        settlement_currency: data.fetch('settlement_currency')
      )
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "account service unavailable: #{e.message}"
    end
  end
end
