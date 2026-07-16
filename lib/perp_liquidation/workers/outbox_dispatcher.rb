# frozen_string_literal: true

require 'socket'

module PerpLiquidation
  module Workers
    class OutboxDispatcher
      def initialize(repository:, publisher:, worker_id: nil, lease_seconds: 30,
                     max_attempts: 10, base_delay_seconds: 1)
        @repository = repository
        @publisher = publisher
        @worker_id = worker_id || "outbox-#{Socket.gethostname}-#{Process.pid}"
        @lease_seconds = lease_seconds
        @max_attempts = max_attempts
        @base_delay_seconds = base_delay_seconds
        @last_heartbeat_at = nil
        @metrics = nil
      end


      attr_writer :metrics

      def perform
        @repository.with_connection do
          heartbeat_if_due
          events = @repository.claim_outbox_events!(
            worker_id: @worker_id,
            lease_seconds: @lease_seconds
          )
          events.each do |event|
            @metrics&.observe('liquidation_outbox_lag_seconds', Time.now.utc - event.created_at)
            begin
              @publisher.publish(topic: event.topic, payload: event.payload, event_id: event.event_id)
              @repository.mark_outbox_published!(event)
              @metrics&.increment('liquidation_outbox_published_total', labels: { topic: event.topic })
            rescue StandardError => e
              @repository.mark_outbox_failed!(
                event,
                e,
                max_attempts: @max_attempts,
                base_delay_seconds: @base_delay_seconds
              )
              @metrics&.increment('liquidation_outbox_failure_total', labels: { topic: event.topic })
              if event.dead_lettered_at
                @metrics&.increment('liquidation_outbox_dead_letter_total', labels: { topic: event.topic })
              end
            end
          end
          events.length
        end
      end

      private

      def heartbeat_if_due
        now = Time.now.utc
        return if @last_heartbeat_at && @last_heartbeat_at > now - 10

        @repository.heartbeat_worker!(
          worker_id: @worker_id,
          worker_type: 'OUTBOX',
          lease_seconds: 30,
          metadata: { pid: Process.pid }
        )
        @last_heartbeat_at = now
      end
    end
  end
end
