# OmniMemEval HTTP transport for deployed memory services

[简体中文](2026-10-20-omnimemeval-http-transport.zh-CN.md) · [Terms](2026-10-20-omnimemeval-http-transport.terms.yaml)

**Status:** implemented
**Approved:** auto

## Problem

A local-bridge benchmark does not measure the deployed AML Add/Search service.
Duplicating suite runners or retrieving from a local database would bypass the
network, persistence, and isolation boundaries under test.

## Decision

The shared Python client has an opt-in HTTP transport alongside its default
NDJSON subprocess. The [integration owner](../../../evals/omnimemeval/README.md#integration-boundary)
defines configuration, identity mapping, response validation, and unsupported
operations. HTTP runs skip local embedding-provider preflight because the
deployed service owns that dependency.

Every remote benchmark user has an explicit experiment namespace. Content-derived
Add request identifiers permit deterministic replay without adding memory
extraction or retrieval logic to the client. Credentials stay in process
environments; redirects are refused. The client sends a transparent application
User-Agent so ordinary API traffic is not identified as Python-urllib.

Remote failures carry bounded, credential-redacted diagnostics through the
existing exception/logging path. This keeps transport evidence at its owner
without changing scheduling or retry policy. An HTTP status alone does not
identify an API error code; absent historical response bodies remain unknown.

## Alternatives considered

- Keep using the local bridge: it cannot establish deployed-service behavior.
- Build one HTTP wrapper per suite: it duplicates transport and protocol handling.
- Map benchmark deletion to remote reclamation: rejected because AML does not
  define a Delete contract and a service token is not general cleanup authority.
- Treat Add receipts as materialized records: rejected because operation-level
  scoring needs evidence that the AML receipt does not provide.

## Consequences

One runner retains upstream parsing, answer prompts, scoring, and checkpoints
for local and remote Add/Search evaluations. Remote operation-level HaluMem and
destructive streaming lifecycles remain unsupported. Namespace reuse is limited
to intentional resume; reclamation requires separate authorization.

A successful synthetic probe proves only connectivity and the exercised
contract. Dataset accuracy, throughput, tail latency, and isolation under load
require their own measured artifacts.
