# Shared temporal evidence at protocol boundaries

[简体中文](2026-10-22-shared-temporal-evidence.zh-CN.md) · [Terms](2026-10-22-shared-temporal-evidence.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

NMG already stores `eventTime`, retains it in compact search projections and
renders it in the shared Agent Surface. The local OmniMemEval bridge uses this
surface, but an AML response flattened to `content` alone can lose its historical
anchor before the answer model sees it. A second timestamp store or a separate
benchmark-only renderer would widen the product/evaluation gap.

## Decision

Reuse the existing temporal data model. The
[product retrieval contract](../../design/design/progressive-retrieval.md#temporal-evidence-presentation)
owns conditional plain-text presentation; the
[AML integration boundary](../../../evals/omnimemeval/README.md#integration-boundary)
owns wire aliases and backward compatibility. The renderer and AML record
projection live under `src/integration` and are exported from `src/index.ts`.
TypeScript and the thin Python protocol renderer consume one product-owned JSON
policy; the adapter installer distributes it with the client. Shared fixtures
check their observable parity. Existing rich Agent Surface output stays intact.

Raw utterance imports preserve validated message/session time regardless of
whether the text matches a display rule. Unknown historical time stays unknown;
creation and validity times keep their separate meanings. Rendering happens
after selection without mutating storage, evidence or retrieval inputs.

## Alternatives considered

- Add another source-time storage subsystem: unnecessary for raw utterance
  imports already represented by `eventTime`.
- Prefix persisted statements: changes embedding, deduplication and evidence
  inputs for what is only a presentation decision.
- Maintain Python or dataset-specific detection rules: duplicates policy and
  makes product/evaluation behavior drift.
- Always date every plain-text record: adds context even when the question and
  evidence do not require a temporal anchor.
- Guess a missing historical time from `createdAt`: creates false chronology.

## Consequences

Cloud adapters can project native records through the same library without
copying retrieval or temporal policy. The supplied v19 cloud backend receives a
separate source overlay because that deployed application's owner is outside
this repository; an overlay is not a deployment. Existing NMG AML responses
remain usable through their documented historical-time alias.

The policy is a bounded display heuristic, not a temporal reasoner. Contract and
offline service tests do not establish answer accuracy, Workers runtime behavior,
production rollout, or a new full LoCoMo score. The change does not import the
archive's unrelated retries, chunking or scoring changes, and does not explain
historical failures whose response bodies were not retained.
