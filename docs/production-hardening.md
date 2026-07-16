# Production scheduling, delivery, metrics, and Redis Streams

## Task scheduling

Tasks are ordered by server-assigned priority and creation time:

```text
LIQUIDATE_POSITION   10
CANCEL_RISK_ORDERS   20
REDUCE_POSITION      50
```

Claims contain `claimed_by` and `claim_expires_at`. An expired claim can be
recovered only from `CLAIMED`, `LOCKING`, or `VALIDATING`, before an order side
effect is recorded. Fencing tokens continue to protect order submission after
a worker pause or network partition.

Workers heartbeat in `liquidation_worker_leases`.

## Outbox delivery

Dispatchers atomically claim rows using `locked_by` and `locked_until`.
Failures are isolated per event and use capped exponential backoff. The default
maximum is 10 attempts; exhausted events are marked with `dead_lettered_at`.

Configuration:

```text
OUTBOX_MAX_ATTEMPTS=10
OUTBOX_BASE_DELAY_SECONDS=1
```

Operations:

```http
GET  /api/v1/internal/liquidation/reconciliation/outbox/dead-letters
POST /api/v1/internal/liquidation/operator-actions
```

Replay resets attempts, locks, backoff, and dead-letter state while preserving
the original event ID. Use `action=REPLAY_OUTBOX`; direct replay endpoints are
blocked and production mode verifies the approval through `APPROVAL_SERVICE_URL`.

## Metrics

Authenticated Prometheus endpoint:

```http
GET /metrics
```

Real mode stores metric aggregates in Redis so the API, workers, Outbox
dispatcher, and Streams consumer contribute to one process-independent view.
Memory mode keeps an in-process registry for tests and local embedding.

Emitted series include:

```text
liquidation_task_received_total
liquidation_task_completed_total
liquidation_task_manual_review_total
liquidation_order_submit_latency_seconds_count
liquidation_order_submit_latency_seconds_sum
liquidation_settlement_latency_seconds_count
liquidation_settlement_latency_seconds_sum
liquidation_lock_wait_seconds_count
liquidation_lock_wait_seconds_sum
liquidation_outbox_lag_seconds_count
liquidation_outbox_lag_seconds_sum
liquidation_outbox_published_total
liquidation_outbox_failure_total
liquidation_outbox_dead_letter_total
liquidation_reconciliation_issue_total
liquidation_slippage_observed_count
liquidation_slippage_observed_sum
```

## Redis Streams

The optional Streams consumer uses the existing Redis deployment and consumer
groups. Supported input streams:

```text
risk.liquidation.command
order.lifecycle
position.settlement.confirmed
adl.settlement.confirmed
liquidation.reconcile.requested
```

Messages contain `event_id` and a JSON `payload`. Domain Inbox handling remains
the source of idempotency. Failed messages are retried from the consumer pending
list and moved to `{stream}.dead` after the configured delivery limit.

Configuration:

```text
EVENT_STREAMS_ENABLED=true
EVENT_STREAM_GROUP=perp-liquidation
EVENT_STREAM_CONSUMER=perp-liquidation-1
EVENT_STREAM_MAX_ATTEMPTS=5
```

Set `RESULT_TRANSPORT=redis_streams` to publish liquidation result Outbox events
to Redis Streams. The default remains the existing HTTP risk callback.

## Migration

Apply `db/migrations/004_harden_scheduling_and_outbox.sql` and
`db/migrations/005_add_order_event_sequence.sql` before deploying the new
workers. The latter is required before order lifecycle events are consumed.
