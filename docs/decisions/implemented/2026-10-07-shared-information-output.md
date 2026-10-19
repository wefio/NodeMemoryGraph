# Shared information-output foundations for AG and Task Board

**Status:** implemented
**Approved:** explicit
**Relates to:** [Maintained-state proposal](../proposed/2026-10-06-ag-state-transitions.md)

中文版: [2026-10-07-shared-information-output.zh-CN.md](2026-10-07-shared-information-output.zh-CN.md) · [Terms used](2026-10-07-shared-information-output.terms.yaml)

## Problem

AG display previews can lose trailing constraints, board results repeat long conventions, and text-only adapter formatting lacks a shared source-bound preparation boundary. A foundation is needed without changing private-state ownership or requiring a host-specific executor.

## Decision

Start the shared-view and pure-slimming work from the [maintained-state proposal](../proposed/2026-10-06-ag-state-transitions.md#64-smallest-implementation-sequence), without implementing its current-state writer or host-input replacement yet. This note records the implemented foundation, not completion of slice A or acceptance of unverified performance claims.

- Core owns admitted `InformationView` and domain-specific source handles. AG and Task Board retain their storage, authority, permissions and state machines. The view is not a raw graph, a new store, or write authority.
- `prepareInformationOutput` snapshots admitted data and produces text, included source fingerprints and omitted views. Body and required labels are indivisible; oversized rows are omitted, never silently clipped. The text budget includes separators and an omission notice when it fits. Zero/tiny budgets still retain omissions in structured data. Source identity is canonical, independent of property insertion order; different namespaces remain distinct.
- `confirmInformationOutput` accepts an exact rendered-fragment match and produces reader-local acknowledgement candidates. Changed/clipped text confirms nothing; an empty reader identity confirms nothing; another session cannot confirm private AG content. A receipt is neither authentication, acceptance, nor a disclosure-ledger write. The trusted host must establish actual visibility and source authorization before any future ledger commitment.
- Ordinary tool text goes through the same preparation as library consumers. There is no Pi/codemode import, script executor, extra output tool or required orchestration step. Existing tool/RPC operations remain available; compact board DTOs add optional delivery/verdict metadata rather than changing collaboration operations.
- AG shows whole admitted temporary statements with necessary temporary/hypothesis labels, excluding semantic memories and other frames. In particular, a 500-character display preview may not remove a trailing constraint.
- Board display preserves addressing, channel differences, routing, pending/claim state, acknowledgements, complete artifact digest and independent verdict. Existing owner-provided body previews remain previews; lone memory pointers use the existing body-view rule. Long conventions are explicitly requested through `includeConventions: true`, not repeated by default. A transport cursor is withheld from text when entries were omitted, since an internal read does not prove those entries were shown.

The existing 8,000-character AG display ceiling is reused as the preparation default, counted in JavaScript UTF-16 code units. This bounds the prepared text only: machine data, host wrappers and other NMG surfaces are not a combined input budget. `full`/`preview` describes this admitted view, not exact semantic-memory evidence. Callers must deliberately select model-visible fields; a field name alone is no proof of visibility.

## Consequences

Contracts live at [`information-view.ts`](../../../src/core/information-view.ts); pure preparation/confirmation at [`information-output.ts`](../../../src/integration/information-output.ts); domain projection and compatible text interfaces at [`agent-surface.ts`](../../../src/integration/agent-surface.ts). The package exports these interfaces through `src/index.ts`. Board preview projection remains owned by `types.ts` and `store/base.ts`; prompt wording remains owned by `nmg-prompts.yaml` and its generator.

Deterministic regressions cover intact constraints, protected-label budgets and omissions, canonical deduplication, source/status/preview fingerprint changes, immutable prepared snapshots, reader-local AG confirmation, rewritten output, ordinary JSON/library consumption, complete board artifact identity, unchanged creation cursors after verdict updates, and cursor withholding after budget omission. Existing board claim/delivery/judgment tests must continue to pass; preparation itself performs no disclosure write.

## Deferred

Dedicated `working_state` replace/clear and captured-generation fencing are now implemented separately in the [bounded current-state slice](2026-10-08-ag-working-state.md), with an explicit session-frame adapter fallback. Host-confirmed output-to-ledger wiring, authorization/version rechecks, one combined dynamic-surface budget, semantic task identity beyond that fallback, other-host input selection and matched model-cost/quality evaluation remain open. Pi dedicated state selection/restoration is recorded separately in the [input-selection slice](2026-10-08-ag-working-state-input.md); final confirmation remains unsupported. No live LLM, embedding call or memory benchmark was run for this foundation. Deterministic tests do not establish context-growth savings or continuity benefits in a live host.

## Alternatives considered

- A codemode-only entry point or executor: rejected; ordinary tools and library data already provide the portable baseline.
- Per-adapter formatting and early disclosure writes: rejected; shared preparation avoids format drift, while actual host exposure remains a separate boundary.
- A universal short header or truncated state body: rejected; unnecessary wrapping costs tokens and truncation can lose the exact condition being maintained.
