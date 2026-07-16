# frozen_string_literal: true

module SpecFactories
  def command_payload(overrides = {})
    instruction_overrides = overrides.delete(:instruction) || {}
    payload = {
      schema_version: 1,
      risk_decision_id: 'risk_103',
      risk_unit_id: 'position:888',
      decision_sequence: 103,
      action: 'REDUCE_POSITION',
      user_id: 1001,
      account_id: 'acc_1001',
      position_id: 888,
      position_version: 42,
      symbol: 'BTCUSDT',
      position_side: 'LONG',
      instruction: {
        target_quantity: '0.01',
        max_executable_quantity: '0.01',
        order_type: 'MARKET',
        reduce_only: true,
        time_in_force: 'IOC',
        max_slippage: '0.005'
      }.merge(instruction_overrides),
      risk_snapshot: {
        mark_price: '54200',
        margin_ratio: '0.004',
        liquidation_price: '54250',
        position_size: '0.01',
        market_data_timestamp: Time.now.utc.iso8601
      },
      expire_at: (Time.now.utc + 60).iso8601,
      created_at: Time.now.utc.iso8601
    }
    result = payload.merge(overrides)
    if result[:action] == 'LIQUIDATE_POSITION' && !result.key?(:price_protection)
      result[:price_protection] = {
        bankruptcy_price: '54000', max_deviation: '0.03', quote_max_age_ms: 2000
      }
    end
    result
  end

  def position_snapshot(overrides = {})
    PerpLiquidation::PositionSnapshot.new(
      **{
        position_id: 888,
        version: 42,
        user_id: 1001,
        account_id: 'acc_1001',
        symbol: 'BTCUSDT',
        side: 'LONG',
        size: '0.01'
      }.merge(overrides)
    )
  end

  def adaptive_execution_policy(overrides = {})
    {
      strategy: 'ADAPTIVE',
      urgency: 'NORMAL',
      max_child_orders: 8,
      max_child_quantity: '0.004',
      min_child_quantity: '0.001',
      max_book_participation: '1',
      child_order_cooldown_ms: 0,
      child_order_timeout_ms: 1000
    }.merge(overrides)
  end

  def liquid_market_quote(overrides = {})
    attributes = {
      symbol: 'BTCUSDT',
      best_bid: '54190',
      best_ask: '54210',
      observed_at: Time.now.utc,
      sequence: 101,
      bids: [
        { price: '54190', quantity: '0.004' },
        { price: '54180', quantity: '0.004' },
        { price: '54000', quantity: '0.02' }
      ],
      asks: [
        { price: '54210', quantity: '0.004' },
        { price: '54220', quantity: '0.004' },
        { price: '55000', quantity: '0.02' }
      ],
      quantity_increment: '0.001'
    }.merge(overrides)
    PerpLiquidation::MarketQuote.new(**attributes)
  end

  def portfolio_command_payload(overrides = {})
    now = Time.now.utc
    payload = {
      schema_version: 2,
      plan_id: 'portfolio_plan_201',
      risk_decision_id: 'portfolio_risk_201',
      risk_unit_id: 'account:acc_1001:settlement:USDT',
      decision_sequence: 201,
      action: 'LIQUIDATE_PORTFOLIO',
      execution_priority: 5,
      user_id: 1001,
      account_id: 'acc_1001',
      account_version: 88,
      margin_mode: 'CROSS',
      max_total_authorized_notional: '100000',
      failure_mode: 'STOP_ON_FAILURE',
      items: [
        {
          action: 'LIQUIDATE_POSITION',
          position_id: 888,
          position_version: 42,
          symbol: 'BTCUSDT',
          position_side: 'LONG',
          authorized_notional: '60000',
          instruction: {
            target_quantity: '0.01', max_executable_quantity: '0.01', quantity_mode: 'EXACT',
            order_type: 'MARKET', reduce_only: true, time_in_force: 'IOC', max_slippage: '0.005'
          },
          price_protection: {
            bankruptcy_price: '54000', max_deviation: '0.03', quote_max_age_ms: 2000
          },
          risk_snapshot: {
            position_size: '0.01', market_data_timestamp: now.iso8601, mark_price: '54200'
          }
        },
        {
          action: 'LIQUIDATE_POSITION',
          position_id: 889,
          position_version: 70,
          symbol: 'ETHUSDT',
          position_side: 'LONG',
          authorized_notional: '30000',
          instruction: {
            target_quantity: '2', max_executable_quantity: '2', quantity_mode: 'EXACT',
            order_type: 'MARKET', reduce_only: true, time_in_force: 'IOC', max_slippage: '0.005'
          },
          price_protection: {
            bankruptcy_price: '3000', max_deviation: '0.03', quote_max_age_ms: 2000
          },
          risk_snapshot: {
            position_size: '2', market_data_timestamp: now.iso8601, mark_price: '3020'
          }
        }
      ],
      expire_at: (now + 60).iso8601,
      created_at: now.iso8601
    }
    payload.merge(overrides)
  end
end
