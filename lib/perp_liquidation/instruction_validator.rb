# frozen_string_literal: true

module PerpLiquidation
  class InstructionValidator
    def initialize(repository:, clock: -> { Time.now.utc })
      @repository = repository
      @clock = clock
    end

    def validate!(task, position: nil)
      raise InstructionExpired, "decision #{task.risk_decision_id} expired" if task.expire_at <= @clock.call

      latest_sequence = @repository.latest_sequence(task.risk_unit_id)
      if latest_sequence && task.decision_sequence < latest_sequence
        raise StaleDecision, "decision sequence #{task.decision_sequence} is older than #{latest_sequence}"
      end

      return true unless task.position_action?

      raise PreconditionsFailed, 'position is required for position action' unless position
      assert_equal!('position_id', task.position_id.to_s, position.position_id.to_s)
      expected_position_version = task.settled_position_version || task.position_version
      validate_position_version!(task, position, expected_position_version)
      assert_equal!('user_id', task.user_id.to_s, position.user_id.to_s)
      assert_equal!('account_id', task.account_id.to_s, position.account_id.to_s)
      assert_equal!('symbol', task.symbol, position.symbol)
      assert_equal!('position_side', task.position_side, position.side)
      if task.quantity_mode == 'EXACT' && !position.size.positive?
        raise PreconditionsFailed, 'position is already closed'
      end
      raise PreconditionsFailed, 'reduce_only must be true' unless task.reduce_only == true
      if task.target_quantity > task.max_executable_quantity
        raise PreconditionsFailed, 'target quantity exceeds authorized maximum'
      end
      if task.quantity_mode == 'EXACT'
        step = @repository.next_execution_step(task.task_id)
        executable_quantity = step ? step.remaining_quantity : task.target_quantity
        if executable_quantity > position.size
          raise PreconditionsFailed, 'next execution step exceeds current position size'
        end
      end

      true
    end

    private

    def validate_position_version!(task, position, expected_position_version)
      if task.quantity_mode == 'EXACT'
        assert_equal!('position_version', expected_position_version, position.version)
        return
      end

      if position.version < expected_position_version
        raise PreconditionsFailed,
              "position_version regressed: expected at least #{expected_position_version}, got #{position.version}"
      end
      snapshot = @repository.risk_snapshot_for(task.task_id) || {}
      snapshot_size = value(snapshot, :position_size)
      raise PreconditionsFailed, 'UP_TO requires risk_snapshot.position_size' unless snapshot_size

      authorized_size = BigDecimal(snapshot_size.to_s)
      if position.size > authorized_size
        raise PreconditionsFailed,
              "current position size #{position.size.to_s('F')} exceeds authorized snapshot #{authorized_size.to_s('F')}"
      end
    end

    def value(hash, key)
      hash.key?(key) ? hash[key] : hash[key.to_s]
    end

    def assert_equal!(field, expected, actual)
      return if expected == actual

      raise PreconditionsFailed, "#{field} mismatch: expected #{expected.inspect}, got #{actual.inspect}"
    end
  end
end
