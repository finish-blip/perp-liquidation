# frozen_string_literal: true

describe PerpLiquidation::MysqlRepository do
  let(:repository) { described_class.allocate }

  it 'filters and bounds task pages in SQL' do
    connection = double('mysql connection')
    captured_sql = nil
    allow(connection).to receive(:escape) { |value| value.to_s }
    allow(connection).to receive(:query) do |sql|
      captured_sql = sql
      []
    end
    paged_repository = described_class.new(connection: connection)

    page = paged_repository.list_tasks(
      filters: { status: 'PENDING', symbol: 'BTCUSDT' },
      limit: 25,
      before_id: 100
    )

    expect(page).to eq(items: [], next_before_id: nil)
    expect(captured_sql).to include("status = 'PENDING'", "symbol = 'BTCUSDT'", 'id < 100', 'LIMIT 26')
  end

  it 'rejects unsupported task filter columns' do
    expect { repository.list_tasks(filters: { unsafe_sql: 'value' }) }
      .to raise_error(ArgumentError, /unsupported task filter/)
  end

  it 'combines per-status recovery scans into one bounded query' do
    connection = double('mysql connection')
    captured_sql = nil
    allow(connection).to receive(:escape) { |value| value.to_s }
    allow(connection).to receive(:query) do |sql|
      captured_sql = sql
      []
    end
    recovery_repository = described_class.new(connection: connection)

    recovery_repository.stuck_tasks_by_status(
      status_cutoffs: { 'FILLED' => Time.utc(2026, 7, 16), 'SETTLED' => Time.utc(2026, 7, 16) },
      per_status_limit: 25
    )

    expect(captured_sql.scan('SELECT * FROM liquidation_tasks').length).to eq(2)
    expect(captured_sql).to include('UNION ALL', 'LIMIT 50')
  end

  it 'retries transient MySQL lock errors while claiming a task' do
    error = Class.new(StandardError) do
      attr_reader :error_number

      def initialize(error_number)
        @error_number = error_number
        super("mysql error #{error_number}")
      end
    end.new(1213)
    attempts = 0

    result = repository.send(:with_claim_transaction_retry) do
      attempts += 1
      raise error if attempts < 3

      :claimed
    end

    expect(result).to eq(:claimed)
    expect(attempts).to eq(3)
  end

  it 'does not retry non-lock database errors' do
    attempts = 0

    expect do
      repository.send(:with_claim_transaction_retry) do
        attempts += 1
        raise StandardError, 'broken query'
      end
    end.to raise_error(StandardError, 'broken query')
    expect(attempts).to eq(1)
  end
end
