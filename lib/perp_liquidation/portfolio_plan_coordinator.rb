# frozen_string_literal: true

module PerpLiquidation
  class PortfolioPlanCoordinator
    RESULT_TOPIC = 'liquidation.execution.result'
    CANCELLABLE_TASK_STATUSES = %w[PLAN_WAITING PENDING CLAIMED LOCKING VALIDATING RETRY_WAIT].freeze

    def initialize(repository:)
      @repository = repository
    end

    def complete_item!(task, result)
      return nil unless task.portfolio_plan_id

      plan = @repository.find_portfolio_plan!(task.portfolio_plan_id)
      item = @repository.portfolio_plan_item_for_task(task.task_id)
      raise NotFound, "portfolio item for task #{task.task_id} not found" unless item
      return plan if item.terminal?

      @repository.with_transaction do
        item.status = 'COMPLETED'
        item.result = result
        item.completed_at = Time.now.utc
        @repository.update_portfolio_plan_item!(item)
        plan.completed_item_count += 1

        next_item = @repository.portfolio_plan_items_for(plan.plan_id).find { |candidate| candidate.status == 'WAITING' }
        if next_item
          next_task = @repository.find!(next_item.task_id)
          @repository.transition!(next_task, Liquidation::PENDING, 'PORTFOLIO_ITEM_ACTIVATED', plan_id: plan.plan_id)
          next_item.status = 'RUNNING'
          @repository.update_portfolio_plan_item!(next_item)
          plan.current_item_sequence = next_item.item_sequence
          plan.status = 'EXECUTING'
          @repository.update_portfolio_plan!(plan)
          @repository.append_portfolio_plan_event!(
            plan,
            'PORTFOLIO_ITEM_COMPLETED',
            item_sequence: item.item_sequence,
            task_id: task.task_id,
            next_item_sequence: next_item.item_sequence
          )
        else
          plan.status = 'COMPLETED'
          plan.current_item_sequence = nil
          plan.completed_at = Time.now.utc
          @repository.update_portfolio_plan!(plan)
          @repository.append_portfolio_plan_event!(plan, 'PORTFOLIO_PLAN_COMPLETED', plan_result_payload(plan))
          enqueue_plan_result!(plan, task)
        end
      end
      plan
    end

    def fail_item!(task, result, manual_review: false)
      return nil unless task.portfolio_plan_id

      plan = @repository.find_portfolio_plan!(task.portfolio_plan_id)
      item = @repository.portfolio_plan_item_for_task(task.task_id)
      raise NotFound, "portfolio item for task #{task.task_id} not found" unless item
      return plan if plan.terminal?

      @repository.with_transaction do
        item.status = 'FAILED'
        item.result = result
        item.completed_at = Time.now.utc
        @repository.update_portfolio_plan_item!(item)

        @repository.portfolio_plan_items_for(plan.plan_id).each do |candidate|
          next unless candidate.status == 'WAITING'

          waiting_task = @repository.find!(candidate.task_id)
          @repository.transition!(
            waiting_task,
            Liquidation::CANCELLED,
            'PORTFOLIO_PLAN_STOPPED',
            failed_item_sequence: item.item_sequence
          )
          candidate.status = 'SKIPPED'
          candidate.result = { reason: 'STOP_ON_FAILURE', failed_item_sequence: item.item_sequence }
          candidate.completed_at = Time.now.utc
          @repository.update_portfolio_plan_item!(candidate)
        end

        plan.status = manual_review ? 'MANUAL_REVIEW' : 'FAILED'
        plan.current_item_sequence = nil
        plan.error_code = result[:error_code] || result['error_code'] || task.error_code
        plan.error_message = result[:error_message] || result['error_message'] || task.error_message
        plan.completed_at = Time.now.utc
        @repository.update_portfolio_plan!(plan)
        @repository.append_portfolio_plan_event!(
          plan,
          manual_review ? 'PORTFOLIO_PLAN_MANUAL_REVIEW' : 'PORTFOLIO_PLAN_FAILED',
          failed_item_sequence: item.item_sequence,
          task_id: task.task_id,
          error_code: plan.error_code,
          error_message: plan.error_message
        )
        enqueue_plan_result!(plan, task)
      end
      plan
    end

    def cancel_plan!(plan_id, reason:)
      plan = @repository.find_portfolio_plan!(plan_id)
      return plan if plan.terminal?

      items = @repository.portfolio_plan_items_for(plan.plan_id)
      tasks = items.map { |item| @repository.find!(item.task_id) }
      blocked = tasks.find { |task| !task.terminal? && !CANCELLABLE_TASK_STATUSES.include?(task.status) }
      if blocked
        raise InvalidTransition,
              "portfolio plan #{plan.plan_id} cannot be cancelled while task #{blocked.task_id} is #{blocked.status}"
      end

      @repository.with_transaction do
        items.zip(tasks).each do |item, task|
          next if item.terminal?

          unless task.terminal?
            task.error_code = 'PORTFOLIO_PLAN_CANCELLED'
            task.error_message = reason
            @repository.transition!(task, Liquidation::CANCELLED, 'PORTFOLIO_PLAN_CANCELLED', reason: reason)
          end
          item.status = 'CANCELLED'
          item.result = { reason: reason }
          item.completed_at = Time.now.utc
          @repository.update_portfolio_plan_item!(item)
        end
        plan.status = 'CANCELLED'
        plan.current_item_sequence = nil
        plan.error_code = 'PORTFOLIO_PLAN_CANCELLED'
        plan.error_message = reason
        plan.completed_at = Time.now.utc
        @repository.update_portfolio_plan!(plan)
        @repository.append_portfolio_plan_event!(plan, 'PORTFOLIO_PLAN_CANCELLED', reason: reason)
        enqueue_plan_result!(plan, tasks.first)
      end
      plan
    end

    def plan_result_payload(plan)
      {
        schema_version: 1,
        event_id: "result_portfolio_#{plan.plan_id}",
        plan_id: plan.plan_id,
        risk_decision_id: plan.risk_decision_id,
        risk_unit_id: plan.risk_unit_id,
        decision_sequence: plan.decision_sequence,
        action: plan.action,
        status: plan.status,
        user_id: plan.user_id,
        account_id: plan.account_id,
        account_version: plan.account_version,
        current_account_version: plan.current_account_version,
        margin_mode: plan.margin_mode,
        execution_priority: plan.execution_priority,
        max_total_authorized_notional: plan.max_total_authorized_notional.to_s('F'),
        failure_mode: plan.failure_mode,
        item_count: plan.item_count,
        completed_item_count: plan.completed_item_count,
        error_code: plan.error_code,
        error_message: plan.error_message,
        items: @repository.portfolio_plan_items_for(plan.plan_id).map do |item|
          task = @repository.find!(item.task_id)
          {
            item_sequence: item.item_sequence,
            task_id: item.task_id,
            position_id: item.position_id,
            symbol: item.symbol,
            authorized_notional: item.authorized_notional.to_s('F'),
            status: item.status,
            executed_quantity: task.executed_quantity.to_s('F'),
            average_price: task.average_price&.to_s('F'),
            position_version_before: task.position_version,
            position_version_after: task.settled_position_version,
            error_code: task.error_code,
            error_message: task.error_message
          }
        end
      }
    end

    private

    def enqueue_plan_result!(plan, anchor_task)
      payload = plan_result_payload(plan)
      @repository.enqueue_outbox!(anchor_task, topic: RESULT_TOPIC, payload: payload)
    end
  end
end
