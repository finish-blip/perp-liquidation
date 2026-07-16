# frozen_string_literal: true

module PerpLiquidation
  class StepExecutor
    def initialize(repository:, order_client:)
      @repository = repository
      @order_client = order_client
    end

    def call(task:, step:)
      previous = @repository.current_order_attempt(task.task_id, step.step_sequence)
      return reconcile(previous) if previous&.submission_uncertain?

      attempt_sequence = previous ? previous.attempt_sequence + 1 : 1
      client_order_id = "#{task.task_id}_step_#{step.step_sequence}_attempt_#{attempt_sequence}"
      attributes = yield(client_order_id, attempt_sequence)
      attempt = @repository.create_order_attempt!(
        step,
        attempt_sequence: attempt_sequence,
        client_order_id: client_order_id,
        requested_quantity: attributes.fetch(:quantity),
        request: attributes
      )
      result = @order_client.submit_liquidation_order(attributes)
      @repository.attach_order_result!(task, step: step, attempt: attempt, result: result)
      [attempt, result]
    end

    private

    def reconcile(attempt)
      result = @order_client.find_by_client_order_id(client_order_id: attempt.client_order_id)
      raise RetryableError, "order #{attempt.client_order_id} is not queryable yet" unless result

      task = @repository.find!(attempt.task_id)
      step = @repository.execution_step(attempt.task_id, attempt.step_sequence)
      @repository.attach_order_result!(task, step: step, attempt: attempt, result: result)
      [attempt, result]
    end
  end
end
