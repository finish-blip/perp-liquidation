# frozen_string_literal: true

module PerpLiquidation
  class CommandReceiver
    SUPERSEDEABLE_STATUSES = [
      Liquidation::RECEIVED, Liquidation::PENDING, Liquidation::CLAIMED,
      Liquidation::LOCKING, Liquidation::VALIDATING, Liquidation::RETRY_WAIT
    ].freeze

    def initialize(repository:, metrics: nil)
      @repository = repository
      @metrics = metrics
    end

    def call(payload)
      command = LiquidationCommand.from_hash(payload)
      @metrics&.increment('liquidation_task_received_total', labels: { action: command.action })
      @repository.with_risk_unit_admission!(risk_unit_id: command.risk_unit_id) do
        existing = @repository.find_by_risk_decision_id(command.risk_decision_id)
        next existing if existing

        previous_latest = @repository.latest_sequence(command.risk_unit_id)
        task = @repository.create_from_command!(command)
        if previous_latest && command.decision_sequence <= previous_latest
          @repository.transition!(
            task,
            Liquidation::REJECTED,
            'STALE_DECISION_REJECTED',
            latest_sequence: previous_latest
          )
          enqueue_terminal_result!(task, 'STALE_DECISION')
          next task
        end

        supersede_older_tasks!(task)
        @repository.transition!(task, Liquidation::PENDING, 'TASK_PENDING')
      end
    end

    def cancel(risk_decision_id, reason:)
      task = @repository.find_by_risk_decision_id(risk_decision_id)
      raise NotFound, "risk decision #{risk_decision_id} not found" unless task
      return task if task.terminal?

      unless SUPERSEDEABLE_STATUSES.include?(task.status)
        raise InvalidTransition, "task #{task.task_id} cannot be cancelled from #{task.status}"
      end

      task.error_code = 'CANCELLED_BY_RISK'
      task.error_message = reason
      @repository.transition!(task, Liquidation::CANCELLED, 'DECISION_CANCELLED', reason: reason)
      enqueue_terminal_result!(task, 'CANCELLED_BY_RISK')
      task
    end

    private

    def supersede_older_tasks!(new_task)
      @repository.active_for_risk_unit(new_task.risk_unit_id).each do |task|
        next if task.task_id == new_task.task_id
        next unless task.decision_sequence < new_task.decision_sequence

        if SUPERSEDEABLE_STATUSES.include?(task.status)
          @repository.transition!(task, Liquidation::SUPERSEDED, 'TASK_SUPERSEDED', superseded_by: new_task.task_id)
          enqueue_terminal_result!(task, 'SUPERSEDED_BY_NEWER_DECISION')
        else
          @repository.append_event!(task, 'NEWER_DECISION_WAITING', task_id: new_task.task_id)
        end
      end
    end

    def enqueue_terminal_result!(task, error_code)
      @repository.enqueue_outbox!(
        task,
        topic: Orchestrator::RESULT_TOPIC,
        payload: {
          event_id: "result_#{task.task_id}", task_id: task.task_id,
          risk_decision_id: task.risk_decision_id, risk_unit_id: task.risk_unit_id,
          decision_sequence: task.decision_sequence, action: task.action,
          status: task.status, error_code: error_code,
          error_message: task.error_message, retryable: false,
          executed_quantity: task.executed_quantity.to_s('F')
        }
      )
    end
  end
end
