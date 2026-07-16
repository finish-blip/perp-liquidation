# frozen_string_literal: true

module PerpLiquidation
  class OperatorActionService
    ACTIONS = %w[CANCEL_PORTFOLIO_PLAN RECONCILE_TASK REPLAY_OUTBOX].freeze

    def initialize(repository:, portfolio_plan_receiver:, reconciliation_worker:, approval_client:)
      @repository = repository
      @portfolio_plan_receiver = portfolio_plan_receiver
      @reconciliation_worker = reconciliation_worker
      @approval_client = approval_client
    end

    def call(payload)
      attributes = normalize(payload)
      existing = @repository.operator_action(attributes.fetch(:operation_id))
      return existing if existing

      approval = @approval_client.verify!(attributes)
      action_record = @repository.create_operator_action!(attributes)
      result = execute(attributes)
      @repository.complete_operator_action!(
        action_record,
        status: 'COMPLETED',
        result: result.merge(approval: approval)
      )
    rescue StandardError => e
      if defined?(action_record) && action_record
        @repository.complete_operator_action!(
          action_record,
          status: 'FAILED',
          result: { error_class: e.class.name, message: e.message }
        )
      end
      raise
    end

    private

    def normalize(payload)
      attributes = {
        operation_id: fetch(payload, :operation_id).to_s,
        action: fetch(payload, :action).to_s,
        target_type: fetch(payload, :target_type).to_s,
        target_id: fetch(payload, :target_id).to_s,
        operator_id: fetch(payload, :operator_id).to_s,
        approver_id: fetch(payload, :approver_id).to_s,
        approval_id: fetch(payload, :approval_id).to_s,
        reason: fetch(payload, :reason).to_s
      }
      attributes.each do |key, value|
        raise InvalidCommand, "operator action #{key} is required" if value.empty?
      end
      raise InvalidCommand, "unsupported operator action #{attributes[:action].inspect}" unless ACTIONS.include?(attributes[:action])
      if attributes[:operator_id] == attributes[:approver_id]
        raise InvalidCommand, 'operator_id and approver_id must be different'
      end
      attributes
    end

    def execute(attributes)
      case attributes.fetch(:action)
      when 'CANCEL_PORTFOLIO_PLAN'
        raise InvalidCommand, 'target_type must be PORTFOLIO_PLAN' unless attributes[:target_type] == 'PORTFOLIO_PLAN'

        plan = @portfolio_plan_receiver.cancel(attributes[:target_id], reason: attributes[:reason])
        { plan: plan.snapshot }
      when 'RECONCILE_TASK'
        raise InvalidCommand, 'target_type must be TASK' unless attributes[:target_type] == 'TASK'

        task = @repository.find!(attributes[:target_id])
        unless Workers::ReconciliationWorker::RECOVERABLE_STATES.include?(task.status)
          raise InvalidTransition, "task #{task.task_id} in #{task.status} is not reconcilable"
        end
        @reconciliation_worker.reconcile(task)
        { task: task.snapshot }
      when 'REPLAY_OUTBOX'
        raise InvalidCommand, 'target_type must be TASK' unless attributes[:target_type] == 'TASK'

        task = @repository.find!(attributes[:target_id])
        replayed = @repository.replay_outbox_for_task!(task.task_id)
        raise NotFound, "task #{task.task_id} has no outbox events" if replayed.zero?

        @repository.append_event!(task, 'OPERATOR_OUTBOX_REPLAYED', operation_id: attributes[:operation_id])
        { task: task.snapshot, replayed_events: replayed }
      end
    end

    def fetch(hash, key)
      return hash[key] if hash.key?(key)
      return hash[key.to_s] if hash.key?(key.to_s)

      raise MissingField, "missing #{key} in operator action"
    end
  end
end
