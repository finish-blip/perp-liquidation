# frozen_string_literal: true

require 'json'
require 'json_schemer'
require 'yaml'

describe 'Machine-readable cross-module contracts' do
  critical_http_paths = [
    '/health',
    '/api/v1/internal/liquidation/commands',
    '/api/v1/internal/liquidation/portfolio-plans',
    '/api/v1/internal/liquidation/operator-actions',
    '/api/v1/internal/liquidation/events/orders',
    '/api/v1/internal/liquidation/events/settlements',
    '/api/v1/internal/liquidation/events/adl-settlements'
  ].freeze

  let(:root) { File.expand_path('../..', __dir__) }
  let(:contracts_root) { File.join(root, 'contracts') }
  let(:manifest) { JSON.parse(File.read(File.join(contracts_root, 'manifest.json'))) }

  def each_node(value, &block)
    yield value
    case value
    when Hash
      value.each_value { |child| each_node(child, &block) }
    when Array
      value.each { |child| each_node(child, &block) }
    end
  end

  it 'validates every executable event example against its declared schema' do
    manifest.fetch('events').each do |event|
      schema_path = File.join(contracts_root, event.fetch('schema'))
      schemer = JSONSchemer.schema(JSON.parse(File.read(schema_path)))

      event.fetch('examples').each do |relative_example|
        example = JSON.parse(File.read(File.join(contracts_root, relative_example)))
        errors = schemer.validate(example).to_a
        expect(example.fetch('schema_version')).to eq(event.fetch('schema_version'))
        expect(errors).to be_empty, "#{relative_example}: #{errors.inspect}"
      end
    end
  end

  it 'keeps schema identifiers unique' do
    identifiers = manifest.fetch('events').map do |event|
      schema = JSON.parse(File.read(File.join(contracts_root, event.fetch('schema'))))
      schema.fetch('$id')
    end

    expect(identifiers.uniq).to eq(identifiers)
  end

  it 'declares exactly the event topics consumed by the router' do
    inbound_topics = manifest.fetch('events').select { |event| event.fetch('direction') == 'inbound' }
                             .map { |event| event.fetch('topic') }

    expect(inbound_topics).to match_array(PerpLiquidation::Messaging::EventRouter::TOPICS)
  end

  it 'declares the liquidation result as the owned outbound event' do
    outbound_topics = manifest.fetch('events').select { |event| event.fetch('direction') == 'outbound' }
                              .map { |event| event.fetch('topic') }

    expect(outbound_topics).to eq(['liquidation.execution.result'])
  end

  it 'loads OpenAPI with unique operation identifiers and resolvable external references' do
    openapi_path = File.join(contracts_root, manifest.fetch('openapi'))
    document = YAML.load(File.read(openapi_path))
    operation_ids = []
    missing_references = []

    each_node(document) do |node|
      next unless node.is_a?(Hash)

      operation_ids << node['operationId'] if node.key?('operationId')
      reference = node['$ref']
      next unless reference && !reference.start_with?('#')

      relative_file = reference.split('#', 2).first
      resolved = File.expand_path(relative_file, File.dirname(openapi_path))
      missing_references << reference unless File.file?(resolved)
    end

    expect(document.fetch('openapi')).to eq('3.1.0')
    expect(document.fetch('paths').keys).to include(*critical_http_paths)
    expect(operation_ids).not_to be_empty
    expect(operation_ids.uniq).to eq(operation_ids)
    expect(missing_references).to be_empty
  end

  it 'accepts command examples through the domain contract as well as JSON Schema' do
    risk_payload = JSON.parse(File.read(File.join(contracts_root, 'examples/risk-liquidation-command-v1.json')))
    portfolio_payload = JSON.parse(
      File.read(File.join(contracts_root, 'examples/risk-liquidation-portfolio-command-v2.json'))
    )

    expect(PerpLiquidation::LiquidationCommand.from_hash(risk_payload).schema_version).to eq(1)
    expect(PerpLiquidation::PortfolioLiquidationCommand.from_hash(portfolio_payload).schema_version).to eq(2)
  end
end
