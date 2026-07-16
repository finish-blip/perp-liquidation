# Cross-module contracts

This directory is the machine-readable integration boundary for the liquidation engine.
`manifest.json` records every supported event topic, direction, owner, schema version,
schema file, and executable example. `openapi/` describes the internal HTTP surface and
`schemas/` uses JSON Schema Draft-07 for event payloads.

## Ownership

The module named by an event's `owner` field owns the producer contract. Producers must
validate payloads before publication. Consumers must tolerate additive optional fields and
must reject unsupported schema versions before causing external side effects. The
liquidation module owns `liquidation.execution.result` and the HTTP API description.

## Versioning policy

A change is backward compatible only when it adds an optional property or introduces a new
versioned schema file. Removing a property, changing `required`, narrowing or widening an
enum, or changing types, constants, patterns, bounds, references, conditionals, or
combinators is treated as breaking. Breaking changes require a new schema version and a
parallel migration; an existing versioned file must not be rewritten in place.

Legacy inbound v1 event producers may omit `schema_version` where the current schema marks
it optional. This is a temporary transition rule for `order.lifecycle`, settlement, ADL,
and reconciliation events. New producers should always emit it. Risk command versions
remain mandatory because they select domain semantics.

## Deployment order

1. Add the new versioned schema, examples, and consumer support while retaining the old version.
2. Deploy consumers and verify contract tests plus unknown-version rejection.
3. Deploy producers and monitor rejected-event and dead-letter metrics.
4. Stop old-version production only after all producers have migrated.
5. Remove old consumer support in a later release after the retention and replay window closes.

Pull requests compare existing schema files with their Git base using
`ruby bin/check_contract_compatibility <base-ref>`. Examples and references are validated by
the RSpec suite. Contract changes must be deployed in the order above and coordinated with
the owner recorded in `manifest.json`.
