# frozen_string_literal: true

describe PerpLiquidation::Application do
  it 'builds process components lazily' do
    application = described_class.new(env: { 'DATA_MODE' => 'memory' }, role: :outbox_dispatcher)

    application.outbox_dispatcher

    expect(application.instance_variable_defined?(:@repository)).to be(true)
    expect(application.instance_variable_defined?(:@order_client)).to be(false)
    expect(application.instance_variable_defined?(:@market_data_client)).to be(false)
    expect(application.instance_variable_defined?(:@orchestrator)).to be(false)
  end

  it 'uses smaller default connection pools for single-threaded workers' do
    application = described_class.new(env: { 'DATA_MODE' => 'memory' }, role: :liquidation_worker)

    expect(application.send(:database_pool_size)).to eq(2)
  end

  it 'keeps the full application on the API-sized connection pool' do
    application = described_class.new(
      env: {
        'DATA_MODE' => 'memory', 'DATABASE_POOL_SIZE_API' => '9',
        'DATABASE_POOL_SIZE_BACKGROUND' => '3'
      }
    )

    expect(application.send(:database_pool_size)).to eq(9)
  end

  it 'allows an explicit connection pool size to override the role default' do
    application = described_class.new(
      env: { 'DATA_MODE' => 'memory', 'DATABASE_POOL_SIZE' => '7' },
      role: :outbox_dispatcher
    )

    expect(application.send(:database_pool_size)).to eq(7)
  end

  it 'prefers a role-specific connection pool size over the legacy shared value' do
    application = described_class.new(
      env: {
        'DATA_MODE' => 'memory', 'DATABASE_POOL_SIZE' => '7',
        'DATABASE_POOL_SIZE_BACKGROUND' => '3'
      },
      role: :recovery_worker
    )

    expect(application.send(:database_pool_size)).to eq(3)
  end
end
