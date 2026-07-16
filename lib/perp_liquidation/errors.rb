# frozen_string_literal: true

module PerpLiquidation
  class Error < StandardError; end
  class InvalidTransition < Error; end
  class MissingField < Error; end
  class PositionLocked < Error; end
  class NotFound < Error; end
  class InvalidCommand < Error; end
  class StaleDecision < Error; end
  class InstructionExpired < Error; end
  class PreconditionsFailed < Error; end
  class RetryableError < Error; end
  class PriceProtectionBreached < RetryableError; end
  class ExecutionDeferred < RetryableError; end
  class InsufficientMarketLiquidity < ExecutionDeferred; end
  class ExecutionBackpressure < ExecutionDeferred; end
  class ExecutionPolicyExhausted < PreconditionsFailed; end
  class ManualReviewRequired < Error; end
end
