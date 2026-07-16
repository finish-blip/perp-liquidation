# frozen_string_literal: true

require 'socket'

module PerpLiquidation
  module Workers
    class LiquidationWorker
      def initialize(repository:, orchestrator:, worker_id: nil, lease_seconds: 30, priority_aging_seconds: 30)
        @repository = repository
        @orchestrator = orchestrator
        @worker_id = worker_id || "liquidation-#{Socket.gethostname}-#{Process.pid}"
        @lease_seconds = lease_seconds
        @priority_aging_seconds = Float(priority_aging_seconds)
        raise InvalidCommand, 'priority_aging_seconds must be positive' unless @priority_aging_seconds.positive?
        @last_heartbeat_at = nil
      end

      def perform_once
        @repository.with_connection do
          heartbeat_if_due
          task = @repository.claim_next_task!(
            worker_id: @worker_id,
            lease_seconds: @lease_seconds,
            priority_aging_seconds: @priority_aging_seconds
          )
          next nil unless task

          @orchestrator.execute(task)
        end
      end

      private

      def heartbeat_if_due
        now = Time.now.utc
        return if @last_heartbeat_at && @last_heartbeat_at > now - 10

        @repository.heartbeat_worker!(
          worker_id: @worker_id,
          worker_type: 'LIQUIDATION',
          lease_seconds: 30,
          metadata: { pid: Process.pid }
        )
        @last_heartbeat_at = now
      end
    end
  end
end
