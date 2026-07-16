# frozen_string_literal: true

require 'time'

module PerpLiquidation
  class FakeApprovalClient
    attr_reader :verified

    def initialize(approved: true, clock: -> { Time.now.utc })
      @approved = approved
      @clock = clock
      @verified = []
    end

    def verify!(attributes)
      raise PreconditionsFailed, 'operator approval is not approved' unless @approved

      evidence = attributes.transform_keys(&:to_sym).merge(
        approved: true,
        expires_at: (@clock.call + 300).iso8601
      )
      @verified << evidence
      evidence
    end
  end
end
