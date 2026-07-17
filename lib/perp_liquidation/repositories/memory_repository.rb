# frozen_string_literal: true

require 'monitor'
require 'time'

module PerpLiquidation
  class MemoryRepository
    TaskEvent = Struct.new(:task_id, :event_type, :payload, :external_event_id, :created_at, keyword_init: true)
    PortfolioPlanEvent = Struct.new(:plan_id, :event_type, :payload, :created_at, keyword_init: true)
    OperatorAction = Struct.new(
      :operation_id, :action, :target_type, :target_id, :operator_id, :approver_id,
      :approval_id, :reason, :status, :result, :created_at, :completed_at,
      keyword_init: true
    )
    OutboxEvent = Struct.new(
      :event_id, :task_id, :topic, :payload, :attempt_count, :next_attempt_at,
      :last_error, :locked_by, :locked_until, :dead_lettered_at,
      :published_at, :created_at,
      keyword_init: true
    )

    attr_reader :tasks, :events, :risk_snapshots, :executions, :execution_steps,
                :order_attempts, :outbox_events, :reconciliation_issues,
                :bankruptcy_checks, :insurance_claims, :adl_requests,
                :portfolio_plans, :portfolio_plan_items, :portfolio_plan_events,
                :operator_actions

    def initialize
      @tasks = {}
      @task_row_ids = {}
      @next_task_row_id = 1
      @by_risk_decision = {}
      @by_order_id = {}
      @events = []
      @risk_snapshots = {}
      @executions = {}
      @execution_steps = {}
      @order_attempts = {}
      @inbox_event_ids = {}
      @outbox_events = []
      @reconciliation_issues = []
      @bankruptcy_checks = {}
      @insurance_claims = {}
      @adl_requests = {}
      @portfolio_plans = {}
      @portfolio_plans_by_decision = {}
      @portfolio_plan_items = {}
      @portfolio_plan_events = []
      @operator_actions = {}
      @worker_leases = {}
      @risk_unit_leases = {}
      @monitor = Monitor.new
    end

    def create_from_command!(command)
      @monitor.synchronize do
        existing = @by_risk_decision[command.risk_decision_id]
        return existing if existing

        task = Liquidation.new(
          task_id: task_id(command.risk_decision_id),
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
        plan = command.position_action? ? ExecutionPlanner.new(command).plan(task_id: task.task_id) : nil
        @tasks[task.task_id] = task
        @task_row_ids[task.task_id] = @next_task_row_id
        @next_task_row_id += 1
        @by_risk_decision[task.risk_decision_id] = task
        @risk_snapshots[task.task_id] = command.risk_snapshot
        plan&.steps&.each { |step| @execution_steps[[task.task_id, step.step_sequence]] = step }
        append_event!(task, 'COMMAND_RECEIVED', command.snapshot, external_event_id: command.risk_decision_id)
        append_event!(task, 'EXECUTION_PLAN_CREATED', execution_plan_for(task.task_id).map(&:snapshot)) if plan
        task
      end
    end

    def transition!(task, status, event_type, payload = {})
      @monitor.synchronize do
        current = @tasks.fetch(task.task_id) { raise NotFound, "liquidation task #{task.task_id} not found" }
        if current.status != task.status
          raise InvalidTransition,
                "task #{task.task_id} repository status is #{current.status}, object status is #{task.status}"
        end

        from_status = task.status
        task.transition_to!(status)
        @tasks[task.task_id] = task
        append_event!(task, event_type, payload.merge(from_status: from_status, to_status: status))
        task
      end
    end

    def append_event!(task, event_type, payload = {}, options = {})
      @monitor.synchronize do
        external_event_id = options[:external_event_id]
        return nil if external_event_id && inbox_processed?(external_event_id)

        event = TaskEvent.new(
          task_id: task.task_id,
          event_type: event_type,
          payload: payload,
          external_event_id: external_event_id,
          created_at: Time.now.utc
        )
        @events << event
        @inbox_event_ids[external_event_id] = true if external_event_id
        event
      end
    end

    def inbox_processed?(event_id)
      @inbox_event_ids.key?(event_id)
    end

    def with_transaction
      @monitor.synchronize { yield }
    end

    def with_connection
      yield self
    end

    def with_risk_unit_admission!(risk_unit_id:)
      raise InvalidCommand, 'risk_unit_id is required for command admission' if risk_unit_id.to_s.empty?

      @monitor.synchronize { yield }
    end

    def with_portfolio_scope_admission!(risk_unit_id:, decision_sequence:, risk_decision_id:)
      @monitor.synchronize do
        existing = find_portfolio_plan_by_risk_decision_id(risk_decision_id)
        return existing if existing

        latest = latest_portfolio_sequence(risk_unit_id)
        if latest && decision_sequence <= latest
          raise StaleDecision, "portfolio decision sequence #{decision_sequence} is not newer than #{latest}"
        end
        active = active_portfolio_plan_for_scope(risk_unit_id)
        if active
          raise PreconditionsFailed,
                "portfolio risk unit #{risk_unit_id} already has active plan #{active.plan_id}"
        end

        yield
      end
    end

    def with_inbox_event!(event_id, _topic)
      @monitor.synchronize do
        return nil if inbox_processed?(event_id)

        @inbox_event_ids[event_id] = true
        begin
          yield
        rescue StandardError
          @inbox_event_ids.delete(event_id)
          raise
        end
      end
    end

    def create_portfolio_plan!(command)
      @monitor.synchronize do
        existing = @portfolio_plans_by_decision[command.risk_decision_id]
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
          current_item_sequence: nil,
          item_count: command.items.length,
          completed_item_count: 0,
          expire_at: command.expire_at,
          created_at: command.created_at
        )
        @portfolio_plans[plan.plan_id] = plan
        @portfolio_plans_by_decision[plan.risk_decision_id] = plan
        append_portfolio_plan_event!(plan, 'PORTFOLIO_COMMAND_RECEIVED', command.snapshot)
        plan
      end
    end

    def create_portfolio_plan_item!(plan, task:, item:, status:)
      @monitor.synchronize do
        record = PortfolioPlanItem.new(
          plan_id: plan.plan_id,
          item_sequence: item.fetch(:item_sequence),
          task_id: task.task_id,
          position_id: item.fetch(:position_id),
          symbol: item.fetch(:symbol),
          authorized_notional: item.fetch(:authorized_notional),
          status: status
        )
        @portfolio_plan_items[[plan.plan_id, record.item_sequence]] = record
        record
      end
    end

    def find_portfolio_plan!(plan_id)
      @portfolio_plans.fetch(plan_id) { raise NotFound, "portfolio liquidation plan #{plan_id} not found" }
    end

    def find_portfolio_plan_by_risk_decision_id(risk_decision_id)
      @portfolio_plans_by_decision[risk_decision_id]
    end

    def latest_portfolio_sequence(risk_unit_id)
      values = @portfolio_plans.values.select { |plan| plan.risk_unit_id == risk_unit_id }.map(&:decision_sequence)
      values.max
    end

    def active_portfolio_plan_for_scope(risk_unit_id)
      @portfolio_plans.values.find { |plan| plan.risk_unit_id == risk_unit_id && !plan.terminal? }
    end

    def portfolio_plan_items_for(plan_id)
      @portfolio_plan_items.values
                           .select { |item| item.plan_id == plan_id }
                           .sort_by(&:item_sequence)
    end

    def portfolio_plan_item_for_task(task_id)
      @portfolio_plan_items.values.find { |item| item.task_id == task_id }
    end

    def update_portfolio_plan!(plan)
      plan.updated_at = Time.now.utc
      @portfolio_plans[plan.plan_id] = plan
      plan
    end

    def update_portfolio_plan_item!(item)
      item.updated_at = Time.now.utc
      @portfolio_plan_items[[item.plan_id, item.item_sequence]] = item
      item
    end

    def append_portfolio_plan_event!(plan, event_type, payload = {})
      event = PortfolioPlanEvent.new(
        plan_id: plan.plan_id,
        event_type: event_type,
        payload: payload,
        created_at: Time.now.utc
      )
      @portfolio_plan_events << event
      event
    end

    def portfolio_plan_events_for(plan_id)
      @portfolio_plan_events.select { |event| event.plan_id == plan_id }
    end

    def create_operator_action!(attributes)
      @monitor.synchronize do
        existing = @operator_actions[attributes.fetch(:operation_id)]
        return existing if existing

        action = OperatorAction.new(**attributes.merge(
          status: 'PENDING', result: {}, created_at: Time.now.utc
        ))
        @operator_actions[action.operation_id] = action
        action
      end
    end

    def with_operator_action_lock!(operation_id)
      @monitor.synchronize do
        action = @operator_actions[operation_id]
        raise NotFound, "operator action #{operation_id} not found" unless action

        yield action
      end
    end

    def complete_operator_action!(action, status:, result:)
      @monitor.synchronize do
        action.status = status
        action.result = result
        action.completed_at = Time.now.utc
        action
      end
    end

    def operator_action(operation_id)
      @operator_actions[operation_id]
    end

    def latest_sequence(risk_unit_id)
      values = @tasks.values.select { |task| task.risk_unit_id == risk_unit_id }.map(&:decision_sequence)
      values.max
    end

    def active_for_risk_unit(risk_unit_id)
      @tasks.values.select { |task| task.risk_unit_id == risk_unit_id && task.active? }
    end

    def claim_next_task!(worker_id: 'memory-worker', lease_seconds: 30, priority_aging_seconds: 30)
      @monitor.synchronize do
        now = Time.now.utc
        task = @tasks.values.select do |candidate|
          ready = candidate.status == Liquidation::PENDING ||
                  (candidate.status == Liquidation::RETRY_WAIT && (!candidate.next_retry_at || candidate.next_retry_at <= now))
          reclaimable = %w[CLAIMED LOCKING VALIDATING EXECUTING].include?(candidate.status) &&
                        candidate.claim_expires_at && candidate.claim_expires_at <= now
          (ready || reclaimable) && no_older_active_task?(candidate)
        end.min_by do |candidate|
          age_steps = [(now - candidate.created_at) / priority_aging_seconds, 0].max.floor
          [[candidate.priority - age_steps, 0].max, candidate.created_at, candidate.task_id]
        end
        return nil unless task

        transition!(task, Liquidation::PENDING, 'RETRY_READY') if task.status == Liquidation::RETRY_WAIT
        if %w[CLAIMED LOCKING VALIDATING EXECUTING].include?(task.status)
          transition!(task, Liquidation::PENDING, 'EXPIRED_CLAIM_RECOVERED', previous_worker: task.claimed_by)
        end
        task.claimed_by = worker_id
        task.claim_expires_at = now + lease_seconds
        task.next_retry_at = nil
        task.error_code = nil
        task.error_message = nil
        transition!(task, Liquidation::CLAIMED, 'TASK_CLAIMED')
      end
    end

    def active_order_count_for_symbol(symbol, excluding_task_id: nil)
      active_statuses = %w[ORDER_SUBMITTING ORDER_ACCEPTED PARTIALLY_FILLED FILLED SETTLEMENT_PENDING]
      @tasks.values.count do |task|
        task.symbol == symbol && task.task_id != excluding_task_id && active_statuses.include?(task.status)
      end
    end

    def heartbeat_worker!(worker_id:, worker_type:, lease_seconds:, metadata: {})
      @worker_leases[worker_id] = {
        worker_id: worker_id,
        worker_type: worker_type,
        lease_expires_at: Time.now.utc + lease_seconds,
        metadata: metadata,
        updated_at: Time.now.utc
      }
    end

    def attach_fencing_token!(task, token)
      task.fencing_token = token
      task.updated_at = Time.now.utc
      append_event!(task, 'FENCING_TOKEN_ASSIGNED', fencing_token: token)
    end

    def acquire_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:, lease_seconds:)
      @monitor.synchronize do
        now = Time.now.utc
        current = @risk_unit_leases[risk_unit_id]
        if current && current[:lease_expires_at] > now && current[:owner_task_id] != owner_task_id
          raise PositionLocked, "risk unit #{risk_unit_id} is leased by #{current[:owner_task_id]}"
        end

        previous_token = current ? current[:fencing_token] : 0
        token = [Integer(fencing_token), previous_token + 1].max
        @risk_unit_leases[risk_unit_id] = {
          owner_task_id: owner_task_id,
          fencing_token: token,
          lease_expires_at: now + lease_seconds,
          updated_at: now
        }
        token
      end
    end

    def renew_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:, lease_seconds:)
      @monitor.synchronize do
        now = Time.now.utc
        current = @risk_unit_leases[risk_unit_id]
        unless current && current[:owner_task_id] == owner_task_id &&
               current[:fencing_token] == Integer(fencing_token) && current[:lease_expires_at] > now
          raise PositionLocked, "risk unit #{risk_unit_id} lease was lost"
        end

        current[:lease_expires_at] = now + lease_seconds
        current[:updated_at] = now
        true
      end
    end

    def release_risk_unit_lease!(risk_unit_id:, owner_task_id:, fencing_token:)
      @monitor.synchronize do
        current = @risk_unit_leases[risk_unit_id]
        return false unless current && current[:owner_task_id] == owner_task_id &&
                            current[:fencing_token] == Integer(fencing_token)

        current[:lease_expires_at] = Time.now.utc
        current[:updated_at] = current[:lease_expires_at]
        true
      end
    end

    def attach_order!(task, order_id:, execution:)
      @monitor.synchronize do
        task.order_id = order_id
        @by_order_id[order_id] = task
        @executions[execution.fetch(:client_order_id)] = execution
        append_event!(task, 'ORDER_ATTACHED', execution)
      end
    end

    def execution_plan_for(task_id)
      @execution_steps.values
                      .select { |step| step.task_id == task_id }
                      .sort_by(&:step_sequence)
    end

    def execution_step(task_id, step_sequence)
      @execution_steps.fetch([task_id, step_sequence]) do
        raise NotFound, "execution step #{task_id}/#{step_sequence} not found"
      end
    end

    def next_execution_step(task_id)
      execution_plan_for(task_id).find { |step| !step.terminal? }
    end

    def cap_execution_plan!(task, max_remaining_quantity:)
      @monitor.synchronize do
        remaining = BigDecimal(max_remaining_quantity.to_s)
        raise InvalidCommand, 'max remaining quantity cannot be negative' if remaining.negative?

        allocated = BigDecimal('0')
        execution_plan_for(task.task_id).reject(&:terminal?).each do |step|
          unless %w[PLANNED].include?(step.status)
            raise ManualReviewRequired, "cannot cap execution step #{step.step_sequence} in #{step.status}"
          end

          allocation = [step.remaining_quantity, remaining].min
          if allocation.positive?
            step.quantity = step.executed_quantity + allocation
            remaining -= allocation
            allocated += allocation
          else
            step.status = 'SKIPPED'
            step.completed_at = Time.now.utc
          end
          step.updated_at = Time.now.utc
        end
        append_event!(
          task,
          'EXECUTION_PLAN_CAPPED',
          max_remaining_quantity: max_remaining_quantity.to_s('F'),
          allocated_quantity: allocated.to_s('F'),
          steps: execution_plan_for(task.task_id).map(&:snapshot)
        )
        allocated
      end
    end

    def create_order_attempt!(step, attributes)
      @monitor.synchronize do
        attempt = OrderAttempt.new(attributes.merge(
          task_id: step.task_id,
          step_sequence: step.step_sequence
        ))
        existing = @order_attempts[attempt.client_order_id]
        return existing if existing

        step.status = 'SUBMITTING'
        step.updated_at = Time.now.utc
        @order_attempts[attempt.client_order_id] = attempt
        attempt
      end
    end

    def attach_order_result!(task, step:, attempt:, result:)
      @monitor.synchronize do
        attempt.update_disposition(
          status: result.status,
          executed_quantity: result.filled_quantity
        )
        attempt.order_id = result.order_id
        attempt.status = result.status
        attempt.executed_quantity = result.filled_quantity
        attempt.average_price = result.average_price
        attempt.fee = result.fee
        attempt.response = result.snapshot
        attempt.updated_at = Time.now.utc
        task.order_id = result.order_id
        @by_order_id[result.order_id] = task if result.order_id
        update_step_and_task_totals!(task, step)
        write_legacy_execution!(task, step, attempt)
        append_event!(task, 'ORDER_ATTEMPT_ATTACHED', attempt.snapshot)
        attempt
      end
    end

    def update_order_attempt!(task, attempt:, status:, executed_quantity:, average_price: nil, fee: nil,
                              event_sequence: nil, response: {})
      @monitor.synchronize do
        disposition = attempt.update_disposition(
          status: status,
          executed_quantity: executed_quantity,
          event_sequence: event_sequence
        )
        return :stale if disposition == :stale

        attempt.last_event_sequence = Integer(event_sequence) if event_sequence
        attempt.response = response
        attempt.updated_at = Time.now.utc
        return :status_regression if disposition == :status_regression

        attempt.status = status
        attempt.executed_quantity = BigDecimal(executed_quantity.to_s)
        attempt.average_price = average_price.nil? ? nil : BigDecimal(average_price.to_s)
        attempt.fee = fee.nil? ? nil : BigDecimal(fee.to_s)
        step = execution_step(task.task_id, attempt.step_sequence)
        update_step_and_task_totals!(task, step)
        write_legacy_execution!(task, step, attempt)
        :applied
      end
    end

    def current_order_attempt(task_id, step_sequence)
      @order_attempts.values
                     .select { |attempt| attempt.task_id == task_id && attempt.step_sequence == step_sequence }
                     .max_by(&:attempt_sequence)
    end

    def order_attempt_for(task_id, order_id: nil, client_order_id: nil)
      @order_attempts.values.find do |attempt|
        attempt.task_id == task_id &&
          ((order_id && attempt.order_id == order_id) ||
           (client_order_id && attempt.client_order_id == client_order_id))
      end
    end

    def order_attempts_for(task_id)
      @order_attempts.values
                     .select { |attempt| attempt.task_id == task_id }
                     .sort_by { |attempt| [attempt.step_sequence, attempt.attempt_sequence] }
    end

    def order_attempt_count(task_id)
      @order_attempts.values.count { |attempt| attempt.task_id == task_id }
    end

    def settle_execution_step!(task, step, position_version:)
      @monitor.synchronize do
        unless %w[FILLED PARTIAL_SETTLEMENT_PENDING].include?(step.status)
          raise InvalidTransition, "execution step #{step.step_sequence} is not awaiting settlement"
        end

        now = Time.now.utc
        if step.remaining_quantity.zero?
          step.status = 'SETTLED'
          step.completed_at = now
          event_type = 'EXECUTION_STEP_SETTLED'
        else
          step.status = 'PLANNED'
          step.completed_at = nil
          event_type = 'CHILD_ORDER_SETTLED'
        end
        step.updated_at = now
        task.settled_position_version = position_version
        append_event!(task, event_type, step.snapshot.merge(position_version: position_version))
        step
      end
    end

    def update_execution!(task, attributes)
      execution = @executions.values.find { |item| item[:task_id] == task.task_id }
      raise NotFound, "execution for #{task.task_id} not found" unless execution

      execution.merge!(attributes)
      task.executed_quantity = attributes[:executed_quantity] if attributes.key?(:executed_quantity)
      task.average_price = attributes[:average_price] if attributes.key?(:average_price)
      task.fee = attributes[:fee] if attributes.key?(:fee)
      execution
    end

    def schedule_retry!(task, error, delay_seconds: 10)
      task.retry_count += 1
      task.next_retry_at = Time.now.utc + delay_seconds
      task.error_code = error.class.name.split('::').last
      task.error_message = error.message
      transition!(task, Liquidation::RETRY_WAIT, 'RETRY_SCHEDULED', error: task.error_code, message: error.message)
    end

    def find!(task_id)
      @tasks.fetch(task_id) { raise NotFound, "liquidation task #{task_id} not found" }
    end

    def lock_task!(task_id)
      @monitor.synchronize { find!(task_id) }
    end

    def find_by_risk_decision_id(risk_decision_id)
      @by_risk_decision[risk_decision_id]
    end

    def find_by_order_id!(order_id)
      @by_order_id.fetch(order_id) { raise NotFound, "liquidation order #{order_id} not found" }
    end

    def all
      @tasks.values
    end

    def list_tasks(filters: {}, limit: 100, before_id: nil)
      bounded_limit = Integer(limit)
      rows = @tasks.values.select do |task|
        (!before_id || @task_row_ids.fetch(task.task_id) < Integer(before_id)) &&
          filters.all? { |field, expected| expected.nil? || task.public_send(field).to_s == expected.to_s }
      end
      rows = rows.sort_by { |task| -@task_row_ids.fetch(task.task_id) }
      page_rows = rows.first(bounded_limit + 1)
      has_more = page_rows.length > bounded_limit
      items = page_rows.first(bounded_limit)
      {
        items: items,
        next_before_id: has_more ? @task_row_ids.fetch(items.last.task_id) : nil
      }
    end

    def stuck_tasks(statuses:, updated_before:, limit: 100)
      @tasks.values
            .select { |task| statuses.include?(task.status) && task.updated_at <= updated_before }
            .sort_by(&:updated_at)
            .first(limit)
    end

    def stuck_tasks_by_status(status_cutoffs:, per_status_limit: 100)
      status_cutoffs.flat_map do |status, cutoff|
        stuck_tasks(statuses: [status], updated_before: cutoff, limit: per_status_limit)
      end.sort_by(&:updated_at)
    end

    def events_for(task_id)
      @events.select { |event| event.task_id == task_id }
    end

    def risk_snapshot_for(task_id)
      @risk_snapshots[task_id]
    end

    def execution_for(task_id)
      @executions.values
                 .select { |execution| execution[:task_id] == task_id }
                 .max_by { |execution| execution[:execution_sequence] }
    end

    def enqueue_outbox!(task, topic:, payload:)
      event = OutboxEvent.new(
        event_id: "#{task.task_id}:#{topic}:#{@outbox_events.length + 1}",
        task_id: task.task_id,
        topic: topic,
        payload: payload,
        attempt_count: 0,
        created_at: Time.now.utc
      )
      @outbox_events << event
      event
    end

    def pending_outbox
      @outbox_events.select { |event| event.published_at.nil? && event.dead_lettered_at.nil? }
    end


    def claim_outbox_events!(worker_id:, limit: 100, lease_seconds: 30, now: Time.now.utc)
      @monitor.synchronize do
        events = @outbox_events.select do |event|
          event.published_at.nil? && event.dead_lettered_at.nil? &&
            (!event.next_attempt_at || event.next_attempt_at <= now) &&
            (!event.locked_until || event.locked_until <= now)
        end.first(limit)
        events.each do |event|
          event.locked_by = worker_id
          event.locked_until = now + lease_seconds
        end
        events
      end
    end

    def mark_outbox_published!(event)
      event.published_at = Time.now.utc
      event.locked_by = nil
      event.locked_until = nil
      event.last_error = nil
    end

    def mark_outbox_failed!(event, error, max_attempts: 10, base_delay_seconds: 1)
      event.attempt_count = event.attempt_count.to_i + 1
      event.last_error = error.message.to_s[0, 1024]
      event.locked_by = nil
      event.locked_until = nil
      if event.attempt_count >= max_attempts
        event.dead_lettered_at = Time.now.utc
      else
        delay = [base_delay_seconds * (2**(event.attempt_count - 1)), 300].min
        event.next_attempt_at = Time.now.utc + delay
      end
      event
    end

    def outbox_for_task(task_id)
      @outbox_events.reverse.find { |event| event.task_id == task_id }
    end

    def dead_letter_outbox(limit: 100)
      @outbox_events
        .select { |event| event.dead_lettered_at }
        .sort_by(&:dead_lettered_at)
        .reverse
        .first(limit)
    end

    def replay_outbox_for_task!(task_id)
      events = @outbox_events.select { |event| event.task_id == task_id }
      events.each { |event| event.published_at = nil }
      events.each do |event|
        event.attempt_count = 0
        event.next_attempt_at = nil
        event.last_error = nil
        event.locked_by = nil
        event.locked_until = nil
        event.dead_lettered_at = nil
      end
      events.length
    end

    def record_reconciliation_issue!(task, issue_type:, expected_payload:, actual_payload:)
      @monitor.synchronize do
        issue = @reconciliation_issues.find do |candidate|
          candidate.task_id == task.task_id && candidate.issue_type == issue_type && candidate.open?
        end
        if issue
          issue.expected_payload = expected_payload
          issue.actual_payload = actual_payload
          return issue
        end

        issue = ReconciliationIssue.new(
          id: @reconciliation_issues.length + 1,
          task_id: task.task_id,
          issue_type: issue_type,
          expected_payload: expected_payload,
          actual_payload: actual_payload
        )
        @reconciliation_issues << issue
        issue
      end
    end

    def resolve_reconciliation_issues!(task_id, issue_type: nil)
      @monitor.synchronize do
        resolved = @reconciliation_issues.select do |issue|
          issue.task_id == task_id && issue.open? && (!issue_type || issue.issue_type == issue_type)
        end
        resolved.each do |issue|
          issue.status = 'RESOLVED'
          issue.resolved_at = Time.now.utc
        end
        resolved.length
      end
    end

    def reconciliation_issues(status: nil, task_id: nil)
      @reconciliation_issues.select do |issue|
        (!status || issue.status == status) && (!task_id || issue.task_id == task_id)
      end
    end

    def mark_reconciliation_checked!(task, issue_type:, outcome:)
      @monitor.synchronize do
        task.updated_at = Time.now.utc
        append_event!(
          task,
          'RECONCILIATION_CHECKED',
          issue_type: issue_type, outcome: outcome
        )
      end
    end

    def loss_mitigation_tasks(updated_before:, limit: 100)
      statuses = [
        Liquidation::BANKRUPTCY_CHECKING,
        Liquidation::INSURANCE_CLAIMING,
        Liquidation::ADL_REQUIRED,
        Liquidation::ADL_EXECUTING,
        Liquidation::ADL_SETTLEMENT_PENDING
      ]
      @tasks.values
            .select { |task| statuses.include?(task.status) && task.updated_at <= updated_before }
            .sort_by(&:updated_at)
            .first(limit)
    end

    def record_bankruptcy_check!(task, result)
      @bankruptcy_checks[task.task_id] ||= symbolize_hash(result).merge(task_id: task.task_id)
    end

    def bankruptcy_check_for(task_id)
      @bankruptcy_checks[task_id]
    end

    def record_insurance_claim!(task, result)
      @insurance_claims[task.task_id] ||= symbolize_hash(result).merge(task_id: task.task_id)
    end

    def insurance_claim_for(task_id)
      @insurance_claims[task_id]
    end

    def record_adl_request!(task, result)
      @adl_requests[task.task_id] ||= symbolize_hash(result).merge(task_id: task.task_id)
    end

    def adl_request_for(task_id)
      @adl_requests[task_id]
    end

    def update_adl_request!(task, result)
      request = @adl_requests.fetch(task.task_id) { raise NotFound, "ADL request for #{task.task_id} not found" }
      request.merge!(symbolize_hash(result))
      request[:settled_at] = Time.now.utc if request[:status] == 'COMPLETED'
      request
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

    def symbolize_hash(hash)
      hash.each_with_object({}) { |(key, value), result| result[key.to_sym] = value }
    end

    def update_step_and_task_totals!(task, step)
      step_attempts = @order_attempts.values.select do |attempt|
        attempt.task_id == task.task_id && attempt.step_sequence == step.step_sequence
      end
      step.executed_quantity = step_attempts.reduce(BigDecimal('0')) do |total, attempt|
        total + attempt.executed_quantity
      end
      current_attempt = step_attempts.max_by(&:attempt_sequence)
      step.status = case current_attempt&.status
                    when 'FILLED' then 'FILLED'
                    when 'ACCEPTED', 'PARTIALLY_FILLED' then 'WORKING'
                    when 'SUBMITTING' then 'SUBMITTING'
                    when 'REJECTED', 'CANCELLED'
                      current_attempt.executed_quantity.positive? ? 'PARTIAL_SETTLEMENT_PENDING' : 'PLANNED'
                    else 'PLANNED'
                    end
      step.updated_at = Time.now.utc

      attempts = @order_attempts.values.select { |attempt| attempt.task_id == task.task_id }
      task.executed_quantity = attempts.reduce(BigDecimal('0')) { |total, attempt| total + attempt.executed_quantity }
      task.fee = attempts.compact.reduce(BigDecimal('0')) { |total, attempt| total + (attempt.fee || 0) }
      priced = attempts.select { |attempt| attempt.average_price && attempt.executed_quantity.positive? }
      priced_quantity = priced.reduce(BigDecimal('0')) { |total, attempt| total + attempt.executed_quantity }
      task.average_price = if priced_quantity.positive?
                             priced.reduce(BigDecimal('0')) do |total, attempt|
                               total + (attempt.average_price * attempt.executed_quantity)
                             end / priced_quantity
                           end
      task.updated_at = Time.now.utc
    end

    def write_legacy_execution!(task, step, attempt)
      execution_sequence = ((step.step_sequence - 1) * 1000) + attempt.attempt_sequence
      @executions[attempt.client_order_id] = {
        task_id: task.task_id,
        execution_sequence: execution_sequence,
        client_order_id: attempt.client_order_id,
        order_id: attempt.order_id,
        requested_quantity: attempt.requested_quantity.to_s('F'),
        executed_quantity: attempt.executed_quantity,
        average_price: attempt.average_price,
        fee: attempt.fee,
        status: attempt.status,
        request: attempt.request,
        response: attempt.response
      }
    end

    def no_older_active_task?(candidate)
      @tasks.values.none? do |other|
        other.task_id != candidate.task_id && other.risk_unit_id == candidate.risk_unit_id &&
          other.active? && other.decision_sequence < candidate.decision_sequence
      end
    end

    def task_id(risk_decision_id)
      safe_id = risk_decision_id.to_s.gsub(/[^A-Za-z0-9_\-]/, '_')
      "liq_#{safe_id}"
    end
  end
end
