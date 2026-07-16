# frozen_string_literal: true

describe PerpLiquidation::ReferenceCheckedMarketDataClient do
  let(:now) { Time.utc(2026, 7, 16, 8, 0, 0) }
  let(:execution_quote) do
    PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '100', best_ask: '101', observed_at: now,
      bids: [{ price: '100', quantity: '2' }],
      asks: [{ price: '101', quantity: '2' }], quantity_increment: '0.001'
    )
  end
  let(:reference_quote) do
    PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '99.5', best_ask: '100.5', observed_at: now
    )
  end
  let(:execution_client) { PerpLiquidation::FakeMarketDataClient.new([execution_quote]) }
  let(:reference_client) { PerpLiquidation::FakeMarketDataClient.new([reference_quote]) }

  def client(max_deviation: '0.03', max_age_ms: 2000)
    described_class.new(
      execution_client: execution_client,
      reference_client: reference_client,
      max_deviation: max_deviation,
      max_age_ms: max_age_ms,
      clock: -> { now }
    )
  end

  it 'returns the internal execution quote after validating the Binance reference' do
    expect(client.find(symbol: 'BTCUSDT')).to equal(execution_quote)
  end

  it 'blocks execution when either side diverges beyond the configured boundary' do
    reference_client.put(PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '90', best_ask: '91', observed_at: now
    ))

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::ReferencePriceDivergence, /differs from Binance reference/)
  end

  it 'blocks execution when the reference quote is stale' do
    reference_client.put(PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '99.5', best_ask: '100.5', observed_at: now - 3
    ))

    expect { client.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::ReferenceMarketDataUnavailable, /stale/)
  end

  it 'adds reference context to retryable provider failures' do
    failing_reference = instance_double(PerpLiquidation::FakeMarketDataClient)
    allow(failing_reference).to receive(:find).and_raise(PerpLiquidation::RetryableError, 'rate limited')
    guarded = described_class.new(
      execution_client: execution_client, reference_client: failing_reference,
      max_deviation: '0.03', max_age_ms: 2000, clock: -> { now }
    )

    expect { guarded.find(symbol: 'BTCUSDT') }
      .to raise_error(PerpLiquidation::ReferenceMarketDataUnavailable, /rate limited/)
  end

  it 'rejects unsafe guard configuration' do
    expect { client(max_deviation: '1') }
      .to raise_error(PerpLiquidation::InvalidCommand, /MAX_DEVIATION/)
    expect { client(max_age_ms: 0) }
      .to raise_error(PerpLiquidation::InvalidCommand, /MAX_AGE_MS/)
  end

  it 'moves the liquidation task to retry without submitting an order on divergence' do
    repository = PerpLiquidation::MemoryRepository.new
    order_client = PerpLiquidation::FakeOrderClient.new
    position_client = PerpLiquidation::FakePositionClient.new([position_snapshot])
    reference_client.put(PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '90', best_ask: '91', observed_at: now
    ))
    orchestrator = PerpLiquidation::Orchestrator.new(
      repository: repository,
      order_client: order_client,
      position_client: position_client,
      market_data_client: client,
      risk_unit_lock_manager: PerpLiquidation::RiskUnitLockManager.new
    )
    task = PerpLiquidation::CommandReceiver.new(repository: repository).call(
      command_payload(action: 'LIQUIDATE_POSITION')
    )

    PerpLiquidation::Workers::LiquidationWorker.new(
      repository: repository, orchestrator: orchestrator
    ).perform_once

    expect(task.status).to eq(PerpLiquidation::Liquidation::RETRY_WAIT)
    expect(task.error_code).to eq('ReferencePriceDivergence')
    expect(order_client.submitted_orders).to be_empty
  end
end
