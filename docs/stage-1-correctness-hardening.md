# Stage 1 correctness hardening

Stage 1 changes execution safety only. It does not calculate margin ratios,
liquidation prices, liquidation eligibility, or liquidation quantities. Those
remain risk-engine responsibilities.

## Database concurrency

Real mode uses a fixed-size MySQL connection pool. A checked-out connection is
bound to the current thread and reused by nested repository calls. Transaction
depth is thread-local, so concurrent Puma requests and workers cannot join or
commit another request's transaction.

Configuration:

```text
DATABASE_POOL_SIZE=10
DATABASE_POOL_TIMEOUT_SECONDS=5
DATABASE_CONNECT_TIMEOUT_SECONDS=5
DATABASE_READ_TIMEOUT_SECONDS=5
DATABASE_WRITE_TIMEOUT_SECONDS=5
```

`DATABASE_POOL_SIZE` must be at least 2. The execution thread can hold one
connection while the lock renewal thread uses another to renew the durable
risk-unit lease.

## Order lifecycle contract

Every live `order.lifecycle` event must contain a positive sequence that is
monotonic for one order attempt:

```json
{
  "event_id": "order_event_123",
  "order_id": "ord_123",
  "client_order_id": "liq_task_step_1_attempt_1",
  "status": "PARTIALLY_FILLED",
  "order_event_sequence": 12,
  "filled_quantity": "0.006",
  "average_price": "54180",
  "fee": "0.1"
}
```

The repository locks the attempt row before comparing the sequence. Events at
or below `last_event_sequence` are audited and ignored. Cumulative filled
quantity cannot decrease, become negative, or exceed requested quantity. A
`FILLED` event must report exactly the requested quantity. Violations preserve
the previous execution totals and move the task to `MANUAL_REVIEW`.

Apply this migration before deploying consumers:

```text
db/migrations/005_add_order_event_sequence.sql
```

Fresh Compose databases run it automatically. Existing named volumes require
the normal migration runner or an explicit one-time migration; MySQL does not
rerun `/docker-entrypoint-initdb.d` for an existing data directory.

## Settlement contract

Settlement confirmation has no fallback to the current attempt. All identity
fields are mandatory:

```json
{
  "event_id": "settlement_123",
  "task_id": "liq_task",
  "order_id": "ord_123",
  "position_id": 888,
  "position_version": 43
}
```

The order must belong to the task's current filled step, the position must
match the authorized position, and `position_version` must be newer than the
previous settled or commanded position version. Reconciliation uses the same
checks and requires the position service lookup to return both `order_id` and
`position_id`.

## Risk-unit lease and fencing

Redis provides fast mutual exclusion and renews the lock periodically. MySQL
table `liquidation_risk_unit_leases` is the durable active-slot invariant. Each
acquisition advances the persisted fencing token, including reacquisition by
the same task for a later execution step. Redis renewal also renews the MySQL
lease; a lost ownership check fails execution rather than silently continuing.

```text
RISK_UNIT_LOCK_TTL_SECONDS=30
RISK_UNIT_LOCK_RENEWAL_SECONDS=10
```

Releasing a lease expires it but retains its fencing token history.

## Downstream timeouts

Order, position, loss-mitigation, and risk-result HTTP clients install the
Faraday default adapter and use bounded timeouts:

```text
HTTP_OPEN_TIMEOUT_SECONDS=2
HTTP_READ_TIMEOUT_SECONDS=5
```

Timeouts become retryable execution errors; they cannot hold a risk-unit lock
indefinitely.

## Verification

```bash
ruby -Ilib -S rspec
ruby bin/real_mode_smoke
ruby bin/real_mode_smoke --multi-step
ruby bin/real_mode_smoke --reconcile
ruby bin/stream_smoke
```
