# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class MarketQuote
    BookLevel = Struct.new(:price, :quantity, keyword_init: true) do
      def snapshot
        { price: price.to_s('F'), quantity: quantity.to_s('F') }
      end
    end

    attr_reader :symbol, :best_bid, :best_ask, :observed_at, :sequence,
                :bids, :asks, :quantity_increment

    def initialize(symbol:, best_bid:, best_ask:, observed_at:, sequence: nil,
                   bids: nil, asks: nil, quantity_increment: nil)
      raise InvalidCommand, 'market quote observed_at is required' if observed_at.nil?

      @symbol = symbol.to_s
      @best_bid = BigDecimal(best_bid.to_s)
      @best_ask = BigDecimal(best_ask.to_s)
      @observed_at = observed_at.is_a?(String) ? Time.parse(observed_at).utc : observed_at.utc
      @sequence = sequence.nil? ? nil : Integer(sequence)
      @bids = normalize_levels(bids)
      @asks = normalize_levels(asks)
      @quantity_increment = quantity_increment.nil? ? nil : BigDecimal(quantity_increment.to_s)
      raise InvalidCommand, 'market quote prices must be positive' unless @best_bid.positive? && @best_ask.positive?
      raise InvalidCommand, 'market quote best_bid exceeds best_ask' if @best_bid > @best_ask
      if @quantity_increment && !@quantity_increment.positive?
        raise InvalidCommand, 'market quote quantity_increment must be positive'
      end
      validate_book!
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, "invalid market quote: #{e.message}"
    end

    def snapshot
      {
        symbol: symbol,
        best_bid: best_bid.to_s('F'),
        best_ask: best_ask.to_s('F'),
        observed_at: observed_at.iso8601,
        sequence: sequence,
        bids: bids.map(&:snapshot),
        asks: asks.map(&:snapshot),
        quantity_increment: quantity_increment&.to_s('F')
      }
    end

    def depth_quantity(side:, worst_price:)
      boundary = BigDecimal(worst_price.to_s)
      levels = side == 'SELL' ? bids : asks
      eligible = if side == 'SELL'
                   levels.select { |level| level.price >= boundary }
                 else
                   levels.select { |level| level.price <= boundary }
                 end
      eligible.reduce(BigDecimal('0')) { |total, level| total + level.quantity }
    end

    private

    def normalize_levels(levels)
      return [] if levels.nil?
      raise InvalidCommand, 'market quote book levels must be an array' unless levels.is_a?(Array)

      levels.map do |level|
        price = value(level, :price)
        quantity = value(level, :quantity)
        item = BookLevel.new(price: BigDecimal(price.to_s), quantity: BigDecimal(quantity.to_s))
        unless item.price.positive? && item.quantity.positive?
          raise InvalidCommand, 'market quote book level price and quantity must be positive'
        end
        item
      end
    end

    def validate_book!
      if bids.any?
        raise InvalidCommand, 'first bid must equal best_bid' unless bids.first.price == best_bid
        unless bids.each_cons(2).all? { |left, right| left.price >= right.price }
          raise InvalidCommand, 'market quote bids must be sorted descending'
        end
      end
      if asks.any?
        raise InvalidCommand, 'first ask must equal best_ask' unless asks.first.price == best_ask
        unless asks.each_cons(2).all? { |left, right| left.price <= right.price }
          raise InvalidCommand, 'market quote asks must be sorted ascending'
        end
      end
    end

    def value(hash, key)
      return hash.public_send(key) if hash.respond_to?(key)
      return hash[key] if hash.respond_to?(:key?) && hash.key?(key)
      return hash[key.to_s] if hash.respond_to?(:key?) && hash.key?(key.to_s)

      raise InvalidCommand, "market quote book level is missing #{key}"
    end
  end
end
