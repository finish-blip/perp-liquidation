# frozen_string_literal: true

require 'faraday'
require 'json'
require 'uri'

module PerpLiquidation
  class LossMitigationHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5)
      @token = token
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def check_bankruptcy(attributes)
      request(:post, '/api/v1/internal/bankruptcy/checks', attributes)
    end

    def claim_insurance(attributes)
      request(:post, '/api/v1/internal/insurance/claims', attributes)
    end

    def request_adl(attributes)
      request(:post, '/api/v1/internal/adl/requests', attributes)
    end

    def find_adl_request(adl_request_id:)
      encoded = URI.encode_www_form_component(adl_request_id.to_s)
      request(:get, "/api/v1/internal/adl/requests/#{encoded}")
    rescue NotFound
      nil
    end

    private

    def request(method, path, payload = nil)
      response = @connection.public_send(method) do |request|
        request.url(path)
        request.headers['Authorization'] = "Bearer #{@token}" if @token
        request.headers['Content-Type'] = 'application/json'
        request.body = JSON.generate(LiquidationSerializer.normalize(payload)) if payload
      end
      raise NotFound, "loss mitigation resource not found: #{path}" if response.status == 404
      raise RetryableError, "loss mitigation service returned #{response.status}" if response.status >= 500
      if response.status >= 400
        raise PreconditionsFailed, "loss mitigation service returned #{response.status}: #{response.body}"
      end

      body = JSON.parse(response.body)
      symbolize(body['data'] || body)
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "loss mitigation service unavailable: #{e.message}"
    end

    def symbolize(hash)
      hash.each_with_object({}) { |(key, value), result| result[key.to_sym] = value }
    end
  end
end
