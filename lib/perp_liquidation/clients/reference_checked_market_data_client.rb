# frozen_string_literal: true

require 'bigdecimal'

module PerpLiquidation
  class ReferenceCheckedMarketDataClient
    attr_reader :execution_client, :reference_client

    def initialize(execution_client:, reference_client:, max_deviation:, max_age_ms:,
                   clock: -> { Time.now.utc })
      @execution_client = execution_client
      @reference_client = reference_client
      @max_deviation = BigDecimal(max_deviation.to_s)
      @max_age_ms = Integer(max_age_ms)
      @clock = clock

      unless @max_deviation.positive? && @max_deviation < 1
        raise InvalidCommand, 'BINANCE_REFERENCE_MAX_DEVIATION must be between 0 and 1'
      end
      unless @max_age_ms.between?(1, 60_000)
        raise InvalidCommand, 'BINANCE_REFERENCE_MAX_AGE_MS must be between 1 and 60000'
      end
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, "invalid Binance reference market data configuration: #{e.message}"
    end

    def find(symbol:)
      execution_quote = execution_client.find(symbol: symbol)
      reference_quote = fetch_reference_quote(symbol)
      validate_reference_quote!(execution_quote, reference_quote, symbol)
      execution_quote
    end

    private

    def fetch_reference_quote(symbol)
      reference_client.find(symbol: symbol)
    rescue RetryableError => e
      raise ReferenceMarketDataUnavailable, "Binance reference market data unavailable: #{e.message}"
    end

    def validate_reference_quote!(execution_quote, reference_quote, requested_symbol)
      expected_symbol = requested_symbol.to_s.upcase
      unless execution_quote.symbol == expected_symbol && reference_quote.symbol == expected_symbol
        raise ReferenceMarketDataUnavailable,
              "market data symbol mismatch: expected #{expected_symbol}, " \
              "execution=#{execution_quote.symbol}, reference=#{reference_quote.symbol}"
      end

      age_ms = ((@clock.call - reference_quote.observed_at) * 1000).to_i
      if age_ms < -1000
        raise ReferenceMarketDataUnavailable, 'Binance reference market data timestamp is in the future'
      end
      if age_ms > @max_age_ms
        raise ReferenceMarketDataUnavailable, "Binance reference market data is stale by #{age_ms}ms"
      end

      bid_deviation = relative_deviation(execution_quote.best_bid, reference_quote.best_bid)
      ask_deviation = relative_deviation(execution_quote.best_ask, reference_quote.best_ask)
      observed_deviation = [bid_deviation, ask_deviation].max
      return if observed_deviation <= @max_deviation

      raise ReferencePriceDivergence,
            "execution market differs from Binance reference by #{observed_deviation.to_s('F')}; " \
            "maximum #{@max_deviation.to_s('F')}"
    end

    def relative_deviation(execution_price, reference_price)
      (execution_price - reference_price).abs / reference_price
    end
  end
end
