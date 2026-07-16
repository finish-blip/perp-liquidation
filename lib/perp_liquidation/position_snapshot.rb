# frozen_string_literal: true

require 'bigdecimal'

module PerpLiquidation
  class PositionSnapshot
    attr_reader :position_id, :version, :user_id, :account_id, :symbol, :side, :size

    def initialize(position_id:, version:, user_id:, account_id:, symbol:, side:, size:)
      @position_id = position_id
      @version = Integer(version)
      @user_id = user_id
      @account_id = account_id
      @symbol = symbol.to_s
      @side = side.to_s
      @size = BigDecimal(size.to_s)
    end

    def snapshot
      {
        position_id: position_id,
        version: version,
        user_id: user_id,
        account_id: account_id,
        symbol: symbol,
        side: side,
        size: size.to_s('F')
      }
    end
  end
end
