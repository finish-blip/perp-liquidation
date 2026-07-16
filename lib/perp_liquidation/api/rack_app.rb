# frozen_string_literal: true

require 'json'

module PerpLiquidation
  module API
    class RackApp
      def initialize(repository:, command_receiver: nil, portfolio_plan_receiver: nil,
                     operator_action_service: nil, orchestrator: nil, reconciliation_worker: nil,
                     metrics: nil, service_token: nil)
        @repository = repository
        @command_receiver = command_receiver
        @portfolio_plan_receiver = portfolio_plan_receiver
        @operator_action_service = operator_action_service
        @orchestrator = orchestrator
        @reconciliation_worker = reconciliation_worker
        @metrics = metrics
        @service_token = service_token
      end

      def call(env)
        repository.with_connection do
          method = env['REQUEST_METHOD']
          path = env['PATH_INFO'].to_s
          return json(200, status: 'ok', service: 'perp-liquidation') if method == 'GET' && path == '/health'
          return json(401, error: 'unauthorized') unless authorized?(env)
          return metrics_response if method == 'GET' && path == '/metrics'
          return receive_command(env) if method == 'POST' && path == '/api/v1/internal/liquidation/commands'
          if method == 'POST' && path == '/api/v1/internal/liquidation/portfolio-plans'
            return receive_portfolio_plan(env)
          end
          if method == 'POST' && path.match?(%r{\A/api/v1/internal/liquidation/portfolio-plans/[^/]+/cancel\z})
            return cancel_portfolio_plan(env, path)
          end
          if method == 'GET' && path.match?(%r{\A/api/v1/internal/liquidation/portfolio-plans/(?:by-risk-decision/)?[^/]+\z})
            return show_portfolio_plan(path)
          end
          return execute_operator_action(env) if method == 'POST' && path == '/api/v1/internal/liquidation/operator-actions'
          if method == 'GET' && path.match?(%r{\A/api/v1/internal/liquidation/operator-actions/[^/]+\z})
            return show_operator_action(path)
          end
          return cancel_command(env, path) if method == 'POST' && path.match?(%r{\A/api/v1/internal/liquidation/commands/[^/]+/cancel\z})
          return consume_order_event(env) if method == 'POST' && path == '/api/v1/internal/liquidation/events/orders'
          return consume_settlement_event(env) if method == 'POST' && path == '/api/v1/internal/liquidation/events/settlements'
          return consume_adl_settlement_event(env) if method == 'POST' && path == '/api/v1/internal/liquidation/events/adl-settlements'
          return list_reconciliation_issues(env) if method == 'GET' && path == '/api/v1/internal/liquidation/reconciliation/issues'
          if method == 'GET' && path == '/api/v1/internal/liquidation/reconciliation/outbox/dead-letters'
            return list_outbox_dead_letters(env)
          end
          return reconcile_task(path) if method == 'POST' && path.match?(%r{\A/api/v1/internal/liquidation/tasks/[^/]+/reconcile\z})
          return replay_outbox(path) if method == 'POST' && path.match?(%r{\A/api/v1/internal/liquidation/tasks/[^/]+/replay-outbox\z})
          return list_tasks(env) if method == 'GET' && path == '/api/v1/internal/liquidation/tasks'

          show_task(method, path)
        end
      rescue NotFound => e
        json(404, error: 'not_found', message: e.message)
      rescue StaleDecision, InvalidTransition => e
        json(409, error: 'conflict', message: e.message)
      rescue MissingField, InvalidCommand, PreconditionsFailed, JSON::ParserError => e
        json(422, error: 'invalid_command', message: e.message)
      rescue StandardError => e
        json(500, error: 'internal_error', message: e.message)
      end

      private

      attr_reader :repository, :command_receiver, :portfolio_plan_receiver, :operator_action_service,
                  :orchestrator, :reconciliation_worker, :metrics, :service_token

      def authorized?(env)
        return true if service_token.nil?

        supplied = env['HTTP_AUTHORIZATION'].to_s
        secure_compare(supplied, "Bearer #{service_token}")
      end

      def secure_compare(left, right)
        return false unless left.bytesize == right.bytesize

        left.bytes.zip(right.bytes).reduce(0) { |result, (a, b)| result | (a ^ b) }.zero?
      end

      def receive_command(env)
        return json(503, error: 'command_receiver_unavailable') unless command_receiver

        task = command_receiver.call(JSON.parse(env['rack.input'].read))
        status = task.status == Liquidation::REJECTED ? 409 : 202
        json(status, data: LiquidationSerializer.call(task))
      end

      def receive_portfolio_plan(env)
        return json(503, error: 'portfolio_plan_receiver_unavailable') unless portfolio_plan_receiver

        plan = portfolio_plan_receiver.call(JSON.parse(env['rack.input'].read))
        json(202, portfolio_plan_response_body(plan))
      end

      def cancel_portfolio_plan(_env, _path)
        json(
          403,
          error: 'dual_approval_required',
          message: 'use POST /api/v1/internal/liquidation/operator-actions'
        )
      end

      def show_portfolio_plan(path)
        risk_prefix = '/api/v1/internal/liquidation/portfolio-plans/by-risk-decision/'
        plan = if path.start_with?(risk_prefix)
                 decision_id = path.delete_prefix(risk_prefix)
                 repository.find_portfolio_plan_by_risk_decision_id(decision_id)
               else
                 repository.find_portfolio_plan!(path.split('/').last)
               end
        raise NotFound, 'portfolio liquidation plan not found' unless plan

        json(200, portfolio_plan_response_body(plan))
      end

      def portfolio_plan_response_body(plan)
        items = repository.portfolio_plan_items_for(plan.plan_id)
        {
          data: LiquidationSerializer.normalize(plan.snapshot),
          items: items.map do |item|
            task = repository.find!(item.task_id)
            LiquidationSerializer.normalize(item.snapshot.merge(task: task.snapshot))
          end,
          events: repository.portfolio_plan_events_for(plan.plan_id).map do |event|
            {
              plan_id: event.plan_id,
              event_type: event.event_type,
              payload: LiquidationSerializer.normalize(event.payload),
              created_at: event.created_at.iso8601
            }
          end
        }
      end

      def execute_operator_action(env)
        return json(503, error: 'operator_action_service_unavailable') unless operator_action_service

        action = operator_action_service.call(JSON.parse(env['rack.input'].read))
        json(202, data: operator_action_payload(action))
      end

      def show_operator_action(path)
        action = repository.operator_action(path.split('/').last)
        raise NotFound, 'operator action not found' unless action

        json(200, data: operator_action_payload(action))
      end

      def operator_action_payload(action)
        LiquidationSerializer.normalize(
          operation_id: action.operation_id,
          action: action.action,
          target_type: action.target_type,
          target_id: action.target_id,
          operator_id: action.operator_id,
          approver_id: action.approver_id,
          approval_id: action.approval_id,
          reason: action.reason,
          status: action.status,
          result: action.result,
          created_at: action.created_at,
          completed_at: action.completed_at
        )
      end

      def list_tasks(env)
        query = parse_query(env['QUERY_STRING'].to_s)
        rows = repository.all.select { |task| matches_query?(task, query) }
        json(200, data: rows.map { |task| LiquidationSerializer.call(task) })
      end

      def cancel_command(env, path)
        return json(503, error: 'command_receiver_unavailable') unless command_receiver

        match = %r{\A/api/v1/internal/liquidation/commands/([^/]+)/cancel\z}.match(path)
        body = JSON.parse(env['rack.input'].read)
        reason = body['reason'].to_s
        raise InvalidCommand, 'cancel reason is required' if reason.empty?

        task = command_receiver.cancel(match[1], reason: reason)
        json(200, data: LiquidationSerializer.call(task))
      end

      def consume_order_event(env)
        return json(503, error: 'orchestrator_unavailable') unless orchestrator

        task = orchestrator.handle_order_event(JSON.parse(env['rack.input'].read))
        json(202, data: task && LiquidationSerializer.call(task), duplicate: task.nil?)
      end

      def consume_settlement_event(env)
        return json(503, error: 'orchestrator_unavailable') unless orchestrator

        task = orchestrator.handle_settlement_event(JSON.parse(env['rack.input'].read))
        json(202, data: task && LiquidationSerializer.call(task), duplicate: task.nil?)
      end

      def consume_adl_settlement_event(env)
        return json(503, error: 'orchestrator_unavailable') unless orchestrator

        task = orchestrator.handle_adl_settlement(JSON.parse(env['rack.input'].read))
        json(202, data: task && LiquidationSerializer.call(task), duplicate: task.nil?)
      end

      def list_reconciliation_issues(env)
        query = parse_query(env['QUERY_STRING'].to_s)
        issues = repository.reconciliation_issues(status: query['status'], task_id: query['task_id'])
        json(200, data: issues.map { |issue| LiquidationSerializer.normalize(issue.snapshot) })
      end

      def list_outbox_dead_letters(env)
        query = parse_query(env['QUERY_STRING'].to_s)
        limit = Integer(query.fetch('limit', '100'))
        raise InvalidCommand, 'limit must be between 1 and 500' unless limit.between?(1, 500)

        events = repository.dead_letter_outbox(limit: limit)
        json(200, data: events.map { |event| LiquidationSerializer.normalize(event.to_h) })
      end

      def reconcile_task(path)
        return json(503, error: 'reconciliation_worker_unavailable') unless reconciliation_worker

        task_id = path.split('/')[-2]
        task = repository.find!(task_id)
        unless Workers::ReconciliationWorker::RECOVERABLE_STATES.include?(task.status)
          raise InvalidCommand, "task #{task.task_id} in #{task.status} is not reconcilable"
        end

        reconciliation_worker.reconcile(task)
        json(
          202,
          data: LiquidationSerializer.call(task),
          issues: repository.reconciliation_issues(task_id: task.task_id).map do |issue|
            LiquidationSerializer.normalize(issue.snapshot)
          end
        )
      end

      def replay_outbox(path)
        task_id = path.split('/')[-2]
        task = repository.find!(task_id)
        replayed = repository.replay_outbox_for_task!(task.task_id)
        raise NotFound, "task #{task.task_id} has no outbox events" if replayed.zero?

        repository.append_event!(task, 'OUTBOX_REPLAY_REQUESTED', replayed_events: replayed)
        json(202, data: LiquidationSerializer.call(task), replayed_events: replayed)
      end

      def show_task(method, path)
        return json(405, error: 'method_not_allowed') unless method == 'GET'

        risk_match = %r{\A/api/v1/internal/liquidation/tasks/by-risk-decision/([^/]+)\z}.match(path)
        if risk_match
          task = repository.find_by_risk_decision_id(risk_match[1])
          raise NotFound, "risk decision #{risk_match[1]} not found" unless task
          return task_response(task)
        end

        match = %r{\A/api/v1/internal/liquidation/tasks/([^/]+)\z}.match(path)
        return json(404, error: 'not_found') unless match

        task_response(repository.find!(match[1]))
      end

      def task_response(task)
        json(
          200,
          data: LiquidationSerializer.call(task),
          risk_snapshot: LiquidationSerializer.normalize(repository.risk_snapshot_for(task.task_id)),
          execution: LiquidationSerializer.normalize(repository.execution_for(task.task_id)),
          execution_plan: repository.execution_plan_for(task.task_id).map(&:snapshot),
          order_attempts: repository.order_attempts_for(task.task_id).map(&:snapshot),
          reconciliation_issues: repository.reconciliation_issues(task_id: task.task_id).map(&:snapshot),
          loss_mitigation: LiquidationSerializer.normalize(repository.loss_mitigation_summary(task.task_id)),
          events: repository.events_for(task.task_id).map { |event| LiquidationSerializer.event(event) }
        )
      end

      def matches_query?(task, query)
        return false if query['user_id'] && task.user_id.to_s != query['user_id'].to_s
        return false if query['symbol'] && task.symbol != query['symbol']
        return false if query['status'] && task.status != query['status']
        return false if query['risk_unit_id'] && task.risk_unit_id != query['risk_unit_id']

        true
      end

      def parse_query(query_string)
        query_string.split('&').each_with_object({}) do |pair, result|
          key, value = pair.split('=', 2)
          next if key.nil? || key.empty?

          result[decode(key)] = decode(value.to_s)
        end
      end

      def decode(value)
        value.tr('+', ' ').gsub(/%[0-9A-Fa-f]{2}/) { |encoded| encoded[1..].to_i(16).chr }
      end

      def json(status, body)
        [status, { 'Content-Type' => 'application/json' }, [JSON.generate(body)]]
      end

      def metrics_response
        return json(503, error: 'metrics_unavailable') unless metrics

        [200, { 'Content-Type' => 'text/plain; version=0.0.4' }, [metrics.render]]
      end
    end
  end
end
