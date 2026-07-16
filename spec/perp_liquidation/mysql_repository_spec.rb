# frozen_string_literal: true

describe PerpLiquidation::MysqlRepository do
  let(:repository) { described_class.allocate }

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
