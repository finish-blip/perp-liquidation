# Liquidation execution plans

## Compatibility

The existing version 1 risk command remains valid. When `execution_plan` is
absent, the service creates one execution step from the existing instruction:

```json
{
  "instruction": {
    "target_quantity": "0.01",
    "max_executable_quantity": "0.01",
    "order_type": "MARKET",
    "reduce_only": true,
    "time_in_force": "IOC",
    "max_slippage": "0.005"
  }
}
```

## Multi-step command

`execution_plan.steps` is optional and additive to the version 1 contract.
Step quantities must be positive and their sum must equal
`instruction.target_quantity`. A plan supports at most 32 steps.

```json
{
  "instruction": {
    "target_quantity": "0.01",
    "max_executable_quantity": "0.01",
    "order_type": "MARKET",
    "reduce_only": true,
    "time_in_force": "IOC",
    "max_slippage": "0.005"
  },
  "execution_plan": {
    "steps": [
      {
        "quantity": "0.004",
        "order_type": "LIMIT",
        "time_in_force": "IOC",
        "max_slippage": "0.002"
      },
      {
        "quantity": "0.006",
        "order_type": "MARKET",
        "time_in_force": "IOC",
        "max_slippage": "0.005"
      }
    ]
  }
}
```

Missing `order_type`, `time_in_force`, or `max_slippage` values inherit the
corresponding value from `instruction`.

## Execution semantics

Steps execute serially. A filled step must receive a position settlement
confirmation before the next step becomes eligible. The task then returns to
`PENDING`, is claimed again, obtains a new risk-unit lock and fencing token,
and validates the latest settled position version before submitting the next
order.

Every order submission is an attempt. An explicit `REJECTED` or `CANCELLED`
result allows a new attempt for the remaining step quantity. If submission is
uncertain because the response was lost, the service keeps the same attempt
and queries the order service by `client_order_id`; it does not submit a second
order.

Client order IDs have this format:

```text
{task_id}_step_{step_sequence}_attempt_{attempt_sequence}
```

## Task details

`GET /api/v1/internal/liquidation/tasks/{taskId}` keeps the legacy
`execution` field and adds:

```json
{
  "execution_plan": [],
  "order_attempts": []
}
```

The legacy `liquidation_executions` table is dual-written during the migration
period. The canonical records are `liquidation_execution_steps` and
`liquidation_order_attempts`.

## Database migration

Apply `db/migrations/002_create_execution_plans.sql` once to an existing
database before deploying the new application processes. Fresh Docker Compose
databases load migrations in this order:

```text
001_create_liquidation_tables.sql
002_create_execution_plans.sql
001_create_reference_service_tables.sql
```

## Verification

Run the in-memory suite and both real-mode smoke paths:

```bash
ruby -Ilib -S rspec
ruby bin/real_mode_smoke
ruby bin/real_mode_smoke --multi-step
ruby bin/real_mode_smoke --reconcile
```
