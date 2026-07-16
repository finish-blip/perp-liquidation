# frozen_string_literal: true

require 'spec_helper'

RSpec.describe PerpLiquidation::PriceProtection do
  let(:repository) { PerpLiquidation::MemoryRepository.new }
  let(:receiver) { PerpLiquidation::CommandReceiver.new(repository: repository) }

  it 'uses the ask and upper boundary when liquidating a short position' do
    task = receiver.call(command_payload(
      action: 'LIQUIDATE_POSITION',
      position_side: 'SHORT'
    ))
    quote = PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '54990', best_ask: '55000',
      observed_at: Time.now.utc, sequence: 44
    )

    result = described_class.new.validate!(task, quote)

    expect(result).to include(
      side: 'BUY', market_quote_price: '55000.0', worst_acceptable_price: '55620.0'
    )
  end

  it 'rejects a stale quote even when its price is inside the boundary' do
    task = receiver.call(command_payload(action: 'LIQUIDATE_POSITION'))
    quote = PerpLiquidation::MarketQuote.new(
      symbol: 'BTCUSDT', best_bid: '54190', best_ask: '54210',
      observed_at: Time.now.utc - 3
    )

    expect { described_class.new.validate!(task, quote) }
      .to raise_error(PerpLiquidation::RetryableError, /stale/)
  end

  it 'reports only short-side ask depth inside the authorized upper boundary' do
    task = receiver.call(command_payload(action: 'LIQUIDATE_POSITION', position_side: 'SHORT'))
    quote = liquid_market_quote(
      best_bid: '54990',
      best_ask: '55000',
      bids: [{ price: '54990', quantity: '1' }],
      asks: [
        { price: '55000', quantity: '2' },
        { price: '55600', quantity: '3' },
        { price: '55700', quantity: '9' }
      ]
    )

    result = described_class.new.validate!(task, quote)

    expect(result[:worst_acceptable_price]).to eq('55620.0')
    expect(result[:market_depth_quantity]).to eq('5.0')
    expect(result[:quantity_increment]).to eq('0.001')
  end
end
