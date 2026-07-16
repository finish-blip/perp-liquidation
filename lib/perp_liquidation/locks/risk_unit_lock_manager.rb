# frozen_string_literal: true

require 'monitor'

module PerpLiquidation
  class RiskUnitLockManager
    def initialize
      @monitor = Monitor.new
      @owners = {}
      @tokens = Hash.new(0)
    end

    def with_lock(risk_unit_id:, owner:, on_renew: nil)
      token = acquire(risk_unit_id, owner)
      yield token
    ensure
      release(risk_unit_id, owner) if token
    end

    private

    def acquire(risk_unit_id, owner)
      @monitor.synchronize do
        current = @owners[risk_unit_id]
        raise PositionLocked, "risk unit #{risk_unit_id} is locked by #{current}" if current && current != owner

        @tokens[risk_unit_id] += 1
        @owners[risk_unit_id] = owner
        @tokens[risk_unit_id]
      end
    end

    def release(risk_unit_id, owner)
      @monitor.synchronize { @owners.delete(risk_unit_id) if @owners[risk_unit_id] == owner }
    end
  end
end
