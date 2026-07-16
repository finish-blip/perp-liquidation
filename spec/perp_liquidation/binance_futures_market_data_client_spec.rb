# frozen_string_literal: true

require 'json'

describe PerpLiquidation::BinanceFuturesMarketDataClient do
  let(:connection) { double('Faraday connection') }
  let(:response_class) { Struct.new(:status, :body) }
  let(:clock) { -> { Time.utc(2026, 7, 15, 8, 0, 0) } }
  let(:exchange_info) do
    {
      symbols: [
        {
          symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING',
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
            { filterType: 'PRICE_FILTER', tickSize: '0.10' }
          ]
        }
      ]
    }
  end
  let(:depth) do
    {
      lastUpdateId: 12_345,
      E: 1_752_566_400_123,
      bids: [['54190.0', '0.004'], ['54180.0', '0.006']],
      asks: [['54210.0', '0.005'], ['54220.0', '0.007']]
    }
  end

  def response(status, body)
    response_class.new(status, JSON.generate(body))
  end

  it 'maps Binance USD-M perpetual depth to the internal market quote contract' do
    allow(connection).to receive(:get) do |path, _params|
      path == '/fapi/v1/exchangeInfo' ? response(200, exchange_info) : response(200, depth)
    end
    client = described_class.new(connection: connection, clock: clock)

    quote = client.find(symbol: 'btcusdt')

    expect(quote.snapshot).to include(
      symbol: 'BTCUSDT', best_bid: '54190.0', best_ask: '54210.0',
      sequence: 12_345, quantity_increment: '0.001'
    )
    expect(quote.bids.map(&:snapshot)).to eq([
      { price: '54190.0', quantity: '0.004' },
      { price: '54180.0', quantity: '0.006' }
    ])
    expect(quote.observed_at.to_f).to be_within(0.001).of(1_752_566_400.123)
  end

  it 'caches exchange information while fetching fresh depth for every lookup' do
    allow(connection).to receive(:get) do |path, _params|
      path == '/fapi/v1/exchangeInfo' ? response(200, exchange_info) : response(200, depth)
    end
    client = described_class.new(connection: connection, clock: clock)

    2.times { client.find(symbol: 'BTCUSDT') }

    expect(connection).to have_received(:get).with('/fapi/v1/exchangeInfo', {}).once
    expect(connection).to have_received(:get).with(
      '/fapi/v1/depth', symbol: 'BTCUSDT', limit: 20
    ).twice
  end

  it 'serializes concurrent exchange information refreshes' do
    exchange_info_calls = 0
    calls_lock = Mutex.new
    allow(connection).to receive(:get) do |path, _params|
      if path == '/fapi/v1/exchangeInfo'
        calls_lock.synchronize { exchange_info_calls += 1 }
        sleep 0.05
        response(200, exchange_info)
      else
        response(200, depth)
      end
    end
    client = described_class.new(connection: connection, clock: clock)

    4.times.map { Thread.new { client.find(symbol: 'BTCUSDT') } }.each(&:value)

    expect(exchange_info_calls).to eq(1)
  end

  it 'rejects a delivery contract instead of treating it as perpetual' do
    exchange_info[:symbols][0][:contractType] = 'CURRENT_QUARTER'
    allow(connection).to receive(:get).and_return(response(200, exchange_info))
    client = described_class.new(connection: connection, clock: clock)

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::PreconditionsFailed, /not perpetual/)
  end

  it 'treats Binance rate limiting as retryable' do
    allow(connection).to receive(:get) do |path, _params|
      path == '/fapi/v1/exchangeInfo' ? response(200, exchange_info) : response(429, code: -1003)
    end
    client = described_class.new(connection: connection, clock: clock)

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::RetryableError, /returned 429/)
  end

  it 'rejects incomplete exchange rules as retryable provider data' do
    exchange_info[:symbols][0][:filters].reject! { |filter| filter[:filterType] == 'PRICE_FILTER' }
    allow(connection).to receive(:get).and_return(response(200, exchange_info))
    client = described_class.new(connection: connection, clock: clock)

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::RetryableError, /PRICE_FILTER is missing/)
  end

  it 'rejects depth without an exchange timestamp' do
    depth.delete(:E)
    allow(connection).to receive(:get) do |path, _params|
      path == '/fapi/v1/exchangeInfo' ? response(200, exchange_info) : response(200, depth)
    end
    client = described_class.new(connection: connection, clock: clock)

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::RetryableError, /timestamp is missing/)
  end

  it 'requires explicit acknowledgement before using Binance as execution market data' do
    env = {
      'DATABASE_URL' => 'mysql2://db', 'REDIS_URL' => 'redis://redis',
      'ORDER_SERVICE_URL' => 'http://orders', 'POSITION_SERVICE_URL' => 'http://positions',
      'ACCOUNT_SERVICE_URL' => 'http://accounts', 'RISK_SERVICE_URL' => 'http://risk',
      'SERVICE_TOKEN' => 'token', 'MARKET_DATA_PROVIDER' => 'binance'
    }
    application = PerpLiquidation::Application.allocate
    application.instance_variable_set(:@env, env)
    application.instance_variable_set(:@data_mode, 'real')

    expect { application.send(:validate_configuration!) }
      .to raise_error(PerpLiquidation::InvalidCommand, /ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA/)

    env['ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA'] = 'true'
    expect { application.send(:validate_configuration!) }.not_to raise_error
    expect(application.send(:build_market_data_client)).to be_a(described_class)
  end

  it 'wraps the internal execution client with an optional Binance reference guard' do
    env = {
      'DATABASE_URL' => 'mysql2://db', 'REDIS_URL' => 'redis://redis',
      'ORDER_SERVICE_URL' => 'http://orders', 'POSITION_SERVICE_URL' => 'http://positions',
      'ACCOUNT_SERVICE_URL' => 'http://accounts', 'RISK_SERVICE_URL' => 'http://risk',
      'MARKET_DATA_SERVICE_URL' => 'http://market-data', 'SERVICE_TOKEN' => 'token',
      'MARKET_DATA_PROVIDER' => 'internal', 'BINANCE_REFERENCE_ENABLED' => 'true'
    }
    application = PerpLiquidation::Application.allocate
    application.instance_variable_set(:@env, env)
    application.instance_variable_set(:@data_mode, 'real')

    expect { application.send(:validate_configuration!) }.not_to raise_error
    client = application.send(:build_market_data_client)
    expect(client).to be_a(PerpLiquidation::ReferenceCheckedMarketDataClient)
    expect(client.execution_client).to be_a(PerpLiquidation::MarketDataHttpClient)
    expect(client.reference_client).to be_a(described_class)
  end

  it 'rejects invalid Binance reference thresholds during configuration validation' do
    env = {
      'DATABASE_URL' => 'mysql2://db', 'REDIS_URL' => 'redis://redis',
      'ORDER_SERVICE_URL' => 'http://orders', 'POSITION_SERVICE_URL' => 'http://positions',
      'ACCOUNT_SERVICE_URL' => 'http://accounts', 'RISK_SERVICE_URL' => 'http://risk',
      'MARKET_DATA_SERVICE_URL' => 'http://market-data', 'SERVICE_TOKEN' => 'token',
      'BINANCE_REFERENCE_ENABLED' => 'true', 'BINANCE_REFERENCE_MAX_DEVIATION' => '1'
    }
    application = PerpLiquidation::Application.allocate
    application.instance_variable_set(:@env, env)
    application.instance_variable_set(:@data_mode, 'real')

    expect { application.send(:validate_configuration!) }
      .to raise_error(PerpLiquidation::InvalidCommand, /MAX_DEVIATION/)
  end
end
