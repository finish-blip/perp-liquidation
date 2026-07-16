# frozen_string_literal: true

require 'faraday'
require 'json'
require 'time'

module PerpLiquidation
  class ApprovalHttpClient
    def initialize(endpoint:, token: nil, connection: nil, open_timeout: 2, timeout: 5,
                   clock: -> { Time.now.utc })
      @token = token
      @clock = clock
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def verify!(attributes)
      response = @connection.post('/api/v1/internal/approvals/verify') do |request|
        request.headers['Authorization'] = "Bearer #{@token}" if @token
        request.headers['Content-Type'] = 'application/json'
        request.body = JSON.generate(LiquidationSerializer.normalize(attributes))
      end
      raise RetryableError, "approval service returned #{response.status}" if response.status >= 500
      if response.status >= 400
        raise PreconditionsFailed, "approval service returned #{response.status}: #{response.body}"
      end

      body = JSON.parse(response.body)
      data = body['data'] || body
      raise PreconditionsFailed, 'operator approval is not approved' unless data['approved'] == true

      %i[approval_id operation_id action target_type target_id operator_id approver_id].each do |field|
        expected = attributes.fetch(field).to_s
        actual = data.fetch(field.to_s).to_s
        raise PreconditionsFailed, "approval #{field} mismatch" unless actual == expected
      end
      expires_at = Time.parse(data.fetch('expires_at')).utc
      raise PreconditionsFailed, 'operator approval has expired' unless expires_at > @clock.call

      data
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "approval service unavailable: #{e.message}"
    rescue JSON::ParserError, KeyError, ArgumentError => e
      raise PreconditionsFailed, "invalid approval response: #{e.message}"
    end
  end
end
