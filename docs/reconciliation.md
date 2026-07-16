# Liquidation reconciliation

## Recoverable task states

The reconciliation worker scans stale tasks in these states:

```text
ORDER_SUBMITTING
ORDER_ACCEPTED
PARTIALLY_FILLED
FILLED
SETTLEMENT_PENDING
RESULT_PUBLISHING
```

Default stale thresholds range from 15 to 30 seconds. Every reconciliation
attempt updates the task check time, so unavailable dependencies are retried at
the configured stale interval rather than on every worker loop.

## Order reconciliation

The worker queries the order service using the existing `client_order_id`.
It never creates a second attempt just because the query timed out or returned
no result. A new attempt is allowed only after an authoritative `REJECTED` or
`CANCELLED` order status.

Missed `ACCEPTED`, `PARTIALLY_FILLED`, and `FILLED` events are applied through
the same orchestrator state transitions as live order events. Regressive order
states are recorded and ignored.

## Settlement reconciliation

The position service must expose an authoritative lookup:

```http
GET /api/v1/internal/positions/settlements/by-order-id/{orderId}
```

Example response:

```json
{
  "data": {
    "order_id": "ord_123",
    "position_id": 888,
    "settled": true,
    "position_version": 43
  }
}
```

The liquidation service does not infer settlement from a generic position
version change. A confirmed result is converted into an idempotent internal
settlement event.

## Reconciliation issues

Failed checks are stored in `liquidation_reconciliation_issues`. One open issue
is kept per task and issue type; repeated failures update it instead of creating
unbounded duplicates. A later successful check resolves the open issue.

Issue types:

```text
ORDER_RECONCILIATION
SETTLEMENT_RECONCILIATION
OUTBOX_RECONCILIATION
```

List issues:

```http
GET /api/v1/internal/liquidation/reconciliation/issues
GET /api/v1/internal/liquidation/reconciliation/issues?status=OPEN&task_id={taskId}
```

## Manual operations

Reconciliation and Outbox replay are controlled operations. Submit them through
the operator action endpoint with approval evidence verified by the configured
approval service:

```http
POST /api/v1/internal/liquidation/operator-actions
```

Use `action=RECONCILE_TASK` or `action=REPLAY_OUTBOX`, `target_type=TASK`, and
provide distinct operator/approver identities plus a valid `approval_id`.
The legacy direct task endpoints return `403 dual_approval_required`.

Outbox replay clears `published_at`; the existing dispatcher then republishes
the event with the same `event_id`. Downstream consumers must remain idempotent.
