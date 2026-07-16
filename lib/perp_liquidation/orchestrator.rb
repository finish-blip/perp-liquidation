# frozen_string_literal: true

module PerpLiquidation
  class Orchestrator
    RESULT_TOPIC = 'liquidation.execution.result'

    def initialize(repository:, order_client:, position_client:, risk_unit_lock_manager:, validator: nil,
                   market_data_client: nil, price_protection: nil,
                   adaptive_execution_strategy: nil, loss_mitigation_client: nil,
                   portfolio_plan_coordinator: nil,
                   risk_unit_lease_seconds: 30, max_active_orders_per_symbol: 100,
                   execution_defer_seconds: 2, clock: -> { Time.now.utc })
      @repository = repository
      @order_client = order_client
      @position_client = position_client
      @market_data_client = market_data_client
      @risk_unit_lock_manager = risk_unit_lock_manager
      @validator = validator || InstructionValidator.new(repository: repository)
      @price_protection = price_protection || PriceProtection.new
      @adaptive_execution_strategy = adaptive_execution_strategy || AdaptiveExecutionStrategy.new
      @portfolio_plan_coordinator = portfolio_plan_coordinator || PortfolioPlanCoordinator.new(repository: repository)
      @step_executor = StepExecutor.new(repository: repository, order_client: order_client)
      @loss_mitigation_client = loss_mitigation_client
      @risk_unit_lease_seconds = Float(risk_unit_lease_seconds)
      @max_active_orders_per_symbol = Integer(max_active_orders_per_symbol)
      @execution_defer_seconds = Float(execution_defer_seconds)
      raise InvalidCommand, 'max_active_orders_per_symbol must be positive' unless @max_active_orders_per_symbol.positive?
      raise InvalidCommand, 'execution_defer_seconds must be positive' unless @execution_defer_seconds.positive?
      @clock = clock
      @metrics = nil
      @max_retry_count = 3
    end

    attr_writer :metrics

    def execute(task)
      raise InvalidTransition, "task #{task.task_id} must be CLAIMED" unless task.status == Liquidation::CLAIMED

      @repository.transition!(task, Liquidation::LOCKING, 'RISK_UNIT_LOCKING')
      lock_started_at = monotonic_time
      lease_token = nil
      renew_lease = lambda do
        next unless lease_token

        @repository.renew_risk_unit_lease!(
          risk_unit_id: task.execution_scope_id,
          owner_task_id: task.task_id,
          fencing_token: lease_token,
          lease_seconds: @risk_unit_lease_seconds
        )
      end
      begin
        @risk_unit_lock_manager.with_lock(
          risk_unit_id: task.execution_scope_id,
          owner: task.task_id,
          on_renew: renew_lease
        ) do |candidate_token|
          @metrics&.observe('liquidation_lock_wait_seconds', monotonic_time - lock_started_at)
          lease_token = @repository.acquire_risk_unit_lease!(
            risk_unit_id: task.execution_scope_id,
            owner_task_id: task.task_id,
            fencing_token: candidate_token,
            lease_seconds: @risk_unit_lease_seconds
          )
          @repository.attach_fencing_token!(task, lease_token)
          @repository.transition!(task, Liquidation::VALIDATING, 'INSTRUCTION_VALIDATING')
          position = task.position_action? ? @position_client.find(position_id: task.position_id) : nil
          @validator.validate!(task, position: position)
          enforce_execution_backpressure!(task)
          executable_quantity = authorize_execution_quantity!(task, position)
          execution_protection = executable_quantity&.positive? ? validate_execution_price!(task) : nil
          execution_decision = if executable_quantity&.positive? && task.position_action?
                                 plan_child_order!(task, execution_protection || {})
                               end
          execution_context = execution_protection || {}
          execution_context = execution_context.merge(expected_position_version: position.version) if position
          @repository.append_event!(task, 'INSTRUCTION_VALIDATED', position ? position.snapshot : {})
          @repository.transition!(task, Liquidation::EXECUTING, 'EXECUTION_STARTED')
          if task.position_action? && executable_quantity.zero?
            complete_without_order!(task, position)
          else
            execute_action!(
              task,
              execution_protection: execution_context,
              execution_decision: execution_decision
            )
          end
        end
      ensure
        @repository.release_risk_unit_lease!(
          risk_unit_id: task.execution_scope_id,
          owner_task_id: task.task_id,
          fencing_token: lease_token
        ) if lease_token
      end
      task
    rescue InstructionExpired => e
      reject_with!(task, Liquidation::EXPIRED, 'DECISION_EXPIRED', e)
    rescue StaleDecision => e
      reject_with!(task, Liquidation::SUPERSEDED, 'STALE_DECISION', e)
    rescue ExecutionPolicyExhausted => e
      reject_with!(task, Liquidation::REJECTED, 'EXECUTION_POLICY_EXHAUSTED', e)
    rescue PreconditionsFailed, InvalidCommand => e
      reject_with!(task, Liquidation::REJECTED, 'PRECONDITION_REJECTED', e)
    rescue ExecutionDeferred => e
      defer_task!(task, e)
    rescue PositionLocked, RetryableError => e
      retry_task!(task, e)
    rescue StandardError => e
      manual_review!(task, e)
    end

    def handle_order_event(event)
      event_id = fetch(event, :event_id)
      @repository.with_inbox_event!(event_id, 'order.lifecycle') do
        task = @repository.find_by_order_id!(fetch(event, :order_id))
        order_id = value(event, :order_id)
        client_order_id = value(event, :client_order_id)
        attempt = if order_id || client_order_id
                    @repository.order_attempt_for(
                      task.task_id,
                      order_id: order_id,
                      client_order_id: client_order_id
                    )
                  end
        raise NotFound, "order attempt for #{fetch(event, :order_id)} not found" unless attempt

        step = @repository.execution_step(task.task_id, attempt.step_sequence)
        if step.settled?
          @repository.append_event!(task, 'SETTLED_STEP_ORDER_EVENT_IGNORED', event)
          next task
        end
        begin
          apply_order_event!(task, event, attempt: attempt)
        rescue RetryableError => e
          retry_task!(task, e)
        rescue ManualReviewRequired => e
          manual_review!(task, e)
        end
        @repository.append_event!(task, 'ORDER_EVENT_CONSUMED', event)
        task
      end
    end

    def handle_settlement_event(event)
      event_id = fetch(event, :event_id)
      @repository.with_inbox_event!(event_id, 'position.settlement.confirmed') do
        task_id = fetch(event, :task_id)
        order_id = fetch(event, :order_id)
        position_id = fetch(event, :position_id)
        task = @repository.find!(task_id)
        attempt = @repository.order_attempt_for(
          task.task_id,
          order_id: order_id
        )
        raise NotFound, "settlement order #{order_id} does not belong to task #{task.task_id}" unless attempt
        step = @repository.execution_step(task.task_id, attempt.step_sequence)
        unless task.status == Liquidation::SETTLEMENT_PENDING
          historical_attempt = %w[FILLED REJECTED CANCELLED].include?(attempt.status)
          if historical_attempt && %w[PLANNED SETTLED SKIPPED].include?(step.status)
            @repository.append_event!(task, 'HISTORICAL_CHILD_SETTLEMENT_IGNORED', event)
            next task
          end
          raise InvalidTransition, "task #{task.task_id} is not waiting for settlement"
        end
        settlement_started_at = task.updated_at

        if value(event, :client_order_id) && value(event, :client_order_id).to_s != attempt.client_order_id.to_s
          raise PreconditionsFailed, 'settlement client_order_id does not match order attempt'
        end
        if position_id.to_s != task.position_id.to_s
          raise PreconditionsFailed, "settlement position #{position_id} does not match task position #{task.position_id}"
        end

        current_step = @repository.next_execution_step(task.task_id)
        awaiting_settlement = %w[FILLED PARTIAL_SETTLEMENT_PENDING].include?(step.status)
        unless current_step && current_step.step_sequence == step.step_sequence && awaiting_settlement
          raise PreconditionsFailed, "settlement order #{order_id} is not the current execution awaiting settlement"
        end
        begin
          position_version = Integer(fetch(event, :position_version))
        rescue ArgumentError, TypeError
          raise InvalidCommand, 'settlement position_version must be an integer'
        end
        previous_version = Integer(task.settled_position_version || task.position_version)
        unless position_version > previous_version
          raise PreconditionsFailed,
                "settlement position version #{position_version} must be newer than #{previous_version}"
        end
        if task.portfolio_plan_id
          plan = @repository.find_portfolio_plan!(task.portfolio_plan_id)
          begin
            account_version = Integer(fetch(event, :account_version))
          rescue ArgumentError, TypeError
            raise InvalidCommand, 'portfolio settlement account_version must be an integer'
          end
          expected_account_version = plan.current_account_version + 1
          unless account_version == expected_account_version
            raise PreconditionsFailed,
                  "portfolio settlement account version #{account_version} must equal #{expected_account_version}"
          end
          plan.current_account_version = account_version
          @repository.update_portfolio_plan!(plan)
          @repository.append_portfolio_plan_event!(
            plan,
            'PORTFOLIO_ACCOUNT_VERSION_ADVANCED',
            item_sequence: task.plan_item_sequence,
            account_version: account_version,
            order_id: order_id
          )
        end
        @repository.settle_execution_step!(task, step, position_version: position_version)
        @repository.append_event!(task, 'SETTLEMENT_CONFIRMED', event)
        if @repository.next_execution_step(task.task_id)
          schedule_next_execution!(task, event)
        elsif @loss_mitigation_client
          @repository.transition!(task, Liquidation::BANKRUPTCY_CHECKING, 'BANKRUPTCY_CHECK_PENDING', event)
        else
          @repository.transition!(task, Liquidation::SETTLED, 'TASK_SETTLED', event)
          complete!(task)
        end
        @metrics&.observe('liquidation_settlement_latency_seconds', Time.now.utc - settlement_started_at)
        task
      end
    end

    def recover_order_submission(task)
      reconcile_order(task)
    end

    def reconcile_order(task)
      step = @repository.next_execution_step(task.task_id)
      attempt = step && @repository.current_order_attempt(task.task_id, step.step_sequence)
      raise ManualReviewRequired, 'missing order attempt for submitted order' unless attempt

      result = @order_client.find_by_client_order_id(client_order_id: attempt.client_order_id)
      raise RetryableError, "order #{attempt.client_order_id} is not queryable yet" unless result

      if adaptive_order_timed_out?(task, attempt, result)
        result = @order_client.cancel_liquidation_order(
          client_order_id: attempt.client_order_id,
          task_id: task.task_id,
          risk_decision_id: task.risk_decision_id,
          fencing_token: task.fencing_token
        )
        @repository.append_event!(
          task,
          'CHILD_ORDER_CANCEL_REQUESTED',
          client_order_id: attempt.client_order_id,
          timeout_ms: task.child_order_timeout_ms,
          result: result.snapshot
        )
        @metrics&.increment('liquidation_child_order_cancelled_total', labels: { symbol: task.symbol })
      end
      @repository.attach_order_result!(task, step: step, attempt: attempt, result: result)
      begin
        apply_order_result!(task, result, attempt: attempt)
      rescue RetryableError => e
        retry_task!(task, e)
      end
      task
    end

    def reconcile_settlement(task, order_id:, position_version:, account_version: nil)
      if task.status == Liquidation::FILLED
        @repository.transition!(task, Liquidation::SETTLEMENT_PENDING, 'SETTLEMENT_PENDING_RECONCILED')
      end
      handle_settlement_event(
        event_id: "reconciled_settlement_#{order_id}_#{position_version}",
        task_id: task.task_id,
        order_id: order_id,
        position_id: task.position_id,
        position_version: position_version,
        account_version: account_version,
        source: 'RECONCILIATION'
      )
    end

    def recover_settled_completion(task)
      unless task.status == Liquidation::SETTLED
        raise InvalidTransition, "task #{task.task_id} is not settled"
      end

      complete!(task)
      task
    end

    def process_loss_mitigation(task)
      raise InvalidTransition, 'loss mitigation client is not configured' unless @loss_mitigation_client

      case task.status
      when Liquidation::BANKRUPTCY_CHECKING then process_bankruptcy_check!(task)
      when Liquidation::INSURANCE_CLAIMING then process_insurance_claim!(task)
      when Liquidation::ADL_REQUIRED, Liquidation::ADL_EXECUTING then process_adl_request!(task)
      when Liquidation::ADL_SETTLEMENT_PENDING then reconcile_adl_request!(task)
      else raise InvalidTransition, "task #{task.task_id} in #{task.status} is not awaiting loss mitigation"
      end
      task
    end

    def handle_adl_settlement(event)
      event_id = fetch(event, :event_id)
      @repository.with_inbox_event!(event_id, 'adl.settlement.confirmed') do
        task = @repository.find!(fetch(event, :task_id))
        unless task.status == Liquidation::ADL_SETTLEMENT_PENDING
          raise InvalidTransition, "task #{task.task_id} is not waiting for ADL settlement"
        end

        request = @repository.adl_request_for(task.task_id)
        request_id = fetch(event, :adl_request_id)
        unless request && value(request, :adl_request_id).to_s == request_id.to_s
          raise PreconditionsFailed, "ADL request #{request_id} does not belong to task #{task.task_id}"
        end
        raise RetryableError, "ADL request #{request_id} is not completed" unless fetch(event, :status) == 'COMPLETED'

        covered = BigDecimal(fetch(event, :covered_amount).to_s)
        requested = BigDecimal(value(request, :requested_amount).to_s)
        if covered < requested
          raise ManualReviewRequired, "ADL covered #{covered.to_s('F')} of #{requested.to_s('F')}"
        end

        @repository.update_adl_request!(task, event)
        @repository.append_event!(task, 'ADL_SETTLEMENT_CONFIRMED', event)
        settle_and_complete!(task, 'ADL_LOSS_SETTLED', event)
        task
      end
    end

    private

    def process_bankruptcy_check!(task)
      result = @repository.bankruptcy_check_for(task.task_id)
      result ||= @loss_mitigation_client.check_bankruptcy(
        task_id: task.task_id,
        risk_decision_id: task.risk_decision_id,
        position_id: task.position_id,
        position_version: task.settled_position_version,
        executed_quantity: task.executed_quantity.to_s('F'),
        average_price: task.average_price&.to_s('F')
      )
      assert_completed!(result, 'bankruptcy check')
      result = @repository.record_bankruptcy_check!(task, result)
      loss = decimal_value(result, :bankruptcy_loss)
      @repository.append_event!(task, 'BANKRUPTCY_CHECK_COMPLETED', result)
      if loss.positive?
        @repository.transition!(task, Liquidation::INSURANCE_CLAIMING, 'INSURANCE_CLAIM_PENDING')
      else
        settle_and_complete!(task, 'NO_BANKRUPTCY_LOSS')
      end
    end

    def process_insurance_claim!(task)
      bankruptcy = @repository.bankruptcy_check_for(task.task_id)
      raise ManualReviewRequired, 'bankruptcy check is missing' unless bankruptcy

      loss = decimal_value(bankruptcy, :bankruptcy_loss)
      result = @repository.insurance_claim_for(task.task_id)
      result ||= @loss_mitigation_client.claim_insurance(
        task_id: task.task_id,
        risk_decision_id: task.risk_decision_id,
        requested_amount: loss.to_s('F'),
        currency: value(bankruptcy, :currency)
      )
      assert_completed!(result, 'insurance claim')
      result = @repository.record_insurance_claim!(task, result)
      covered = decimal_value(result, :covered_amount)
      raise ManualReviewRequired, 'insurance covered amount exceeds bankruptcy loss' if covered > loss

      @repository.append_event!(task, 'INSURANCE_CLAIM_COMPLETED', result)
      if covered >= loss
        settle_and_complete!(task, 'BANKRUPTCY_LOSS_INSURED')
      else
        @repository.transition!(
          task,
          Liquidation::ADL_REQUIRED,
          'ADL_REQUIRED',
          residual_loss: (loss - covered).to_s('F')
        )
      end
    end

    def process_adl_request!(task)
      if task.status == Liquidation::ADL_REQUIRED
        @repository.transition!(task, Liquidation::ADL_EXECUTING, 'ADL_EXECUTION_STARTED')
      end
      bankruptcy = @repository.bankruptcy_check_for(task.task_id)
      insurance = @repository.insurance_claim_for(task.task_id)
      raise ManualReviewRequired, 'loss records are incomplete for ADL' unless bankruptcy && insurance

      residual = decimal_value(bankruptcy, :bankruptcy_loss) - decimal_value(insurance, :covered_amount)
      request = @repository.adl_request_for(task.task_id)
      request ||= @loss_mitigation_client.request_adl(
        task_id: task.task_id,
        risk_decision_id: task.risk_decision_id,
        requested_amount: residual.to_s('F'),
        currency: value(bankruptcy, :currency)
      )
      request = @repository.record_adl_request!(task, request)
      @repository.append_event!(task, 'ADL_REQUESTED', request)
      @repository.transition!(task, Liquidation::ADL_SETTLEMENT_PENDING, 'ADL_SETTLEMENT_PENDING')
      reconcile_adl_request!(task) if value(request, :status) == 'COMPLETED'
    end

    def reconcile_adl_request!(task)
      request = @repository.adl_request_for(task.task_id)
      raise ManualReviewRequired, 'ADL request is missing' unless request

      result = @loss_mitigation_client.find_adl_request(adl_request_id: value(request, :adl_request_id))
      raise RetryableError, "ADL request #{value(request, :adl_request_id)} is not queryable" unless result
      return task unless value(result, :status) == 'COMPLETED'

      handle_adl_settlement(
        event_id: "reconciled_adl_#{value(request, :adl_request_id)}",
        task_id: task.task_id,
        adl_request_id: value(request, :adl_request_id),
        status: 'COMPLETED',
        covered_amount: value(result, :covered_amount),
        source: 'RECONCILIATION'
      )
    end

    def settle_and_complete!(task, event_type, payload = {})
      @repository.with_transaction do
        @repository.transition!(task, Liquidation::SETTLED, event_type, payload)
        complete!(task)
      end
    end

    def assert_completed!(result, operation)
      unless value(result, :status) == 'COMPLETED'
        raise RetryableError, "#{operation} is #{value(result, :status)}"
      end
    end

    def decimal_value(hash, key)
      BigDecimal((value(hash, key) || '0').to_s)
    end

    def execute_action!(task, execution_protection: nil, execution_decision: nil)
      case task.action
      when 'CANCEL_RISK_ORDERS' then execute_cancel_orders!(task)
      when 'REDUCE_POSITION', 'LIQUIDATE_POSITION'
        submit_position_order!(
          task,
          execution_protection: execution_protection,
          execution_decision: execution_decision
        )
      else raise InvalidCommand, "unsupported action #{task.action.inspect}"
      end
    end

    def validate_execution_price!(task)
      return nil unless task.bankruptcy_price
      raise InvalidCommand, 'market data client is not configured' unless @market_data_client

      quote = @market_data_client.find(symbol: task.symbol)
      protection = @price_protection.validate!(task, quote)
      @repository.append_event!(task, 'EXECUTION_PRICE_PROTECTED', protection.merge(quote: quote.snapshot))
      protection
    end

    def plan_child_order!(task, execution_protection)
      step = @repository.next_execution_step(task.task_id)
      raise ManualReviewRequired, 'no executable liquidation step found' unless step

      decision = @adaptive_execution_strategy.plan(
        task: task,
        step: step,
        execution_protection: execution_protection,
        submitted_child_orders: @repository.order_attempt_count(task.task_id)
      )
      if task.execution_strategy == 'ADAPTIVE'
        @repository.append_event!(
          task,
          'CHILD_ORDER_PLANNED',
          execution_strategy: task.execution_strategy,
          execution_urgency: task.execution_urgency,
          remaining_quantity: step.remaining_quantity.to_s('F'),
          quantity: decision.fetch(:quantity).to_s('F'),
          order_type: decision.fetch(:order_type),
          market_depth_quantity: decision.fetch(:market_depth_quantity).to_s('F'),
          depth_quantity_cap: decision.fetch(:depth_quantity_cap).to_s('F'),
          child_order_sequence: decision.fetch(:child_order_sequence)
        )
        @metrics&.increment('liquidation_child_order_planned_total', labels: { symbol: task.symbol })
      end
      decision
    end

    def enforce_execution_backpressure!(task)
      return unless task.position_action?

      active = @repository.active_order_count_for_symbol(task.symbol, excluding_task_id: task.task_id)
      return if active < @max_active_orders_per_symbol

      raise ExecutionBackpressure,
            "symbol #{task.symbol} has #{active} active liquidation orders, limit #{@max_active_orders_per_symbol}"
    end

    def authorize_execution_quantity!(task, position)
      return nil unless task.position_action?

      step = @repository.next_execution_step(task.task_id)
      return BigDecimal('0') unless step
      return step.remaining_quantity if task.quantity_mode == 'EXACT'

      target_remaining = [task.target_quantity - task.executed_quantity, BigDecimal('0')].max
      authorized_remaining = [task.max_executable_quantity - task.executed_quantity, BigDecimal('0')].max
      maximum = [position.size, target_remaining, authorized_remaining].min
      allocated = @repository.cap_execution_plan!(task, max_remaining_quantity: maximum)
      @repository.append_event!(
        task,
        'EXECUTION_QUANTITY_AUTHORIZED',
        quantity_mode: task.quantity_mode,
        current_position_size: position.size.to_s('F'),
        executable_quantity: allocated.to_s('F'),
        position_version: position.version
      )
      allocated
    end

    def complete_without_order!(task, position)
      task.settled_position_version = position.version
      @repository.transition!(
        task,
        Liquidation::SETTLED,
        'NO_EXECUTABLE_QUANTITY',
        quantity_mode: task.quantity_mode,
        position_version: position.version
      )
      complete!(task, quantity_mode: task.quantity_mode)
    end

    def execute_cancel_orders!(task)
      result = @order_client.cancel_risk_orders(
        task_id: task.task_id,
        risk_decision_id: task.risk_decision_id,
        user_id: task.user_id,
        symbol: task.symbol
      )
      @repository.append_event!(task, 'RISK_ORDERS_CANCELLED', result.snapshot)
      @repository.transition!(task, Liquidation::SETTLED, 'CANCEL_ACTION_SETTLED', result.snapshot)
      complete!(task, cancelled_order_ids: result.cancelled_order_ids)
    end

    def submit_position_order!(task, execution_protection: nil, execution_decision: nil)
      step = @repository.next_execution_step(task.task_id)
      raise ManualReviewRequired, 'no executable liquidation step found' unless step

      @repository.transition!(task, Liquidation::ORDER_SUBMITTING, 'ORDER_SUBMITTING')
      started_at = monotonic_time
      attempt, result = @step_executor.call(task: task, step: step) do |client_order_id, attempt_sequence|
        order_attributes(
          task,
          step,
          client_order_id,
          attempt_sequence,
          execution_protection,
          execution_decision
        )
      end
      @metrics&.observe('liquidation_order_submit_latency_seconds', monotonic_time - started_at)
      apply_order_result!(task, result, attempt: attempt)
    end

    def order_attributes(task, step, client_order_id, attempt_sequence,
                         execution_protection = nil, execution_decision = nil)
      decision = execution_decision || {
        quantity: step.remaining_quantity,
        order_type: step.order_type,
        time_in_force: step.time_in_force,
        limit_price: nil,
        child_order_sequence: nil,
        market_depth_quantity: nil,
        depth_quantity_cap: nil,
        quantity_increment: nil
      }
      attributes = {
        client_order_id: client_order_id,
        task_id: task.task_id,
        execution_step: step.step_sequence,
        order_attempt: attempt_sequence,
        risk_decision_id: task.risk_decision_id,
        risk_unit_id: task.execution_scope_id,
        position_id: task.position_id,
        expected_position_version: task.settled_position_version || task.position_version,
        fencing_token: task.fencing_token,
        user_id: task.user_id,
        account_id: task.account_id,
        symbol: task.symbol,
        side: task.position_side == 'LONG' ? 'SELL' : 'BUY',
        type: decision.fetch(:order_type),
        quantity: decision.fetch(:quantity).to_s('F'),
        reduce_only: true,
        source: 'LIQUIDATION',
        time_in_force: decision.fetch(:time_in_force),
        max_slippage: step.max_slippage&.to_s('F'),
        execution_strategy: task.execution_strategy,
        execution_urgency: task.execution_urgency,
        child_order_sequence: decision[:child_order_sequence],
        limit_price: decision[:limit_price],
        market_depth_quantity: decision[:market_depth_quantity]&.to_s('F'),
        depth_quantity_cap: decision[:depth_quantity_cap]&.to_s('F'),
        max_book_participation: task.max_book_participation&.to_s('F'),
        quantity_increment: decision[:quantity_increment]&.to_s('F')
      }
      attributes.merge!(execution_protection) if execution_protection
      if task.portfolio_plan_id
        plan = @repository.find_portfolio_plan!(task.portfolio_plan_id)
        snapshot = @repository.risk_snapshot_for(task.task_id) || {}
        attributes.merge!(
          portfolio_plan_id: task.portfolio_plan_id,
          plan_item_sequence: task.plan_item_sequence,
          authorized_notional: task.authorized_notional.to_s('F'),
          notional_reference_price: fetch(snapshot, :mark_price).to_s,
          expected_account_version: plan.current_account_version
        )
      end
      attributes
    end

    def apply_order_result!(task, result, attempt: nil)
      attempt ||= @repository.order_attempt_for(
        task.task_id,
        order_id: result.order_id,
        client_order_id: result.client_order_id
      )
      raise NotFound, 'order attempt not found for order result' unless attempt

      event = result.snapshot
      disposition = update_attempt!(task, attempt, result)
      if disposition == :stale
        @repository.append_event!(task, 'ORDER_EVENT_SEQUENCE_IGNORED', event)
        return
      end
      if disposition == :status_regression
        @repository.append_event!(task, 'ORDER_STATUS_REGRESSION_IGNORED', event)
        return
      end
      case result.status
      when 'ACCEPTED'
        if task.status == Liquidation::PARTIALLY_FILLED
          @repository.append_event!(task, 'ORDER_STATUS_REGRESSION_IGNORED', event)
        elsif task.status == Liquidation::ORDER_ACCEPTED
          @repository.append_event!(task, 'ORDER_ACCEPTED_RECONCILED', event)
        else
          @repository.transition!(task, Liquidation::ORDER_ACCEPTED, 'ORDER_ACCEPTED', event)
        end
      when 'PARTIALLY_FILLED'
        if task.status == Liquidation::PARTIALLY_FILLED
          @repository.append_event!(task, 'ORDER_PARTIAL_FILL_UPDATED', event)
        else
          @repository.transition!(task, Liquidation::PARTIALLY_FILLED, 'ORDER_PARTIALLY_FILLED', event)
        end
      when 'FILLED'
        if task.status == Liquidation::SETTLEMENT_PENDING
          @repository.append_event!(task, 'ORDER_FILL_RECONCILED', event)
          return
        end
        @repository.transition!(task, Liquidation::FILLED, 'ORDER_FILLED', event)
        @repository.transition!(task, Liquidation::SETTLEMENT_PENDING, 'SETTLEMENT_PENDING')
      when 'REJECTED', 'CANCELLED'
        if result.filled_quantity.positive?
          @repository.transition!(
            task,
            Liquidation::FILLED,
            "ORDER_#{result.status}_WITH_PARTIAL_FILL",
            event
          )
          @repository.transition!(task, Liquidation::SETTLEMENT_PENDING, 'PARTIAL_FILL_SETTLEMENT_PENDING')
        else
          raise RetryableError, "liquidation order #{result.status.downcase}"
        end
      else
        raise ManualReviewRequired, "unknown order status #{result.status.inspect}"
      end
    end

    def apply_order_event!(task, event, attempt:)
      status = fetch(event, :status)
      filled_quantity = value(event, :filled_quantity) || attempt.executed_quantity
      average_price = value(event, :average_price)
      fee = value(event, :fee)
      result = OrderResult.new(
        order_id: fetch(event, :order_id),
        client_order_id: value(event, :client_order_id),
        status: status,
        filled_quantity: filled_quantity,
        average_price: average_price,
        fee: fee,
        event_sequence: fetch(event, :order_event_sequence),
        payload: event
      )
      apply_order_result!(task, result, attempt: attempt)
    end

    def update_attempt!(task, attempt, result)
      disposition = @repository.update_order_attempt!(
        task,
        attempt: attempt,
        status: result.status,
        executed_quantity: result.filled_quantity,
        average_price: result.average_price,
        fee: result.fee,
        event_sequence: result.event_sequence,
        response: result.snapshot
      )
      observe_slippage(task, result) if disposition == :applied
      disposition
    end

    def observe_slippage(task, result)
      return unless @metrics && result.average_price

      snapshot = @repository.risk_snapshot_for(task.task_id) || {}
      mark_price = value(snapshot, :mark_price)
      return unless mark_price && BigDecimal(mark_price.to_s).positive?

      mark = BigDecimal(mark_price.to_s)
      slippage = ((result.average_price - mark).abs / mark).to_f
      @metrics.observe('liquidation_slippage_observed', slippage, labels: { symbol: task.symbol })
    end

    def schedule_next_execution!(task, event)
      cooldown_ms = task.execution_strategy == 'ADAPTIVE' ? task.child_order_cooldown_ms.to_i : 0
      if cooldown_ms.positive?
        task.next_retry_at = @clock.call + (cooldown_ms / 1000.0)
        @repository.transition!(
          task,
          Liquidation::RETRY_WAIT,
          'CHILD_ORDER_COOLDOWN',
          event.merge(next_child_order_at: task.next_retry_at.iso8601, cooldown_ms: cooldown_ms)
        )
      else
        @repository.transition!(task, Liquidation::PENDING, 'NEXT_EXECUTION_STEP_PENDING', event)
      end
    end

    def adaptive_order_timed_out?(task, attempt, result)
      return false unless task.execution_strategy == 'ADAPTIVE'
      return false unless %w[ACCEPTED PARTIALLY_FILLED].include?(result.status)

      (@clock.call - attempt.updated_at) * 1000 >= task.child_order_timeout_ms
    end

    def defer_task!(task, error)
      return task if task.terminal?

      task.next_retry_at = @clock.call + @execution_defer_seconds
      task.error_code = error.class.name.split('::').last
      task.error_message = error.message
      @repository.transition!(
        task,
        Liquidation::RETRY_WAIT,
        'EXECUTION_DEFERRED',
        error: task.error_code,
        message: task.error_message,
        next_retry_at: task.next_retry_at.iso8601
      )
      @metrics&.increment('liquidation_execution_deferred_total', labels: { error: task.error_code })
      task
    rescue InvalidTransition
      manual_review!(task, error)
    end

    def complete!(task, extra = {})
      mitigation = @repository.bankruptcy_check_for(task.task_id) ? @repository.loss_mitigation_summary(task.task_id) : {}
      payload = {
        schema_version: 1,
        event_id: "result_#{task.task_id}",
        task_id: task.task_id,
        risk_decision_id: task.risk_decision_id,
        risk_unit_id: task.risk_unit_id,
        decision_sequence: task.decision_sequence,
        action: task.action,
        execution_priority: task.priority,
        quantity_mode: task.quantity_mode,
        execution_strategy: task.execution_strategy,
        execution_urgency: task.execution_urgency,
        child_order_count: @repository.order_attempt_count(task.task_id),
        status: 'COMPLETED',
        requested_quantity: task.target_quantity&.to_s('F'),
        executed_quantity: task.executed_quantity.to_s('F'),
        average_price: task.average_price&.to_s('F'),
        authorized_bankruptcy_price: task.bankruptcy_price&.to_s('F'),
        position_version_before: task.position_version,
        position_version_after: task.settled_position_version
      }.merge(mitigation).merge(extra)
      @repository.with_transaction do
        @repository.transition!(task, Liquidation::RESULT_PUBLISHING, 'RESULT_QUEUED')
        @repository.transition!(task, Liquidation::COMPLETED, 'TASK_COMPLETED', payload)
        if task.portfolio_plan_id
          @portfolio_plan_coordinator.complete_item!(task, payload)
        else
          @repository.enqueue_outbox!(task, topic: RESULT_TOPIC, payload: payload)
        end
      end
      @metrics&.increment('liquidation_task_completed_total', labels: { action: task.action })
    end

    def reject_with!(task, status, code, error)
      return task if task.terminal?

      task.error_code = code
      task.error_message = error.message
      @repository.with_transaction do
        @repository.transition!(task, status, code, message: error.message)
        if task.portfolio_plan_id
          @portfolio_plan_coordinator.fail_item!(task, failure_payload(task, retryable: false))
        else
          enqueue_failure_result!(task, retryable: false)
        end
      end
      task
    end

    def retry_task!(task, error)
      return task if task.terminal?

      return manual_review!(task, error) if task.retry_count >= @max_retry_count

      @repository.schedule_retry!(task, error)
      task
    rescue InvalidTransition
      manual_review!(task, error)
    end

    def manual_review!(task, error)
      return task if task.terminal?

      task.error_code = error.class.name.split('::').last
      task.error_message = error.message
      @repository.with_transaction do
        @repository.transition!(task, Liquidation::MANUAL_REVIEW, 'MANUAL_REVIEW_REQUIRED', message: error.message)
        if task.portfolio_plan_id
          @portfolio_plan_coordinator.fail_item!(
            task,
            failure_payload(task, retryable: false),
            manual_review: true
          )
        else
          enqueue_failure_result!(task, retryable: false)
        end
      end
      @metrics&.increment('liquidation_task_manual_review_total', labels: { error: task.error_code })
      task
    end

    def enqueue_failure_result!(task, retryable:)
      @repository.enqueue_outbox!(
        task,
        topic: RESULT_TOPIC,
        payload: failure_payload(task, retryable: retryable)
      )
    end

    def failure_payload(task, retryable:)
      {
        schema_version: 1,
        event_id: "result_#{task.task_id}", task_id: task.task_id,
        risk_decision_id: task.risk_decision_id, risk_unit_id: task.risk_unit_id,
        decision_sequence: task.decision_sequence, action: task.action,
        execution_priority: task.priority, quantity_mode: task.quantity_mode,
        execution_strategy: task.execution_strategy, execution_urgency: task.execution_urgency,
        child_order_count: @repository.order_attempt_count(task.task_id),
        status: task.status, error_code: task.error_code,
        error_message: task.error_message, retryable: retryable,
        executed_quantity: task.executed_quantity.to_s('F')
      }
    end

    def fetch(hash, key)
      result = value(hash, key)
      raise MissingField, "missing #{key} in event" if result.nil?

      result
    end

    def value(hash, key)
      hash.key?(key) ? hash[key] : hash[key.to_s]
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
