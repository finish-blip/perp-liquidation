# frozen_string_literal: true

require_relative '../../contracts/support/compatibility_checker'

describe PerpLiquidation::Contracts::CompatibilityChecker do
  def compatibility_errors(previous, current)
    described_class.compare_documents(previous, current)
  end

  let(:base_schema) do
    {
      'type' => 'object',
      'required' => ['id'],
      'properties' => {
        'id' => { 'type' => 'string' },
        'status' => { 'type' => 'string', 'enum' => %w[PENDING COMPLETED] }
      }
    }
  end

  it 'allows an additive optional property' do
    current = Marshal.load(Marshal.dump(base_schema))
    current.fetch('properties')['trace_id'] = { 'type' => 'string' }

    expect(compatibility_errors(base_schema, current)).to be_empty
  end

  it 'rejects additions and removals in the required field set' do
    added = Marshal.load(Marshal.dump(base_schema)).merge('required' => %w[id status])
    removed = Marshal.load(Marshal.dump(base_schema)).merge('required' => [])

    expect(compatibility_errors(base_schema, added).join).to include('/required')
    expect(compatibility_errors(base_schema, removed).join).to include('/required')
  end

  it 'rejects enum changes' do
    current = Marshal.load(Marshal.dump(base_schema))
    current.fetch('properties').fetch('status')['enum'] << 'FAILED'

    expect(compatibility_errors(base_schema, current).join).to include('/enum')
  end

  it 'rejects property removal' do
    current = Marshal.load(Marshal.dump(base_schema))
    current.fetch('properties').delete('status')

    expect(compatibility_errors(base_schema, current).join).to include('property was removed')
  end
end
