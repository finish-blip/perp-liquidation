# frozen_string_literal: true

module PerpLiquidation
  class AccountSnapshot
    attr_reader :account_id, :user_id, :version, :margin_mode, :settlement_currency

    def initialize(account_id:, user_id:, version:, margin_mode:, settlement_currency:)
      @account_id = account_id.to_s
      @user_id = user_id.to_s
      @version = Integer(version)
      @margin_mode = margin_mode.to_s
      @settlement_currency = settlement_currency.to_s
      raise InvalidCommand, 'account snapshot version must be positive' unless @version.positive?
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, "invalid account snapshot: #{e.message}"
    end

    def snapshot
      {
        account_id: account_id,
        user_id: user_id,
        version: version,
        margin_mode: margin_mode,
        settlement_currency: settlement_currency
      }
    end
  end
end
