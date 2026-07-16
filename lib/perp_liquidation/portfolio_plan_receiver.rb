# frozen_string_literal: true

module PerpLiquidation
  class PortfolioPlanReceiver
    def initialize(repository:, account_client:, coordinator: nil, metrics: nil)
      @repository = repository
      @account_client = account_client
      @coordinator = coordinator || PortfolioPlanCoordinator.new(repository: repository)
      @metrics = metrics
    end

    def call(payload)
      command = PortfolioLiquidationCommand.from_hash(payload)
      existing = @repository.find_portfolio_plan_by_risk_decision_id(command.risk_decision_id)
      return existing if existing

      account = @account_client.find(account_id: command.account_id)
      validate_account!(command, account)

      child_commands = command.child_commands
      @repository.with_portfolio_scope_admission!(
        risk_unit_id: command.risk_unit_id,
        decision_sequence: command.decision_sequence,
        risk_decision_id: command.risk_decision_id
      ) do
        plan = @repository.create_portfolio_plan!(command)
        command.items.zip(child_commands).each_with_index do |(item, child_command), index|
          task = @repository.create_from_command!(child_command)
          if index.zero?
            @repository.transition!(task, Liquidation::PENDING, 'PORTFOLIO_ITEM_ACTIVATED', plan_id: plan.plan_id)
            item_status = 'RUNNING'
          else
            @repository.transition!(task, Liquidation::PLAN_WAITING, 'PORTFOLIO_ITEM_WAITING', plan_id: plan.plan_id)
            item_status = 'WAITING'
          end
          @repository.create_portfolio_plan_item!(plan, task: task, item: item, status: item_status)
        end
        plan.status = 'EXECUTING'
        plan.current_item_sequence = 1
        @repository.update_portfolio_plan!(plan)
        @repository.append_portfolio_plan_event!(plan, 'PORTFOLIO_PLAN_STARTED', item_count: plan.item_count)
        @metrics&.increment('liquidation_portfolio_plan_received_total', labels: { margin_mode: plan.margin_mode })
        plan
      end
    end

    def cancel(plan_id, reason:)
      raise InvalidCommand, 'portfolio cancel reason is required' if reason.to_s.empty?

      @coordinator.cancel_plan!(plan_id, reason: reason)
    end

    private

    def validate_account!(command, account)
      unless account.account_id == command.account_id
        raise PreconditionsFailed, "account mismatch: expected #{command.account_id}, got #{account.account_id}"
      end
      unless account.user_id.to_s == command.user_id.to_s
        raise PreconditionsFailed, "account user mismatch: expected #{command.user_id}, got #{account.user_id}"
      end
      unless account.version == command.account_version
        raise PreconditionsFailed,
              "account_version mismatch: expected #{command.account_version}, got #{account.version}"
      end
      unless account.margin_mode == command.margin_mode
        raise PreconditionsFailed,
              "margin_mode mismatch: expected #{command.margin_mode}, got #{account.margin_mode}"
      end
      settlement_currency = command.risk_unit_id.split(':').last
      unless account.settlement_currency == settlement_currency
        raise PreconditionsFailed,
              "settlement currency mismatch: expected #{settlement_currency}, got #{account.settlement_currency}"
      end
    end
  end
end
