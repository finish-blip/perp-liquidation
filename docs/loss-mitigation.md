# Bankruptcy, insurance fund, and ADL orchestration

## Service boundary

The liquidation service does not calculate bankruptcy prices, bankruptcy loss,
insurance fund capacity, or ADL ranking. It sends execution and settlement
facts to authoritative external services and persists their responses.

The orchestration sequence is:

```text
SETTLEMENT_PENDING
  -> BANKRUPTCY_CHECKING
  -> INSURANCE_CLAIMING       when bankruptcy_loss > 0
  -> ADL_REQUIRED             when insurance coverage is insufficient
  -> ADL_EXECUTING
  -> ADL_SETTLEMENT_PENDING
  -> SETTLED
  -> RESULT_PUBLISHING
  -> COMPLETED
```

No-loss checks and fully insured losses skip the unnecessary later states.

## External contracts

The configured loss mitigation service must provide:

```http
POST /api/v1/internal/bankruptcy/checks
POST /api/v1/internal/insurance/claims
POST /api/v1/internal/adl/requests
GET  /api/v1/internal/adl/requests/{adlRequestId}
```

Every request includes `task_id` as an idempotency key. External services must
return the same logical record when a request is repeated after a timeout.

The ADL service may also push completion:

```http
POST /api/v1/internal/liquidation/events/adl-settlements
```

```json
{
  "event_id": "adl_settlement_123",
  "task_id": "liq_risk_123",
  "adl_request_id": "adl_liq_risk_123",
  "status": "COMPLETED",
  "covered_amount": "6"
}
```

## Persistence

Authoritative responses are stored in:

```text
liquidation_bankruptcy_checks
liquidation_insurance_claims
liquidation_adl_requests
```

Apply `db/migrations/003_create_loss_mitigation_tables.sql` before starting the
loss mitigation worker.

## Result fields

Completed position-liquidation results include:

```json
{
  "bankruptcy_price": "54000",
  "bankruptcy_loss": "10",
  "insurance_fund_covered": "4",
  "adl_triggered": true,
  "adl_request_id": "adl_liq_risk_123",
  "adl_covered_amount": "6"
}
```

## Worker

`bin/loss_mitigation_worker` advances the orchestration and reconciles pending
ADL requests. External failures leave the task in its current state and create
one deduplicated `LOSS_MITIGATION` reconciliation issue.

Real-mode verification:

```bash
ruby bin/real_mode_smoke
ruby bin/real_mode_smoke --adl
ruby bin/real_mode_smoke --multi-step --reconcile --adl
```
