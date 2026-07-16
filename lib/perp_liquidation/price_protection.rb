# frozen_string_literal: true

module PerpLiquidation
  class PriceProtection
    def initialize(clock: -> { Time.now.utc })
      @clock = clock
    end

    def validate!(task, quote)
      return nil unless task.bankruptcy_price
      unless quote.symbol == task.symbol
        raise PreconditionsFailed, "market quote symbol #{quote.symbol} does not match #{task.symbol}"
      end

      age_ms = ((@clock.call - quote.observed_at) * 1000).to_i
      raise RetryableError, 'market quote timestamp is in the future' if age_ms < -1000
      if age_ms > task.quote_max_age_ms
        raise RetryableError, "market quote is stale by #{age_ms}ms"
      end

      if task.position_side == 'LONG'
        side = 'SELL'
        market_price = quote.best_bid
        worst_price = task.bankruptcy_price * (BigDecimal('1') - task.max_liquidation_deviation)
        if market_price < worst_price
          raise PriceProtectionBreached,
                "best bid #{market_price.to_s('F')} is below protected price #{worst_price.to_s('F')}"
        end
      else
        side = 'BUY'
        market_price = quote.best_ask
        worst_price = task.bankruptcy_price * (BigDecimal('1') + task.max_liquidation_deviation)
        if market_price > worst_price
          raise PriceProtectionBreached,
                "best ask #{market_price.to_s('F')} is above protected price #{worst_price.to_s('F')}"
        end
      end

      {
        side: side,
        bankruptcy_price: task.bankruptcy_price.to_s('F'),
        max_liquidation_deviation: task.max_liquidation_deviation.to_s('F'),
        worst_acceptable_price: worst_price.to_s('F'),
        market_quote_price: market_price.to_s('F'),
        market_quote_observed_at: quote.observed_at.iso8601,
        market_quote_sequence: quote.sequence,
        market_depth_quantity: quote.depth_quantity(side: side, worst_price: worst_price).to_s('F'),
        quantity_increment: quote.quantity_increment&.to_s('F')
      }
    end
  end
end
