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
          filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001' }]
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

  it 'selects Binance without requiring the internal market data service URL' do
    env = {
      'DATABASE_URL' => 'mysql2://db', 'REDIS_URL' => 'redis://redis',
      'ORDER_SERVICE_URL' => 'http://orders', 'POSITION_SERVICE_URL' => 'http://positions',
      'ACCOUNT_SERVICE_URL' => 'http://accounts', 'RISK_SERVICE_URL' => 'http://risk',
      'SERVICE_TOKEN' => 'token', 'MARKET_DATA_PROVIDER' => 'binance'
    }
    application = PerpLiquidation::Application.allocate
    application.instance_variable_set(:@env, env)
    application.instance_variable_set(:@data_mode, 'real')

    expect { application.send(:validate_configuration!) }.not_to raise_error
    expect(application.send(:build_market_data_client)).to be_a(described_class)
  end
end
