# frozen_string_literal: true

module PerpLiquidation
  class FakePositionClient
    def initialize(positions = [])
      @positions = {}
      @settlements = {}
      positions.each { |position| put(position) }
    end

    def put(position)
      @positions[position.position_id.to_s] = position
    end

    def find(position_id:)
      @positions.fetch(position_id.to_s) { raise PreconditionsFailed, "position #{position_id} not found" }
    end

    def put_settlement(order_id:, position_id:, position_version:, account_version: nil, settled: true)
      @settlements[order_id.to_s] = {
        order_id: order_id,
        position_id: position_id,
        settled: settled,
        position_version: Integer(position_version),
        account_version: account_version.nil? ? nil : Integer(account_version)
      }
    end

    def find_settlement(order_id:)
      @settlements[order_id.to_s]
    end
  end
end
