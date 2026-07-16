# frozen_string_literal: true

require 'bigdecimal'

module PerpLiquidation
  class FakeLossMitigationClient
    attr_reader :bankruptcy_checks, :insurance_claims, :adl_requests

    def initialize(bankruptcy_loss: '0', bankruptcy_price: nil, insurance_covered_amount: nil,
                   currency: 'USDT', adl_status: 'PENDING')
      @bankruptcy_loss = BigDecimal(bankruptcy_loss.to_s)
      @bankruptcy_price = bankruptcy_price
      @insurance_covered_amount = insurance_covered_amount
      @currency = currency
      @adl_status = adl_status
      @bankruptcy_checks = {}
      @insurance_claims = {}
      @adl_requests = {}
    end

    def check_bankruptcy(attributes)
      task_id = attributes.fetch(:task_id)
      @bankruptcy_checks[task_id] ||= {
        check_id: "bankruptcy_#{task_id}",
        status: 'COMPLETED',
        bankruptcy_price: @bankruptcy_price,
        bankruptcy_loss: @bankruptcy_loss.to_s('F'),
        currency: @currency
      }
    end

    def claim_insurance(attributes)
      task_id = attributes.fetch(:task_id)
      requested = BigDecimal(attributes.fetch(:requested_amount).to_s)
      covered = @insurance_covered_amount.nil? ? requested : BigDecimal(@insurance_covered_amount.to_s)
      covered = requested if covered > requested
      @insurance_claims[task_id] ||= {
        claim_id: "insurance_#{task_id}",
        status: 'COMPLETED',
        requested_amount: requested.to_s('F'),
        covered_amount: covered.to_s('F'),
        currency: attributes[:currency] || @currency
      }
    end

    def request_adl(attributes)
      task_id = attributes.fetch(:task_id)
      requested = BigDecimal(attributes.fetch(:requested_amount).to_s)
      @adl_requests[task_id] ||= {
        adl_request_id: "adl_#{task_id}",
        status: @adl_status,
        requested_amount: requested.to_s('F'),
        covered_amount: @adl_status == 'COMPLETED' ? requested.to_s('F') : '0',
        currency: attributes[:currency] || @currency
      }
    end

    def find_adl_request(adl_request_id:)
      @adl_requests.values.find { |request| request[:adl_request_id] == adl_request_id }
    end

    def complete_adl(task_id)
      request = @adl_requests.fetch(task_id)
      request[:status] = 'COMPLETED'
      request[:covered_amount] = request[:requested_amount]
      request
    end
  end
end
