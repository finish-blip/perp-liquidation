# frozen_string_literal: true

require 'faraday'
require 'json'
require 'bigdecimal'

module PerpLiquidation
  class BinanceFuturesMarketDataClient
    DEFAULT_ENDPOINT = 'https://fapi.binance.com'
    DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000].freeze

    def initialize(endpoint: DEFAULT_ENDPOINT, connection: nil, depth_limit: 20,
                   exchange_info_ttl: 3600, clock: -> { Time.now.utc }, open_timeout: 2, timeout: 5)
      @depth_limit = Integer(depth_limit)
      raise InvalidCommand, 'BINANCE_DEPTH_LIMIT is unsupported' unless DEPTH_LIMITS.include?(@depth_limit)

      @exchange_info_ttl = Float(exchange_info_ttl)
      raise InvalidCommand, 'BINANCE_EXCHANGE_INFO_TTL_SECONDS must be positive' unless @exchange_info_ttl.positive?

      @clock = clock
      @symbol_rules = nil
      @symbol_rules_expires_at = Time.at(0).utc
      @symbol_rules_lock = Mutex.new
      @connection = connection || Faraday.new(url: endpoint) do |faraday|
        faraday.options.open_timeout = Float(open_timeout)
        faraday.options.timeout = Float(timeout)
        faraday.adapter Faraday.default_adapter
      end
    end

    def find(symbol:)
      normalized_symbol = normalize_symbol(symbol)
      rule = symbol_rule(normalized_symbol)
      depth = fetch_json(
        '/fapi/v1/depth',
        symbol: normalized_symbol,
        limit: @depth_limit
      )

      build_quote(normalized_symbol, depth, rule.fetch('stepSize'))
    end

    private

    def normalize_symbol(symbol)
      value = symbol.to_s.upcase
      unless value.match?(%r{\A[A-Z0-9]{2,30}\z})
        raise PreconditionsFailed, "invalid Binance futures symbol #{symbol.inspect}"
      end

      value
    end

    def symbol_rule(symbol)
      refresh_symbol_rules_if_needed!
      rule = @symbol_rules[symbol]
      raise PreconditionsFailed, "Binance USD-M futures symbol #{symbol} is unavailable" unless rule
      unless rule['contractType'] == 'PERPETUAL'
        raise PreconditionsFailed, "Binance futures symbol #{symbol} is not perpetual"
      end
      raise RetryableError, "Binance futures symbol #{symbol} is not trading" unless rule['status'] == 'TRADING'

      rule
    end

    def refresh_symbol_rules_if_needed!
      return unless symbol_rules_expired?

      @symbol_rules_lock.synchronize do
        return unless symbol_rules_expired?

        refresh_symbol_rules!
      end
    end

    def symbol_rules_expired?
      @symbol_rules.nil? || @clock.call >= @symbol_rules_expires_at
    end

    def refresh_symbol_rules!
      payload = fetch_json('/fapi/v1/exchangeInfo')
      symbols = payload.fetch('symbols')
      raise TypeError, 'symbols must be a non-empty array' unless symbols.is_a?(Array) && !symbols.empty?

      rules = symbols.each_with_object({}) do |item, result|
        symbol = item.fetch('symbol').to_s
        next unless symbol.match?(%r{\A[A-Z0-9]{2,30}\z})

        filters = item.fetch('filters')
        raise TypeError, "filters for #{symbol} must be an array" unless filters.is_a?(Array)

        lot_size = filters.find { |filter| filter['filterType'] == 'LOT_SIZE' }
        price_filter = filters.find { |filter| filter['filterType'] == 'PRICE_FILTER' }
        raise KeyError, "LOT_SIZE is missing for #{symbol}" unless lot_size
        raise KeyError, "PRICE_FILTER is missing for #{symbol}" unless price_filter

        result[symbol] = {
          'contractType' => item.fetch('contractType'),
          'status' => item.fetch('status'),
          'stepSize' => positive_decimal!(lot_size.fetch('stepSize'), "#{symbol} LOT_SIZE.stepSize"),
          'minQty' => positive_decimal!(lot_size.fetch('minQty'), "#{symbol} LOT_SIZE.minQty"),
          'maxQty' => positive_decimal!(lot_size.fetch('maxQty'), "#{symbol} LOT_SIZE.maxQty"),
          'tickSize' => positive_decimal!(price_filter.fetch('tickSize'), "#{symbol} PRICE_FILTER.tickSize")
        }.freeze
      end
      @symbol_rules = rules.freeze
      @symbol_rules_expires_at = @clock.call + @exchange_info_ttl
    rescue KeyError, TypeError, ArgumentError => e
      raise RetryableError, "invalid Binance futures exchange info: #{e.message}"
    end

    def positive_decimal!(value, label)
      decimal = BigDecimal(value.to_s)
      raise ArgumentError, "#{label} must be positive" unless decimal.positive?

      decimal.to_s('F')
    end

    def build_quote(symbol, payload, quantity_increment)
      bids = normalize_levels(payload.fetch('bids'), 'bids')
      asks = normalize_levels(payload.fetch('asks'), 'asks')
      raise RetryableError, "Binance futures depth for #{symbol} is empty" if bids.empty? || asks.empty?

      timestamp_ms = payload['E'] || payload['T']
      raise KeyError, 'E or T timestamp is missing' if timestamp_ms.nil?

      sequence = Integer(payload.fetch('lastUpdateId'))
      raise ArgumentError, 'lastUpdateId must be positive' unless sequence.positive?

      observed_at = Time.at(Integer(timestamp_ms) / 1000.0).utc
      MarketQuote.new(
        symbol: symbol,
        best_bid: bids.first.fetch(:price),
        best_ask: asks.first.fetch(:price),
        observed_at: observed_at,
        sequence: sequence,
        bids: bids,
        asks: asks,
        quantity_increment: quantity_increment
      )
    rescue KeyError, TypeError, ArgumentError, InvalidCommand => e
      raise RetryableError, "invalid Binance futures depth for #{symbol}: #{e.message}"
    end

    def normalize_levels(levels, name)
      raise TypeError, "#{name} must be an array" unless levels.is_a?(Array)

      levels.map do |level|
        raise TypeError, "#{name} level must contain price and quantity" unless level.is_a?(Array) && level.length >= 2

        { price: level[0], quantity: level[1] }
      end
    end

    def fetch_json(path, params = {})
      response = @connection.get(path, params)
      status = Integer(response.status)
      if status == 418 || status == 429 || status >= 500
        raise RetryableError, "Binance futures API returned #{status}"
      end
      if status >= 400
        raise PreconditionsFailed, "Binance futures API returned #{status}: #{response.body}"
      end

      JSON.parse(response.body)
    rescue Faraday::TimeoutError, Faraday::ConnectionFailed => e
      raise RetryableError, "Binance futures API unavailable: #{e.message}"
    rescue JSON::ParserError => e
      raise RetryableError, "Binance futures API returned invalid JSON: #{e.message}"
    end
  end
end
