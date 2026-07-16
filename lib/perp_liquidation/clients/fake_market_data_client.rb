# frozen_string_literal: true

module PerpLiquidation
  class FakeMarketDataClient
    def initialize(quotes = [])
      @quotes = {}
      quotes.each { |quote| put(quote) }
    end

    def put(quote)
      @quotes[quote.symbol] = quote
    end

    def find(symbol:)
      @quotes.fetch(symbol.to_s) { raise RetryableError, "market quote for #{symbol} is unavailable" }
    end
  end
end
