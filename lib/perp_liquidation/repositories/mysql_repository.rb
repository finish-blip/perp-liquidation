# frozen_string_literal: true

require 'json'
require 'time'

module PerpLiquidation
  class MysqlRepository
    CLAIM_CANDIDATE_LIMIT = 20
    CLAIM_TRANSACTION_MAX_ATTEMPTS = 4
    RETRYABLE_MYSQL_LOCK_ERROR_NUMBERS = [1205, 1213].freeze

    TaskEvent = Struct.new(:task_id, :event_type, :payload, :external_event_id, :created_at, keyword_init: true)
    PortfolioPlanEvent = Struct.new(:plan_id, :event_type, :payload, :created_at, keyword_init: true)
    OperatorAction = Struct.new(
      :operation_id, :action, :target_type, :target_id, :operator_id, :approver_id,
      :approval_id, :reason, :status, :result, :created_at, :completed_at,
      keyword_init: true
    )
    OutboxEvent = Struct.new(
      :id, :event_id, :task_id, :topic, :payload, :attempt_count, :next_attempt_at,
      :last_error, :locked_by, :locked_until, :dead_lettered_at,
      :published_at, :created_at,
      keyword_init: true
    )

    TASK_COLUMNS = Liquidation::ATTRIBUTES.freeze

    def initialize(connection: nil, connection_pool: nil)
      if connection && connection_pool
        raise ArgumentError, 'provide either connection or connection_pool, not both'
      end
      raise ArgumentError, 'connection or connection_pool is required' unless connection || connection_pool

      @connection_pool = connection_pool || SingleMysqlConnectionPool.new(connection)
      @transaction_context_key = :"perp_liquidation_mysql_transaction_#{object_id}"
    end

    def with_connection(&block)
      @connection_pool.with_connection(&block)
    end

    def create_from_command!(command)
      existing = find_by_risk_decision_id(command.risk_decision_id)
      return existing if existing

      task = build_task(command)
      plan = command.position_action? ? ExecutionPlanner.new(command).plan(task_id: task.task_id) : nil
      transaction do
        insert_task!(task)
        plan&.steps&.each { |step| insert_execution_step!(step) }
        execute(<<~SQL)
          INSERT INTO liquidation_risk_snapshots
            (task_id, risk_decision_id, source, payload, created_at)
          VALUES
            (#{quote(task.task_id)}, #{quote(task.risk_decision_id)}, 'risk-system',
             #{quote_json(command.risk_snapshot)}, #{quote(Time.now.utc)})
        SQL
        insert_inbox!(command.risk_decision_id, 'risk.liquidation.command')
        insert_event!(task, 'COMMAND_RECEIVED', command.snapshot, command.risk_decision_id)
        insert_event!(task, 'EXECUTION_PLAN_CREATED', plan.steps.map(&:snapshot)) if plan
      end
      task
    rescue StandardError => e
      concurrent = find_by_risk_decision_id(command.risk_decision_id)
      return concurrent if concurrent

      raise e
    end

    def transition!(task, status, event_type, payload = {})
      transaction do
        row = first("SELECT status FROM liquidation_tasks WHERE task_id = #{quote(task.task_id)} FOR UPDATE")
        raise NotFound, "liquidation task #{task.task_id} not found" unless row

        database_status = value(row, :status)
        if database_status != task.status
          raise InvalidTransition, "task #{task.task_id} database status is #{database_status}, object status is #{task.status}"
        end

        from_status = task.status
        task.transition_to!(status)
        persist_task!(task)
        insert_event!(task, event_type, payload.merge(from_status: from_status, to_status: status))
      end
      task
    end

    def append_event!(task, event_type, payload = {}, options = {})
      external_event_id = options[:external_event_id]
      return nil if external_event_id && inbox_processed?(external_event_id)

      transaction do
        insert_inbox!(external_event_id, event_type) if external_event_id
        insert_event!(task, event_type, payload, external_event_id)
      end
    rescue StandardError => e
      return nil if external_event_id && inbox_processed?(external_event_id)

      raise e
    end

    def inbox_processed?(event_id)
      !!first("SELECT 1 FROM liquidation_inbox_events WHERE external_event_id = #{quote(event_id)} LIMIT 1")
    end

    def with_transaction(&block)
      transaction(&block)
    end

    def with_portfolio_scope_admission!(risk_unit_id:, decision_sequence:, risk_decision_id:)
      transaction do
        now = Time.now.utc
        execute(<<~SQL)
          INSERT INTO liquidation_portfolio_scope_controls (risk_unit_id, updated_at)
          VALUES (#{quote(risk_unit_id)}, #{quote(now)})
          ON DUPLICATE KEY UPDATE updated_at = updated_at
        SQL
        first(<<~SQL)
          SELECT risk_unit_id FROM liquidation_portfolio_scope_controls
          WHERE risk_unit_id = #{quote(risk_unit_id)}
          FOR UPDATE
        SQL

        existing = find_portfolio_plan_by_risk_decision_id(risk_decision_id)
        next existing if existing

        latest = latest_portfolio_sequence(risk_unit_id)
        if latest && decision_sequence <= latest
          raise StaleDecision, "portfolio decision sequence #{decision_sequence} is not newer than #{latest}"
        end
        active = active_portfolio_plan_for_scope(risk_unit_id)
        if active
          raise PreconditionsFailed,
                "portfolio risk unit #{risk_unit_id} already has active plan #{active.plan_id}"
        end

        result = yield
        execute(<<~SQL)
          UPDATE liquidation_portfolio_scope_controls
          SET updated_at = #{quote(Time.now.utc)}
          WHERE risk_unit_id = #{quote(risk_unit_id)}
        SQL
        result
      end
    end

    def with_inbox_event!(event_id, topic)
      return nil if inbox_processed?(event_id)

      transaction do
        insert_inbox!(event_id, topic)
        yield
      end
    rescue StandardError => e
      return nil if inbox_processed?(event_id)

      raise e
    end

    def create_portfolio_plan!(command)
      existing = find_portfolio_plan_by_risk_decision_id(command.risk_decision_id)
      return existing if existing

      plan = PortfolioLiquidationPlan.new(
        plan_id: command.plan_id,
        risk_decision_id: command.risk_decision_id,
        risk_unit_id: command.risk_unit_id,
        decision_sequence: command.decision_sequence,
        action: command.action,
        user_id: command.user_id,
        account_id: command.account_id,
        account_version: command.account_version,
        margin_mode: command.margin_mode,
        execution_priority: command.execution_priority,
        max_total_authorized_notional: command.max_total_authorized_notional,
        failure_mode: command.failure_mode,
        status: 'RECEIVED',
        item_count: command.items.length,
        completed_item_count: 0,
        expire_at: command.expire_at,
        created_at: command.created_at
      )
      transaction do
        execute(<<~SQL)
          INSERT INTO liquidation_portfolio_plans
            (plan_id, risk_decision_id, risk_unit_id, decision_sequence, action, user_id,
             account_id, account_version, current_account_version, margin_mode, execution_priority,
             max_total_authorized_notional, failure_mode, status, current_item_sequence,
             item_count, completed_item_count, error_code, error_message, raw_payload,
             expire_at, created_at, updated_at, completed_at)
          VALUES
            (#{quote(plan.plan_id)}, #{quote(plan.risk_decision_id)}, #{quote(plan.risk_unit_id)},
             #{quote(plan.decision_sequence)}, #{quote(plan.action)}, #{quote(plan.user_id)},
             #{quote(plan.account_id)}, #{quote(plan.account_version)}, #{quote(plan.current_account_version)}, #{quote(plan.margin_mode)},
             #{quote(plan.execution_priority)}, #{quote(plan.max_total_authorized_notional)},
             #{quote(plan.failure_mode)}, #{quote(plan.status)}, NULL, #{quote(plan.item_count)},
             0, NULL, NULL, #{quote_json(command.raw_payload)}, #{quote(plan.expire_at)},
             #{quote(plan.created_at)}, #{quote(plan.updated_at)}, NULL)
        SQL
        insert_inbox!(command.risk_decision_id, 'risk.liquidation.portfolio.command')
        append_portfolio_plan_event!(plan, 'PORTFOLIO_COMMAND_RECEIVED', command.snapshot)
      end
      plan
    end

    def create_portfolio_plan_item!(plan, task:, item:, status:)
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_portfolio_plan_items
          (plan_id, item_sequence, task_id, position_id, symbol, authorized_notional,
           status, result_payload, created_at, updated_at, completed_at)
        VALUES
          (#{quote(plan.plan_id)}, #{quote(item.fetch(:item_sequence))}, #{quote(task.task_id)},
           #{quote(item.fetch(:position_id))}, #{quote(item.fetch(:symbol))},
           #{quote(item.fetch(:authorized_notional))}, #{quote(status)}, NULL,
           #{quote(now)}, #{quote(now)}, NULL)
      SQL
      portfolio_plan_item_for_task(task.task_id)
    end

    def find_portfolio_plan!(plan_id)
      row = first("SELECT * FROM liquidation_portfolio_plans WHERE plan_id = #{quote(plan_id)} LIMIT 1")
      raise NotFound, "portfolio liquidation plan #{plan_id} not found" unless row

      hydrate_portfolio_plan(row)
    end

    def find_portfolio_plan_by_risk_decision_id(risk_decision_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_portfolio_plans
        WHERE risk_decision_id = #{quote(risk_decision_id)}
        LIMIT 1
      SQL
      row && hydrate_portfolio_plan(row)
    end

    def latest_portfolio_sequence(risk_unit_id)
      row = first(<<~SQL)
        SELECT MAX(decision_sequence) AS latest_sequence
        FROM liquidation_portfolio_plans
        WHERE risk_unit_id = #{quote(risk_unit_id)}
      SQL
      latest = row && value(row, :latest_sequence)
      latest.nil? ? nil : Integer(latest)
    end

    def active_portfolio_plan_for_scope(risk_unit_id)
      terminal = PortfolioLiquidationPlan::TERMINAL_STATUSES.map { |status| quote(status) }.join(', ')
      row = first(<<~SQL)
        SELECT * FROM liquidation_portfolio_plans
        WHERE risk_unit_id = #{quote(risk_unit_id)}
          AND status NOT IN (#{terminal})
        ORDER BY decision_sequence ASC
        LIMIT 1
      SQL
      row && hydrate_portfolio_plan(row)
    end

    def portfolio_plan_items_for(plan_id)
      rows(<<~SQL).map { |row| hydrate_portfolio_plan_item(row) }
        SELECT * FROM liquidation_portfolio_plan_items
        WHERE plan_id = #{quote(plan_id)}
        ORDER BY item_sequence ASC
      SQL
    end

    def portfolio_plan_item_for_task(task_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_portfolio_plan_items
        WHERE task_id = #{quote(task_id)}
        LIMIT 1
      SQL
      row && hydrate_portfolio_plan_item(row)
    end

    def update_portfolio_plan!(plan)
      plan.updated_at = Time.now.utc
      execute(<<~SQL)
        UPDATE liquidation_portfolio_plans
        SET status = #{quote(plan.status)}, current_item_sequence = #{quote(plan.current_item_sequence)},
            current_account_version = #{quote(plan.current_account_version)},
            completed_item_count = #{quote(plan.completed_item_count)},
            error_code = #{quote(plan.error_code)}, error_message = #{quote(plan.error_message)},
            updated_at = #{quote(plan.updated_at)}, completed_at = #{quote(plan.completed_at)}
        WHERE plan_id = #{quote(plan.plan_id)}
      SQL
      plan
    end

    def update_portfolio_plan_item!(item)
      item.updated_at = Time.now.utc
      execute(<<~SQL)
        UPDATE liquidation_portfolio_plan_items
        SET status = #{quote(item.status)}, result_payload = #{quote_json(item.result)},
            updated_at = #{quote(item.updated_at)}, completed_at = #{quote(item.completed_at)}
        WHERE plan_id = #{quote(item.plan_id)} AND item_sequence = #{quote(item.item_sequence)}
      SQL
      item
    end

    def append_portfolio_plan_event!(plan, event_type, payload = {})
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_portfolio_plan_events (plan_id, event_type, payload, created_at)
        VALUES (#{quote(plan.plan_id)}, #{quote(event_type)}, #{quote_json(payload)}, #{quote(now)})
      SQL
      PortfolioPlanEvent.new(plan_id: plan.plan_id, event_type: event_type, payload: payload, created_at: now)
    end

    def portfolio_plan_events_for(plan_id)
      event_rows = rows(<<~SQL)
        SELECT * FROM liquidation_portfolio_plan_events
        WHERE plan_id = #{quote(plan_id)}
        ORDER BY id ASC
      SQL
      event_rows.map do |row|
        PortfolioPlanEvent.new(
          plan_id: value(row, :plan_id),
          event_type: value(row, :event_type),
          payload: parse_json(value(row, :payload)),
          created_at: value(row, :created_at)
        )
      end
    end

    def create_operator_action!(attributes)
      existing = operator_action(attributes.fetch(:operation_id))
      return existing if existing

      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_operator_actions
          (operation_id, action, target_type, target_id, operator_id, approver_id,
           approval_id, reason, status, result_payload, created_at, completed_at)
        VALUES
          (#{quote(attributes.fetch(:operation_id))}, #{quote(attributes.fetch(:action))},
           #{quote(attributes.fetch(:target_type))}, #{quote(attributes.fetch(:target_id))},
           #{quote(attributes.fetch(:operator_id))}, #{quote(attributes.fetch(:approver_id))},
           #{quote(attributes.fetch(:approval_id))}, #{quote(attributes.fetch(:reason))},
           'PENDING', #{quote_json({})}, #{quote(now)}, NULL)
      SQL
      operator_action(attributes.fetch(:operation_id))
    end

    def complete_operator_action!(action, status:, result:)
      completed_at = Time.now.utc
      execute(<<~SQL)
        UPDATE liquidation_operator_actions
        SET status = #{quote(status)}, result_payload = #{quote_json(result)},
            completed_at = #{quote(completed_at)}
        WHERE operation_id = #{quote(action.operation_id)}
      SQL
      operator_action(action.operation_id)
    end

    def operator_action(operation_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_operator_actions
        WHERE operation_id = #{quote(operation_id)}
        LIMIT 1
      SQL
      return nil unless row

      attributes = symbolize(row)
      attributes[:result] = parse_json(attributes.delete(:result_payload))
      OperatorAction.new(**attributes)
    end

    def latest_sequence(risk_unit_id)
      row = first(<<~SQL)
        SELECT MAX(decision_sequence) AS latest_sequence
        FROM liquidation_tasks
        WHERE risk_unit_id = #{quote(risk_unit_id)}
      SQL
      latest = row && value(row, :latest_sequence)
      latest.nil? ? nil : Integer(latest)
    end

    def active_for_risk_unit(risk_unit_id)
      terminal = Liquidation::TERMINAL_STATUSES.map { |status| quote(status) }.join(', ')
      rows(<<~SQL).map { |row| hydrate_task(row) }
        SELECT * FROM liquidation_tasks
        WHERE risk_unit_id = #{quote(risk_unit_id)}
          AND status NOT IN (#{terminal})
        ORDER BY decision_sequence ASC
      SQL
    end

    def claim_next_task!(worker_id: 'mysql-worker', lease_seconds: 30, priority_aging_seconds: 30)
      candidate_ids = rows(<<~SQL).map { |row| value(row, :task_id) }
          SELECT task_id FROM liquidation_tasks
          WHERE status = 'PENDING'
             OR (status = 'RETRY_WAIT' AND (next_retry_at IS NULL OR next_retry_at <= UTC_TIMESTAMP(6)))
             OR (status IN ('CLAIMED', 'LOCKING', 'VALIDATING', 'EXECUTING') AND claim_expires_at <= UTC_TIMESTAMP(6))
          ORDER BY GREATEST(
                     0,
                     priority - FLOOR(
                       TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) / #{quote(priority_aging_seconds)}
                     )
                   ) ASC,
                   created_at ASC,
                   task_id ASC
          LIMIT #{CLAIM_CANDIDATE_LIMIT}
        SQL

      candidate_ids.each do |task_id|
        task = with_claim_transaction_retry do
          claim_candidate!(
            task_id,
            worker_id: worker_id,
            lease_seconds: lease_seconds
          )
        end
        return task if task
      end

      nil
    end

    def active_order_count_for_symbol(symbol, excluding_task_id: nil)
      statuses = %w[ORDER_SUBMITTING ORDER_ACCEPTED PARTIALLY_FILLED FILLED SETTLEMENT_PENDING]
                 .map { |status| quote(status) }.join(', ')
      exclusion = excluding_task_id ? "AND task_id <> #{quote(excluding_task_id)}" : ''
      row = first(<<~SQL)
        SELECT COUNT(*) AS active_count
        FROM liquidation_tasks
        WHERE symbol = #{quote(symbol)}
          AND status IN (#{statuses})
          #{exclusion}
      SQL
      Integer(value(row, :active_count))
    end

    def heartbeat_worker!(worker_id:, worker_type:, lease_seconds:, metadata: {})
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_worker_leases
          (worker_id, worker_type, lease_expires_at, metadata, updated_at)
        VALUES
          (#{quote(worker_id)}, #{quote(worker_type)}, #{quote(now + lease_seconds)},
           #{quote_json(metadata)}, #{quote(now)})
        ON DUPLICATE KEY UPDATE
          worker_type = VALUES(worker_type), lease_expires_at = VALUES(lease_expires_at),
          metadata = VALUES(metadata), updated_at = VALUES(updated_at)
      SQL
    end

    def attach_fencing_token!(task, token)
      task.fencing_token = token
      task.updated_at = Time.now.utc
      execute(<<~SQL)
        UPDATE liquidation_tasks
        SET fencing_token = #{quote(token)}, updated_at = #{quote(task.updated_at)}
        WHERE task_id = #{quote(task.task_id)}
      SQL
      append_event!(task, 'FENCING_TOKEN_ASSIGNED', fencing_token: token)
    end

    def acquire_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:, lease_seconds:)
      transaction do
        now = Time.now.utc
        row = first(<<~SQL)
          SELECT * FROM liquidation_risk_unit_leases
          WHERE risk_unit_id = #{quote(risk_unit_id)}
          FOR UPDATE
        SQL
        if row && value(row, :lease_expires_at) > now && value(row, :owner_task_id) != owner_task_id
          raise PositionLocked, "risk unit #{risk_unit_id} is leased by #{value(row, :owner_task_id)}"
        end

        previous_token = row ? Integer(value(row, :fencing_token)) : 0
        token = [Integer(fencing_token), previous_token + 1].max
        execute(<<~SQL)
          INSERT INTO liquidation_risk_unit_leases
            (risk_unit_id, owner_task_id, fencing_token, lease_expires_at, updated_at)
          VALUES
            (#{quote(risk_unit_id)}, #{quote(owner_task_id)}, #{quote(token)},
             #{quote(now + lease_seconds)}, #{quote(now)})
          ON DUPLICATE KEY UPDATE
            owner_task_id = VALUES(owner_task_id), fencing_token = VALUES(fencing_token),
            lease_expires_at = VALUES(lease_expires_at), updated_at = VALUES(updated_at)
        SQL
        token
      end
    end

    def renew_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:, lease_seconds:)
      with_connection do
        now = Time.now.utc
        execute(<<~SQL)
          UPDATE liquidation_risk_unit_leases
          SET lease_expires_at = #{quote(now + lease_seconds)}, updated_at = #{quote(now)}
          WHERE risk_unit_id = #{quote(risk_unit_id)}
            AND owner_task_id = #{quote(owner_task_id)}
            AND fencing_token = #{quote(fencing_token)}
            AND lease_expires_at > #{quote(now)}
        SQL
        raise PositionLocked, "risk unit #{risk_unit_id} lease was lost" unless affected_rows == 1

        true
      end
    end

    def release_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:)
      with_connection do
        now = Time.now.utc
        execute(<<~SQL)
          UPDATE liquidation_risk_unit_leases
          SET lease_expires_at = #{quote(now)}, updated_at = #{quote(now)}
          WHERE risk_unit_id = #{quote(risk_unit_id)}
            AND owner_task_id = #{quote(owner_task_id)}
            AND fencing_token = #{quote(fencing_token)}
        SQL
        affected_rows == 1
      end
    end

    def attach_order!(task, order_id:, execution:)
      transaction do
        task.order_id = order_id
        task.updated_at = Time.now.utc
        execute(<<~SQL)
          UPDATE liquidation_tasks
          SET order_id = #{quote(order_id)}, updated_at = #{quote(task.updated_at)}
          WHERE task_id = #{quote(task.task_id)}
        SQL
        now = Time.now.utc
        execute(<<~SQL)
          INSERT INTO liquidation_executions
            (task_id, execution_sequence, client_order_id, order_id, requested_quantity,
             executed_quantity, status, request_payload, response_payload, created_at, updated_at)
          VALUES
            (#{quote(task.task_id)}, #{quote(execution[:execution_sequence])},
             #{quote(execution[:client_order_id])}, #{quote(order_id)},
             #{quote(execution[:requested_quantity])}, #{quote(execution[:executed_quantity])},
             #{quote(execution[:status])}, #{quote_json(execution[:request])},
             #{quote_json(execution[:response])}, #{quote(now)}, #{quote(now)})
          ON DUPLICATE KEY UPDATE
            order_id = VALUES(order_id), response_payload = VALUES(response_payload), updated_at = VALUES(updated_at)
        SQL
        insert_event!(task, 'ORDER_ATTACHED', execution)
      end
    end

    def execution_plan_for(task_id)
      rows(<<~SQL).map { |row| hydrate_execution_step(row) }
        SELECT * FROM liquidation_execution_steps
        WHERE task_id = #{quote(task_id)}
        ORDER BY step_sequence ASC
      SQL
    end

    def execution_step(task_id, step_sequence)
      row = first(<<~SQL)
        SELECT * FROM liquidation_execution_steps
        WHERE task_id = #{quote(task_id)} AND step_sequence = #{quote(step_sequence)}
        LIMIT 1
      SQL
      raise NotFound, "execution step #{task_id}/#{step_sequence} not found" unless row

      hydrate_execution_step(row)
    end

    def next_execution_step(task_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_execution_steps
        WHERE task_id = #{quote(task_id)} AND status NOT IN ('SETTLED', 'SKIPPED')
        ORDER BY step_sequence ASC
        LIMIT 1
      SQL
      row && hydrate_execution_step(row)
    end

    def cap_execution_plan!(task, max_remaining_quantity:)
      transaction do
        remaining = BigDecimal(max_remaining_quantity.to_s)
        raise InvalidCommand, 'max remaining quantity cannot be negative' if remaining.negative?

        plan_rows = rows(<<~SQL)
          SELECT * FROM liquidation_execution_steps
          WHERE task_id = #{quote(task.task_id)} AND status NOT IN ('SETTLED', 'SKIPPED')
          ORDER BY step_sequence ASC
          FOR UPDATE
        SQL
        allocated = BigDecimal('0')
        plan_rows.each do |row|
          step = hydrate_execution_step(row)
          unless step.status == 'PLANNED'
            raise ManualReviewRequired, "cannot cap execution step #{step.step_sequence} in #{step.status}"
          end

          allocation = [step.remaining_quantity, remaining].min
          now = Time.now.utc
          if allocation.positive?
            execute(<<~SQL)
              UPDATE liquidation_execution_steps
              SET quantity = #{quote(step.executed_quantity + allocation)}, updated_at = #{quote(now)}
              WHERE task_id = #{quote(task.task_id)} AND step_sequence = #{quote(step.step_sequence)}
            SQL
            remaining -= allocation
            allocated += allocation
          else
            execute(<<~SQL)
              UPDATE liquidation_execution_steps
              SET status = 'SKIPPED', completed_at = #{quote(now)}, updated_at = #{quote(now)}
              WHERE task_id = #{quote(task.task_id)} AND step_sequence = #{quote(step.step_sequence)}
            SQL
          end
        end
        insert_event!(
          task,
          'EXECUTION_PLAN_CAPPED',
          max_remaining_quantity: max_remaining_quantity.to_s('F'),
          allocated_quantity: allocated.to_s('F')
        )
        allocated
      end
    end

    def create_order_attempt!(step, attributes)
      attempt = OrderAttempt.new(attributes.merge(
        task_id: step.task_id,
        step_sequence: step.step_sequence
      ))
      transaction do
        execute(<<~SQL)
          INSERT INTO liquidation_order_attempts
            (task_id, step_sequence, attempt_sequence, client_order_id, requested_quantity,
             executed_quantity, status, request_payload, response_payload, created_at, updated_at)
          VALUES
            (#{quote(attempt.task_id)}, #{quote(attempt.step_sequence)}, #{quote(attempt.attempt_sequence)},
             #{quote(attempt.client_order_id)}, #{quote(attempt.requested_quantity)}, 0, 'SUBMITTING',
             #{quote_json(attempt.request)}, #{quote_json(attempt.response)},
             #{quote(attempt.created_at)}, #{quote(attempt.updated_at)})
          ON DUPLICATE KEY UPDATE client_order_id = client_order_id
        SQL
        execute(<<~SQL)
          UPDATE liquidation_execution_steps
          SET status = 'SUBMITTING', updated_at = #{quote(Time.now.utc)}
          WHERE task_id = #{quote(step.task_id)} AND step_sequence = #{quote(step.step_sequence)}
        SQL
      end
      current_order_attempt(step.task_id, step.step_sequence)
    end

    def attach_order_result!(task, step:, attempt:, result:)
      transaction do
        row = first(<<~SQL)
          SELECT * FROM liquidation_order_attempts
          WHERE client_order_id = #{quote(attempt.client_order_id)}
          FOR UPDATE
        SQL
        raise NotFound, "order attempt #{attempt.client_order_id} not found" unless row

        current = hydrate_order_attempt(row)
        disposition = current.update_disposition(
          status: result.status,
          executed_quantity: result.filled_quantity,
          event_sequence: result.event_sequence
        )
        unless disposition == :applied
          raise ManualReviewRequired, "initial order result cannot be #{disposition}"
        end

        execute(<<~SQL)
          UPDATE liquidation_order_attempts
          SET order_id = #{quote(result.order_id)}, status = #{quote(result.status)},
              executed_quantity = #{quote(result.filled_quantity)},
              average_price = #{quote(result.average_price)}, fee = #{quote(result.fee)},
              last_event_sequence = #{quote(result.event_sequence || current.last_event_sequence)},
              response_payload = #{quote_json(result.snapshot)}, updated_at = #{quote(Time.now.utc)}
          WHERE client_order_id = #{quote(attempt.client_order_id)}
        SQL
        task.order_id = result.order_id
        task.updated_at = Time.now.utc
        execute(<<~SQL)
          UPDATE liquidation_tasks
          SET order_id = #{quote(task.order_id)}, updated_at = #{quote(task.updated_at)}
          WHERE task_id = #{quote(task.task_id)}
        SQL
        update_step_and_task_totals!(task, step, result.status, result.filled_quantity)
        write_legacy_execution!(task, step, attempt, result)
        insert_event!(task, 'ORDER_ATTEMPT_ATTACHED', result.snapshot.merge(
          step_sequence: step.step_sequence,
          attempt_sequence: attempt.attempt_sequence
        ))
      end
      order_attempt_for(task.task_id, client_order_id: attempt.client_order_id)
    end

    def update_order_attempt!(task, attempt:, status:, executed_quantity:, average_price: nil, fee: nil,
                              event_sequence: nil, response: {})
      transaction do
        row = first(<<~SQL)
          SELECT * FROM liquidation_order_attempts
          WHERE client_order_id = #{quote(attempt.client_order_id)}
          FOR UPDATE
        SQL
        raise NotFound, "order attempt #{attempt.client_order_id} not found" unless row

        current = hydrate_order_attempt(row)
        disposition = current.update_disposition(
          status: status,
          executed_quantity: executed_quantity,
          event_sequence: event_sequence
        )
        next :stale if disposition == :stale

        next_sequence = event_sequence || current.last_event_sequence
        if disposition == :status_regression
          execute(<<~SQL)
            UPDATE liquidation_order_attempts
            SET last_event_sequence = #{quote(next_sequence)}, response_payload = #{quote_json(response)},
                updated_at = #{quote(Time.now.utc)}
            WHERE client_order_id = #{quote(current.client_order_id)}
          SQL
          next :status_regression
        end

        execute(<<~SQL)
          UPDATE liquidation_order_attempts
          SET status = #{quote(status)}, executed_quantity = #{quote(executed_quantity)},
              average_price = #{quote(average_price)}, fee = #{quote(fee)},
              last_event_sequence = #{quote(next_sequence)},
              response_payload = #{quote_json(response)}, updated_at = #{quote(Time.now.utc)}
          WHERE client_order_id = #{quote(current.client_order_id)}
        SQL
        step = execution_step(task.task_id, current.step_sequence)
        update_step_and_task_totals!(task, step, status, executed_quantity)
        refreshed = order_attempt_for(task.task_id, client_order_id: current.client_order_id)
        result = OrderResult.new(
          order_id: refreshed.order_id,
          client_order_id: refreshed.client_order_id,
          status: refreshed.status,
          filled_quantity: refreshed.executed_quantity,
          average_price: refreshed.average_price,
          fee: refreshed.fee,
          payload: response
        )
        write_legacy_execution!(task, step, refreshed, result)
        :applied
      end
    end

    def current_order_attempt(task_id, step_sequence)
      row = first(<<~SQL)
        SELECT * FROM liquidation_order_attempts
        WHERE task_id = #{quote(task_id)} AND step_sequence = #{quote(step_sequence)}
        ORDER BY attempt_sequence DESC
        LIMIT 1
      SQL
      row && hydrate_order_attempt(row)
    end

    def order_attempt_for(task_id, order_id: nil, client_order_id: nil)
      condition = if order_id
                    "order_id = #{quote(order_id)}"
                  elsif client_order_id
                    "client_order_id = #{quote(client_order_id)}"
                  else
                    raise ArgumentError, 'order_id or client_order_id is required'
                  end
      row = first(<<~SQL)
        SELECT * FROM liquidation_order_attempts
        WHERE task_id = #{quote(task_id)} AND #{condition}
        LIMIT 1
      SQL
      row && hydrate_order_attempt(row)
    end

    def order_attempts_for(task_id)
      rows(<<~SQL).map { |row| hydrate_order_attempt(row) }
        SELECT * FROM liquidation_order_attempts
        WHERE task_id = #{quote(task_id)}
        ORDER BY step_sequence ASC, attempt_sequence ASC
      SQL
    end

    def order_attempt_count(task_id)
      row = first(<<~SQL)
        SELECT COUNT(*) AS attempt_count
        FROM liquidation_order_attempts
        WHERE task_id = #{quote(task_id)}
      SQL
      Integer(value(row, :attempt_count))
    end

    def settle_execution_step!(task, step, position_version:)
      unless %w[FILLED PARTIAL_SETTLEMENT_PENDING].include?(step.status)
        raise InvalidTransition, "execution step #{step.step_sequence} is not awaiting settlement"
      end

      now = Time.now.utc
      completed = step.remaining_quantity.zero?
      next_status = completed ? 'SETTLED' : 'PLANNED'
      completed_at = completed ? quote(now) : 'NULL'
      event_type = completed ? 'EXECUTION_STEP_SETTLED' : 'CHILD_ORDER_SETTLED'
      transaction do
        execute(<<~SQL)
          UPDATE liquidation_execution_steps
          SET status = #{quote(next_status)}, completed_at = #{completed_at}, updated_at = #{quote(now)}
          WHERE task_id = #{quote(task.task_id)} AND step_sequence = #{quote(step.step_sequence)}
        SQL
        task.settled_position_version = position_version
        task.updated_at = now
        persist_task!(task)
        insert_event!(task, event_type, step.snapshot.merge(position_version: position_version))
      end
      execution_step(task.task_id, step.step_sequence)
    end

    def update_execution!(task, attributes)
      task.executed_quantity = attributes[:executed_quantity] if attributes.key?(:executed_quantity)
      task.average_price = attributes[:average_price] if attributes.key?(:average_price)
      task.fee = attributes[:fee] if attributes.key?(:fee)
      task.updated_at = Time.now.utc
      transaction do
        execute(<<~SQL)
          UPDATE liquidation_executions
          SET executed_quantity = #{quote(task.executed_quantity)},
              average_price = #{quote(task.average_price)}, fee = #{quote(task.fee)},
              updated_at = #{quote(task.updated_at)}
          WHERE task_id = #{quote(task.task_id)}
        SQL
        persist_task!(task)
      end
      execution_for(task.task_id)
    end

    def schedule_retry!(task, error, delay_seconds: 10)
      task.retry_count += 1
      task.next_retry_at = Time.now.utc + delay_seconds
      task.error_code = error.class.name.split('::').last
      task.error_message = error.message
      transition!(task, Liquidation::RETRY_WAIT, 'RETRY_SCHEDULED', error: task.error_code, message: error.message)
    end

    def find!(task_id)
      row = first("SELECT * FROM liquidation_tasks WHERE task_id = #{quote(task_id)} LIMIT 1")
      raise NotFound, "liquidation task #{task_id} not found" unless row

      hydrate_task(row)
    end

    def find_by_risk_decision_id(risk_decision_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_tasks
        WHERE risk_decision_id = #{quote(risk_decision_id)}
        LIMIT 1
      SQL
      row && hydrate_task(row)
    end

    def find_by_order_id!(order_id)
      row = first(<<~SQL)
        SELECT task.* FROM liquidation_tasks task
        LEFT JOIN liquidation_order_attempts attempt ON attempt.task_id = task.task_id
        WHERE task.order_id = #{quote(order_id)} OR attempt.order_id = #{quote(order_id)}
        LIMIT 1
      SQL
      raise NotFound, "liquidation order #{order_id} not found" unless row

      hydrate_task(row)
    end

    def all
      rows('SELECT * FROM liquidation_tasks ORDER BY id DESC').map { |row| hydrate_task(row) }
    end

    def stuck_tasks(statuses:, updated_before:, limit: 100)
      return [] if statuses.empty?

      status_values = statuses.map { |status| quote(status) }.join(', ')
      rows(<<~SQL).map { |row| hydrate_task(row) }
        SELECT * FROM liquidation_tasks
        WHERE status IN (#{status_values}) AND updated_at <= #{quote(updated_before)}
        ORDER BY updated_at ASC
        LIMIT #{Integer(limit)}
      SQL
    end

    def events_for(task_id)
      rows(<<~SQL).map do |row|
        SELECT * FROM liquidation_task_events
        WHERE task_id = #{quote(task_id)}
        ORDER BY id ASC
      SQL
        TaskEvent.new(
          task_id: value(row, :task_id),
          event_type: value(row, :event_type),
          external_event_id: value(row, :external_event_id),
          payload: parse_json(value(row, :payload)),
          created_at: value(row, :created_at)
        )
      end
    end

    def risk_snapshot_for(task_id)
      row = first("SELECT payload FROM liquidation_risk_snapshots WHERE task_id = #{quote(task_id)} LIMIT 1")
      row && parse_json(value(row, :payload))
    end

    def execution_for(task_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_executions
        WHERE task_id = #{quote(task_id)}
        ORDER BY execution_sequence DESC
        LIMIT 1
      SQL
      row && symbolize(row)
    end

    def enqueue_outbox!(task, topic:, payload:)
      event_id = payload[:event_id] || payload['event_id'] || "#{task.task_id}:#{topic}"
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_outbox_events
          (event_id, task_id, topic, payload, created_at)
        VALUES
          (#{quote(event_id)}, #{quote(task.task_id)}, #{quote(topic)}, #{quote_json(payload)}, #{quote(now)})
        ON DUPLICATE KEY UPDATE event_id = event_id
      SQL
      event_id
    end

    def pending_outbox
      rows(<<~SQL).map do |row|
        SELECT * FROM liquidation_outbox_events
        WHERE published_at IS NULL AND dead_lettered_at IS NULL
        ORDER BY id ASC
        LIMIT 100
      SQL
        hydrate_outbox_event(row)
      end
    end

    def claim_outbox_events!(worker_id:, limit: 100, lease_seconds: 30, now: Time.now.utc)
      transaction do
        candidates = rows(<<~SQL)
          SELECT * FROM liquidation_outbox_events
          WHERE published_at IS NULL
            AND dead_lettered_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= #{quote(now)})
            AND (locked_until IS NULL OR locked_until <= #{quote(now)})
          ORDER BY id ASC
          LIMIT #{Integer(limit)}
          FOR UPDATE
        SQL
        locked_until = now + lease_seconds
        candidates.each do |row|
          execute(<<~SQL)
            UPDATE liquidation_outbox_events
            SET locked_by = #{quote(worker_id)}, locked_until = #{quote(locked_until)}
            WHERE id = #{quote(value(row, :id))} AND published_at IS NULL
          SQL
        end
        candidates.map do |row|
          hydrated = hydrate_outbox_event(row)
          hydrated.locked_by = worker_id
          hydrated.locked_until = locked_until
          hydrated
        end
      end
    end

    def mark_outbox_published!(event)
      execute(<<~SQL)
        UPDATE liquidation_outbox_events
        SET published_at = UTC_TIMESTAMP(6), locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = #{quote(event.id)} AND published_at IS NULL
      SQL
    end

    def mark_outbox_failed!(event, error, max_attempts: 10, base_delay_seconds: 1)
      attempts = event.attempt_count.to_i + 1
      dead_lettered_at = attempts >= max_attempts ? Time.now.utc : nil
      delay = [base_delay_seconds * (2**(attempts - 1)), 300].min
      next_attempt_at = dead_lettered_at ? nil : Time.now.utc + delay
      execute(<<~SQL)
        UPDATE liquidation_outbox_events
        SET attempt_count = #{quote(attempts)}, next_attempt_at = #{quote(next_attempt_at)},
            last_error = #{quote(error.message.to_s[0, 1024])}, locked_by = NULL, locked_until = NULL,
            dead_lettered_at = #{quote(dead_lettered_at)}
        WHERE id = #{quote(event.id)} AND published_at IS NULL
      SQL
      event.attempt_count = attempts
      event.next_attempt_at = next_attempt_at
      event.last_error = error.message.to_s[0, 1024]
      event.dead_lettered_at = dead_lettered_at
      event
    end

    def outbox_for_task(task_id)
      row = first(<<~SQL)
        SELECT * FROM liquidation_outbox_events
        WHERE task_id = #{quote(task_id)}
        ORDER BY id DESC
        LIMIT 1
      SQL
      row && hydrate_outbox_event(row)
    end

    def dead_letter_outbox(limit: 100)
      rows(<<~SQL).map { |row| hydrate_outbox_event(row) }
        SELECT * FROM liquidation_outbox_events
        WHERE dead_lettered_at IS NOT NULL
        ORDER BY dead_lettered_at DESC
        LIMIT #{Integer(limit)}
      SQL
    end

    def replay_outbox_for_task!(task_id)
      with_connection do
        execute(<<~SQL)
          UPDATE liquidation_outbox_events
          SET published_at = NULL, attempt_count = 0, next_attempt_at = NULL,
              last_error = NULL, locked_by = NULL, locked_until = NULL, dead_lettered_at = NULL
          WHERE task_id = #{quote(task_id)}
        SQL
        affected_rows
      end
    end

    def record_reconciliation_issue!(task, issue_type:, expected_payload:, actual_payload:)
      with_connection do
        existing = first(<<~SQL)
          SELECT * FROM liquidation_reconciliation_issues
          WHERE task_id = #{quote(task.task_id)} AND issue_type = #{quote(issue_type)} AND status = 'OPEN'
          ORDER BY id DESC
          LIMIT 1
        SQL
        if existing
          execute(<<~SQL)
            UPDATE liquidation_reconciliation_issues
            SET expected_payload = #{quote_json(expected_payload)}, actual_payload = #{quote_json(actual_payload)}
            WHERE id = #{quote(value(existing, :id))}
          SQL
          next reconciliation_issue(value(existing, :id))
        end

        execute(<<~SQL)
          INSERT INTO liquidation_reconciliation_issues
            (task_id, issue_type, expected_payload, actual_payload, status, created_at)
          VALUES
            (#{quote(task.task_id)}, #{quote(issue_type)}, #{quote_json(expected_payload)},
             #{quote_json(actual_payload)}, 'OPEN', #{quote(Time.now.utc)})
        SQL
        reconciliation_issue(last_insert_id)
      end
    end

    def resolve_reconciliation_issues!(task_id, issue_type: nil)
      with_connection do
        type_condition = issue_type ? " AND issue_type = #{quote(issue_type)}" : ''
        execute(<<~SQL)
          UPDATE liquidation_reconciliation_issues
          SET status = 'RESOLVED', resolved_at = #{quote(Time.now.utc)}
          WHERE task_id = #{quote(task_id)} AND status = 'OPEN'#{type_condition}
        SQL
        affected_rows
      end
    end

    def reconciliation_issues(status: nil, task_id: nil)
      conditions = []
      conditions << "status = #{quote(status)}" if status
      conditions << "task_id = #{quote(task_id)}" if task_id
      where = conditions.empty? ? '' : "WHERE #{conditions.join(' AND ')}"
      rows(<<~SQL).map { |row| hydrate_reconciliation_issue(row) }
        SELECT * FROM liquidation_reconciliation_issues
        #{where}
        ORDER BY id DESC
        LIMIT 500
      SQL
    end

    def mark_reconciliation_checked!(task, issue_type:, outcome:)
      task.updated_at = Time.now.utc
      transaction do
        execute(<<~SQL)
          UPDATE liquidation_tasks
          SET updated_at = #{quote(task.updated_at)}
          WHERE task_id = #{quote(task.task_id)}
        SQL
        insert_event!(task, 'RECONCILIATION_CHECKED', issue_type: issue_type, outcome: outcome)
      end
    end

    def loss_mitigation_tasks(updated_before:, limit: 100)
      statuses = [
        Liquidation::BANKRUPTCY_CHECKING,
        Liquidation::INSURANCE_CLAIMING,
        Liquidation::ADL_REQUIRED,
        Liquidation::ADL_EXECUTING,
        Liquidation::ADL_SETTLEMENT_PENDING
      ].map { |status| quote(status) }.join(', ')
      rows(<<~SQL).map { |row| hydrate_task(row) }
        SELECT * FROM liquidation_tasks
        WHERE status IN (#{statuses}) AND updated_at <= #{quote(updated_before)}
        ORDER BY updated_at ASC
        LIMIT #{Integer(limit)}
      SQL
    end

    def record_bankruptcy_check!(task, result)
      data = symbolize(result)
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_bankruptcy_checks
          (task_id, check_id, status, bankruptcy_price, bankruptcy_loss, currency,
           response_payload, created_at, updated_at)
        VALUES
          (#{quote(task.task_id)}, #{quote(data[:check_id])}, #{quote(data[:status])},
           #{quote(data[:bankruptcy_price])}, #{quote(data[:bankruptcy_loss] || 0)},
           #{quote(data[:currency])}, #{quote_json(data)}, #{quote(now)}, #{quote(now)})
        ON DUPLICATE KEY UPDATE
          status = VALUES(status), bankruptcy_price = VALUES(bankruptcy_price),
          bankruptcy_loss = VALUES(bankruptcy_loss), currency = VALUES(currency),
          response_payload = VALUES(response_payload), updated_at = VALUES(updated_at)
      SQL
      bankruptcy_check_for(task.task_id)
    end

    def bankruptcy_check_for(task_id)
      row = first("SELECT * FROM liquidation_bankruptcy_checks WHERE task_id = #{quote(task_id)} LIMIT 1")
      row && mitigation_record(row)
    end

    def record_insurance_claim!(task, result)
      data = symbolize(result)
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_insurance_claims
          (task_id, claim_id, status, requested_amount, covered_amount, currency,
           response_payload, created_at, updated_at)
        VALUES
          (#{quote(task.task_id)}, #{quote(data[:claim_id])}, #{quote(data[:status])},
           #{quote(data[:requested_amount])}, #{quote(data[:covered_amount] || 0)},
           #{quote(data[:currency])}, #{quote_json(data)}, #{quote(now)}, #{quote(now)})
        ON DUPLICATE KEY UPDATE
          status = VALUES(status), requested_amount = VALUES(requested_amount),
          covered_amount = VALUES(covered_amount), currency = VALUES(currency),
          response_payload = VALUES(response_payload), updated_at = VALUES(updated_at)
      SQL
      insurance_claim_for(task.task_id)
    end

    def insurance_claim_for(task_id)
      row = first("SELECT * FROM liquidation_insurance_claims WHERE task_id = #{quote(task_id)} LIMIT 1")
      row && mitigation_record(row)
    end

    def record_adl_request!(task, result)
      data = symbolize(result)
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_adl_requests
          (task_id, adl_request_id, status, requested_amount, covered_amount, currency,
           response_payload, created_at, updated_at, settled_at)
        VALUES
          (#{quote(task.task_id)}, #{quote(data[:adl_request_id])}, #{quote(data[:status])},
           #{quote(data[:requested_amount])}, #{quote(data[:covered_amount] || 0)},
           #{quote(data[:currency])}, #{quote_json(data)}, #{quote(now)}, #{quote(now)}, NULL)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status), requested_amount = VALUES(requested_amount),
          covered_amount = VALUES(covered_amount), currency = VALUES(currency),
          response_payload = VALUES(response_payload), updated_at = VALUES(updated_at)
      SQL
      adl_request_for(task.task_id)
    end

    def adl_request_for(task_id)
      row = first("SELECT * FROM liquidation_adl_requests WHERE task_id = #{quote(task_id)} LIMIT 1")
      row && mitigation_record(row)
    end

    def update_adl_request!(task, result)
      data = symbolize(result)
      settled_at = data[:status] == 'COMPLETED' ? Time.now.utc : nil
      execute(<<~SQL)
        UPDATE liquidation_adl_requests
        SET status = #{quote(data[:status])}, covered_amount = #{quote(data[:covered_amount] || 0)},
            response_payload = #{quote_json(data)}, updated_at = #{quote(Time.now.utc)},
            settled_at = #{quote(settled_at)}
        WHERE task_id = #{quote(task.task_id)}
      SQL
      adl_request_for(task.task_id)
    end

    def loss_mitigation_summary(task_id)
      bankruptcy = bankruptcy_check_for(task_id) || {}
      insurance = insurance_claim_for(task_id) || {}
      adl = adl_request_for(task_id) || {}
      {
        bankruptcy_price: bankruptcy[:bankruptcy_price],
        bankruptcy_loss: bankruptcy[:bankruptcy_loss] || '0',
        insurance_fund_covered: insurance[:covered_amount] || '0',
        adl_triggered: !adl.empty?,
        adl_request_id: adl[:adl_request_id],
        adl_covered_amount: adl[:covered_amount] || '0'
      }
    end

    private

    def mitigation_record(row)
      data = symbolize(row)
      data[:response_payload] = parse_json(data[:response_payload])
      data
    end

    def reconciliation_issue(id)
      row = first("SELECT * FROM liquidation_reconciliation_issues WHERE id = #{quote(id)} LIMIT 1")
      row && hydrate_reconciliation_issue(row)
    end

    def hydrate_reconciliation_issue(row)
      attributes = symbolize(row)
      attributes[:expected_payload] = parse_json(attributes[:expected_payload])
      attributes[:actual_payload] = parse_json(attributes[:actual_payload])
      ReconciliationIssue.new(attributes)
    end

    def hydrate_outbox_event(row)
      OutboxEvent.new(
        id: value(row, :id), event_id: value(row, :event_id), task_id: value(row, :task_id),
        topic: value(row, :topic), payload: parse_json(value(row, :payload)),
        attempt_count: value(row, :attempt_count), next_attempt_at: value(row, :next_attempt_at),
        last_error: value(row, :last_error), locked_by: value(row, :locked_by),
        locked_until: value(row, :locked_until), dead_lettered_at: value(row, :dead_lettered_at),
        published_at: value(row, :published_at), created_at: value(row, :created_at)
      )
    end

    def affected_rows
      with_connection do |connection|
        connection.respond_to?(:affected_rows) ? connection.affected_rows : 0
      end
    end

    def last_insert_id
      with_connection do |connection|
        connection.respond_to?(:last_id) ? connection.last_id : first('SELECT LAST_INSERT_ID() AS id')['id']
      end
    end

    def insert_execution_step!(step)
      execute(<<~SQL)
        INSERT INTO liquidation_execution_steps
          (task_id, step_sequence, quantity, order_type, time_in_force, max_slippage,
           status, executed_quantity, created_at, updated_at, completed_at)
        VALUES
          (#{quote(step.task_id)}, #{quote(step.step_sequence)}, #{quote(step.quantity)},
           #{quote(step.order_type)}, #{quote(step.time_in_force)}, #{quote(step.max_slippage)},
           #{quote(step.status)}, #{quote(step.executed_quantity)}, #{quote(step.created_at)},
           #{quote(step.updated_at)}, #{quote(step.completed_at)})
      SQL
    end

    def update_step_and_task_totals!(task, step, attempt_status, attempt_executed_quantity)
      step_status = case attempt_status
                    when 'FILLED' then 'FILLED'
                    when 'ACCEPTED', 'PARTIALLY_FILLED' then 'WORKING'
                    when 'SUBMITTING' then 'SUBMITTING'
                    when 'REJECTED', 'CANCELLED'
                      BigDecimal(attempt_executed_quantity.to_s).positive? ? 'PARTIAL_SETTLEMENT_PENDING' : 'PLANNED'
                    else 'PLANNED'
                    end
      execute(<<~SQL)
        UPDATE liquidation_execution_steps
        SET status = #{quote(step_status)},
            executed_quantity = (
              SELECT COALESCE(SUM(executed_quantity), 0)
              FROM liquidation_order_attempts
              WHERE task_id = #{quote(task.task_id)} AND step_sequence = #{quote(step.step_sequence)}
            ),
            updated_at = #{quote(Time.now.utc)}
        WHERE task_id = #{quote(task.task_id)} AND step_sequence = #{quote(step.step_sequence)}
      SQL
      aggregate = first(<<~SQL)
        SELECT COALESCE(SUM(executed_quantity), 0) AS executed_quantity,
               CASE WHEN SUM(executed_quantity) > 0
                    THEN SUM(COALESCE(average_price, 0) * executed_quantity) / SUM(executed_quantity)
                    ELSE NULL END AS average_price,
               COALESCE(SUM(fee), 0) AS fee
        FROM liquidation_order_attempts
        WHERE task_id = #{quote(task.task_id)}
      SQL
      task.executed_quantity = value(aggregate, :executed_quantity)
      task.average_price = value(aggregate, :average_price)
      task.fee = value(aggregate, :fee)
      task.updated_at = Time.now.utc
      persist_task!(task)
    end

    def write_legacy_execution!(task, step, attempt, result)
      sequence = ((step.step_sequence - 1) * 1000) + attempt.attempt_sequence
      now = Time.now.utc
      execute(<<~SQL)
        INSERT INTO liquidation_executions
          (task_id, execution_sequence, client_order_id, order_id, requested_quantity,
           executed_quantity, average_price, fee, status, request_payload, response_payload,
           created_at, updated_at)
        VALUES
          (#{quote(task.task_id)}, #{quote(sequence)}, #{quote(attempt.client_order_id)},
           #{quote(result.order_id)}, #{quote(attempt.requested_quantity)},
           #{quote(result.filled_quantity)}, #{quote(result.average_price)}, #{quote(result.fee)},
           #{quote(result.status)}, #{quote_json(attempt.request)}, #{quote_json(result.snapshot)},
           #{quote(attempt.created_at)}, #{quote(now)})
        ON DUPLICATE KEY UPDATE
          order_id = VALUES(order_id), executed_quantity = VALUES(executed_quantity),
          average_price = VALUES(average_price), fee = VALUES(fee), status = VALUES(status),
          response_payload = VALUES(response_payload), updated_at = VALUES(updated_at)
      SQL
    end

    def hydrate_execution_step(row)
      ExecutionStep.new(symbolize(row))
    end

    def hydrate_order_attempt(row)
      attributes = symbolize(row)
      attributes[:request] = parse_json(attributes.delete(:request_payload))
      attributes[:response] = parse_json(attributes.delete(:response_payload))
      OrderAttempt.new(attributes)
    end

    def hydrate_portfolio_plan(row)
      attributes = symbolize(row)
      attributes.delete(:raw_payload)
      PortfolioLiquidationPlan.new(attributes)
    end

    def hydrate_portfolio_plan_item(row)
      attributes = symbolize(row)
      attributes[:result] = parse_json(attributes.delete(:result_payload))
      PortfolioPlanItem.new(attributes)
    end

    def build_task(command)
      Liquidation.new(
        task_id: "liq_#{command.risk_decision_id.to_s.gsub(/[^A-Za-z0-9_\-]/, '_')}",
        risk_decision_id: command.risk_decision_id,
        risk_unit_id: command.risk_unit_id,
        decision_sequence: command.decision_sequence,
        action: command.action,
        priority: command.execution_priority,
        user_id: command.user_id,
        account_id: command.account_id,
        position_id: command.position_id,
        position_version: command.position_version,
        symbol: command.symbol,
        position_side: command.position_side,
        target_quantity: command.target_quantity,
        max_executable_quantity: command.max_executable_quantity,
        quantity_mode: command.quantity_mode,
        order_type: command.order_type,
        reduce_only: command.reduce_only,
        time_in_force: command.time_in_force,
        max_slippage: command.max_slippage,
        bankruptcy_price: command.bankruptcy_price,
        max_liquidation_deviation: command.max_liquidation_deviation,
        quote_max_age_ms: command.quote_max_age_ms,
        execution_strategy: command.execution_strategy,
        execution_urgency: command.execution_urgency,
        max_child_orders: command.max_child_orders,
        max_child_quantity: command.max_child_quantity,
        min_child_quantity: command.min_child_quantity,
        max_book_participation: command.max_book_participation,
        child_order_cooldown_ms: command.child_order_cooldown_ms,
        child_order_timeout_ms: command.child_order_timeout_ms,
        execution_scope_id: command.execution_scope_id,
        portfolio_plan_id: command.portfolio_plan_id,
        plan_item_sequence: command.plan_item_sequence,
        authorized_notional: command.authorized_notional,
        expire_at: command.expire_at
      )
    end

    def insert_task!(task)
      columns = TASK_COLUMNS
      execute(<<~SQL)
        INSERT INTO liquidation_tasks (#{columns.join(', ')})
        VALUES (#{columns.map { |column| quote(task.public_send(column)) }.join(', ')})
      SQL
    end

    def persist_task!(task)
      assignments = TASK_COLUMNS.reject { |column| column == :task_id }.map do |column|
        "#{column} = #{quote(task.public_send(column))}"
      end
      execute(<<~SQL)
        UPDATE liquidation_tasks
        SET #{assignments.join(', ')}
        WHERE task_id = #{quote(task.task_id)}
      SQL
    end

    def insert_inbox!(event_id, topic)
      execute(<<~SQL)
        INSERT INTO liquidation_inbox_events (external_event_id, topic, received_at)
        VALUES (#{quote(event_id)}, #{quote(topic)}, #{quote(Time.now.utc)})
      SQL
    end

    def insert_event!(task, event_type, payload = {}, external_event_id = nil)
      execute(<<~SQL)
        INSERT INTO liquidation_task_events
          (task_id, event_type, external_event_id, payload, created_at)
        VALUES
          (#{quote(task.task_id)}, #{quote(event_type)}, #{quote(external_event_id)},
           #{quote_json(payload)}, #{quote(Time.now.utc)})
      SQL
    end

    def no_older_active_task?(candidate)
      terminal = Liquidation::TERMINAL_STATUSES.map { |status| quote(status) }.join(', ')
      row = first(<<~SQL)
        SELECT 1 FROM liquidation_tasks
        WHERE risk_unit_id = #{quote(candidate.risk_unit_id)}
          AND task_id <> #{quote(candidate.task_id)}
          AND decision_sequence < #{quote(candidate.decision_sequence)}
          AND status NOT IN (#{terminal})
        LIMIT 1
      SQL
      row.nil?
    end

    def claim_candidate!(task_id, worker_id:, lease_seconds:)
      transaction do
        row = first(<<~SQL)
          SELECT * FROM liquidation_tasks
          WHERE task_id = #{quote(task_id)}
            AND (
              status = 'PENDING'
              OR (status = 'RETRY_WAIT' AND (next_retry_at IS NULL OR next_retry_at <= UTC_TIMESTAMP(6)))
              OR (status IN ('CLAIMED', 'LOCKING', 'VALIDATING', 'EXECUTING') AND claim_expires_at <= UTC_TIMESTAMP(6))
            )
          FOR UPDATE
        SQL
        next nil unless row

        task = hydrate_task(row)
        next nil unless no_older_active_task?(task)

        if task.status == Liquidation::RETRY_WAIT
          from_status = task.status
          task.transition_to!(Liquidation::PENDING)
          insert_event!(task, 'RETRY_READY', from_status: from_status, to_status: task.status)
        end
        if %w[CLAIMED LOCKING VALIDATING EXECUTING].include?(task.status)
          previous_worker = task.claimed_by
          from_status = task.status
          task.transition_to!(Liquidation::PENDING)
          insert_event!(task, 'EXPIRED_CLAIM_RECOVERED',
                        from_status: from_status, to_status: task.status, previous_worker: previous_worker)
        end
        task.claimed_by = worker_id
        task.claim_expires_at = Time.now.utc + lease_seconds
        task.next_retry_at = nil
        task.error_code = nil
        task.error_message = nil
        from_status = task.status
        task.transition_to!(Liquidation::CLAIMED)
        persist_task!(task)
        insert_event!(task, 'TASK_CLAIMED', from_status: from_status, to_status: task.status)
        task
      end
    end

    def with_claim_transaction_retry
      attempts = 0
      begin
        attempts += 1
        yield
      rescue StandardError => e
        raise unless retryable_mysql_lock_error?(e) && attempts < CLAIM_TRANSACTION_MAX_ATTEMPTS

        sleep(0.01 * (2**(attempts - 1)) + (rand * 0.01))
        retry
      end
    end

    def retryable_mysql_lock_error?(error)
      error.respond_to?(:error_number) &&
        RETRYABLE_MYSQL_LOCK_ERROR_NUMBERS.include?(Integer(error.error_number))
    rescue ArgumentError, TypeError
      false
    end

    def hydrate_task(row)
      attributes = TASK_COLUMNS.each_with_object({}) { |column, result| result[column] = value(row, column) }
      attributes[:reduce_only] = [true, 1, '1'].include?(attributes[:reduce_only]) unless attributes[:reduce_only].nil?
      Liquidation.new(attributes)
    end

    def transaction
      with_connection do
        context = Thread.current[@transaction_context_key]
        if context
          context[:depth] += 1
          begin
            next yield
          ensure
            context[:depth] -= 1
          end
        end

        Thread.current[@transaction_context_key] = { depth: 1 }
        started = false
        begin
          execute('START TRANSACTION')
          started = true
          result = yield
          execute('COMMIT')
          result
        rescue StandardError
          begin
            execute('ROLLBACK') if started
          rescue StandardError
            nil
          end
          raise
        ensure
          Thread.current[@transaction_context_key] = nil
        end
      end
    end

    def execute(sql)
      with_connection { |connection| connection.query(sql) }
    end

    def rows(sql)
      execute(sql).to_a
    end

    def first(sql)
      execute(sql).first
    end

    def quote(value)
      case value
      when nil then 'NULL'
      when true then '1'
      when false then '0'
      when Numeric then value.to_s
      when Time then "'#{value.utc.strftime('%Y-%m-%d %H:%M:%S.%6N')}'"
      else with_connection { |connection| "'#{connection.escape(value.to_s)}'" }
      end
    end

    def quote_json(value)
      quote(JSON.generate(LiquidationSerializer.normalize(value)))
    end

    def value(row, key)
      row[key] || row[key.to_s]
    end

    def parse_json(value)
      value.is_a?(String) ? JSON.parse(value) : value
    end

    def symbolize(row)
      row.each_with_object({}) { |(key, item), result| result[key.to_sym] = item }
    end
  end
end
