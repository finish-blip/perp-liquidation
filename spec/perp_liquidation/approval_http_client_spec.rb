# frozen_string_literal: true

require 'json'

RSpec.describe PerpLiquidation::ApprovalHttpClient do
  Request = Struct.new(:headers, :body)
  Response = Struct.new(:status, :body)

  let(:now) { Time.utc(2026, 7, 16, 4, 0, 0) }
  let(:attributes) do
    {
      approval_id: 'approval-1', operation_id: 'operation-1', action: 'RECONCILE_TASK',
      target_type: 'TASK', target_id: 'liq-1', operator_id: 'operator-a',
      approver_id: 'operator-b', reason: 'recover task'
    }
  end

  it 'accepts only matching unexpired approval evidence' do
    connection = approval_connection(attributes.merge(approved: true, expires_at: (now + 60).iso8601))
    client = described_class.new(endpoint: 'http://approvals', connection: connection, clock: -> { now })

    evidence = client.verify!(attributes)

    expect(evidence.fetch('approval_id')).to eq('approval-1')
  end

  it 'rejects approval evidence for a different target' do
    response = attributes.merge(approved: true, target_id: 'liq-other', expires_at: (now + 60).iso8601)
    client = described_class.new(
      endpoint: 'http://approvals', connection: approval_connection(response), clock: -> { now }
    )

    expect { client.verify!(attributes) }
      .to raise_error(PerpLiquidation::PreconditionsFailed, /target_id mismatch/)
  end

  def approval_connection(response_data)
    Class.new do
      def initialize(response_data)
        @response_data = response_data
      end

      def post(_path)
        request = Request.new({}, nil)
        yield request
        Response.new(200, JSON.generate(data: @response_data))
      end
    end.new(response_data.transform_keys(&:to_s))
  end
end
