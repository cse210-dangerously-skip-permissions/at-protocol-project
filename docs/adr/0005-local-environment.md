# ADR 005: Local AT Protocol environment

- Status: proposed
- Date: 2026-11-20

## Context

Recovery tests need records and identities to survive restarts. Each experiment needs a clean starting state.

Routine tests must run without posting to Bluesky or relying on its availability. CI should not need hosted account credentials.

## Decision

Use the same Docker Compose stack for development, CI, and experiments. Run one personal data server (PDS) and one PostgreSQL-backed PLC directory on localhost. Pin the PDS image to `0.4.5051` and the PLC source to commit `29f1a70`. [Compose configuration](../../infra/compose.yaml)

Docker volumes preserve data across restarts. Run `npm run stack:reset` to start fresh. [Stack commands](../../infra/README.md)

Keep the project's PDS private. Use one throwaway account on a hosted PDS for the public-network smoke test.

## Alternatives considered

- **atproto-devnet / Snowglobe.** Devnet v0.2.0 used a PLC image tagged `latest`, which made builds hard to reproduce. Its successor, Snowglobe, lacked macOS support when evaluated. [Stack evaluation](https://github.com/cse210-dangerously-skip-permissions/at-protocol-project/issues/29#issuecomment-6786541474)
- **`@atproto/dev-env`.** Its in-memory PLC loses account identities on restart.

## Consequences

Consumers read the local PDS firehose directly. A single PDS without a relay cannot test federation or relay delivery. The stack uses plain HTTP and skips OAuth. Its `.test` handles do not resolve through public DNS.

Hosted smoke test date and result — pending [#74](https://github.com/cse210-dangerously-skip-permissions/at-protocol-project/issues/74).
