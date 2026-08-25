# NMG design completion audit

**Authority:** current requirement-to-evidence ledger. Normative intent remains
in [design.md](design.md); document ownership is defined by
[the documentation index](../README.md).

**Status:** requirement ledger
**Updated:** 2026-08-25
**Normative source:** [design.md](design.md)
**Implementation recovery:** [implementation-lineage.md](implementation-lineage.md)

This ledger answers two different questions without conflating them:

1. Is every intended NMG responsibility designed and owned by a component?
2. Has each optional policy earned default product activation?

The first can be complete while the second remains open. A missing natural-data
calibration is not permission to invent another subsystem; a passing unit test is
not evidence that a policy improves real Agent work.

## Status vocabulary

| State | Meaning |
| --- | --- |
| **Verified core** | Contract is designed, wired into the stable boundary, and covered by deterministic tests. |
| **Opt-in Lab** | Implemented and explicitly activatable, but omitted from the Lite default tool/prompt path. |
| **Calibration gate** | Mechanism exists; thresholds or default activation require independent natural evidence. |
| **Explicitly deferred** | Boundary is designed, but implementation waits for a stated prerequisite. |
| **Out of scope** | Another component owns it; NMG must only define an integration boundary. |

Lab is not a one-way holding area. An operator, user, harness, or Agent profile can
enable an individual Lab capability behind its feature gate. Passing an evaluation
is required to make it a Lite default, not to use it explicitly. Runtime model
self-enablement requires delegated harness authority; it is never inferred from a
model request alone.

## Requirement matrix

| Domain | Required contract | Implementation evidence | Current state | Remaining proof or work |
| --- | --- | --- | --- | --- |
| Product boundary | Local-first memory component; Pi is the primary optional adapter; Core/daemon do not require the Pi harness; no sandbox/cloud/runtime ownership | package manifest optional peer boundary, `extensions/nmg.ts`, `src/index.ts`, dependency-boundary test | **Verified core** | Package release/versioning and a future physical multi-package split are product work, not architecture work. |
| Stable model surface | Compact search, exact get, governed remember, separate temporary board | Pi tool registrations and prompt YAML | **Verified core** | Monitor schema drift in real Pi releases. |
| History and provenance | Retain useful source evidence; semantic memory remains mutable/rebuildable; rejected writes are auditable without retaining rejected content | store write/schema modules, evidence selection, write policy | **Verified core** | Physical erasure is a separate deferred privacy claim. |
| Semantic records | Typed facts, preferences, constraints, states, events and experience with stable IDs, actors, truth status, evidence roles and markers | `src/core/types.ts`, store writes and row parsing | **Verified core** | Natural extraction quality remains model/harness dependent. |
| Scope and time | Scope objects are conjunctions; conflicts require overlapping scope and half-open validity intervals | `src/core/semantic-domain.ts`, write/query boundaries | **Verified core** | None at the mechanism level. |
| Nodes and relations | Nodes may start isolated; deterministic operation-entailed edges write immediately; other edges require evidence, stability or review | graph policy/store modules and topology proposals | **Verified core** | Natural proposal precision is a **calibration gate**. |
| Temporal/logical chains | Optional ordered/DAG references reuse exact memory IDs; temporal order needs explicit time, logical order needs attributable supervision; chain expansion cannot imply truth or causality | chain store/retrieval, daemon protocol, CLI and chain tests | **Verified core** | Domain-specific automatic chain construction is a harness policy, not a Core default. |
| Node merge/split | Preserve redirects, transforms, provenance and rollback; automatic identity merge remains conservative | graph transforms, proposal review, maintenance actuator | **Calibration gate** | Collect true/false identity pairs, scope conflicts and rollback outcomes before default auto-merge. |
| STG/LTG residence | Session-private provisional STG; shared durable LTG; governed promotion, demotion, expiry and audit | `src/core/stg.ts`, store lifecycle and Pi turn-end maintenance | **Calibration gate** | Mechanics are verified; natural consolidation precision and retention thresholds are not. |
| Active Graph | Per-session budgeted projection, never a third authoritative graph; record selected nodes/edges/evidence and measured budget use | Active Graph store module, Pi search/get propagation | **Verified core** | Allocator and stopping priors need natural calibration. |
| Progressive disclosure | Resident directory/kernel, compact automatic recall, explicit search headers, exact get, bounded deeper expansion | integration search/projection, Pi recall flow | **Verified core** | Daily-use validation remains observational. |
| Retrieval | FTS/exact fallback, optional record embeddings, hybrid ranking, node/leaf hierarchy and query filters | integration search, embedding providers/sync, bounded leaf-then-node summary drain, hierarchy | **Verified core** | Provider and summary quality are configuration/evaluation concerns; exact-scan/ANN crossover is measurement work. |
| QPP and search recommendation | Independently switchable allocation, local folding and recommendation; preserve folded evidence in AG | QPP core, Pi modes, controller shadow | **Opt-in Lab** | Calibrate sufficiency and cost from independent outcomes before Lite promotion. |
| Differentiable controller | Framework-free autodiff substrate; learned heads cannot bypass hard safety/budget gates | `src/lab/autodiff.ts`, controller protocol/runtime/gate, matched telemetry and causal comparison | **Opt-in Lab** | Matched evidence remains calibration evidence, not Lite promotion; natural quality, cost and rollback gates are required. |
| Feedback and posterior | Separate disclosure, diagnostic overlap and verified evidence; prevent self-reinforcing labels | feedback core, claim outcomes, Pi shadow channel | **Verified core** | The natural dataset lacks verified evidence attribution, so learning/calibration stays blocked. |
| Edge activation/stability | Query-local activation differs from durable stability; retrieval alone cannot consolidate an edge | edge activation, Active Graph telemetry, consolidation/demotion | **Calibration gate** | Calibrate independent-task definition, decay and hysteresis on natural reversals. |
| Retention | Indexed L0-L3, dormant/unindexed L4, quarantine L5; protect critical evidence independently of prompt residency | hierarchy and maintenance modules, CLI retention operations | **Verified core** | Automatic physical purge remains **explicitly deferred**. |
| Delete/export/privacy | Logical withdrawal, dependency cleanup and user-memory export | CLI/RPC service and deletion tests | **Verified core** | Raw-history/aggregate physical erasure and receipts are **explicitly deferred** until threat-model/consent work. |
| Session reasoning scratchpad | Private, atomic, bounded, restart-resumable, explicit checkpoint tool; never silently promoted | Lab reasoning workspace and Pi adapter | **Opt-in Lab** | Automatic capture was rejected; cross-session transfer/promotion waits for demonstrated need. |
| Memory-Graph Reasoner | Numerical graph/set reasoning prototype is independent from durable truth | Lab MGR/autodiff modules | **Opt-in Lab** | Edge-following inference and utility proof remain optional experiments. |
| Temporary coordination | Task Board is TTL/cursor/attribution based and does not enter LTG/FTS | board store, daemon, CLI/Pi/MCP adapters | **Verified core** | ACLs and multi-device transport are **explicitly deferred**. |
| Daemon and concurrency | One application authority/single LTG writer; synchronous SQLite phases serialize; no transaction spans an await | CLI daemon/service/client and concurrency tests | **Verified core** | Multi-process distributed writers are out of current scope. |
| Observability | Trace routing, scores, budgets, disclosures, outcomes, maintenance and rollback without treating diagnostics as truth | trace tables, shadow JSONL, reports/audits | **Verified core** | Natural labels must accumulate through use. |
| Benchmarks | Official-format adapters, matched arms, cacheable embeddings and fail-closed scoring | evaluation adapters and benchmark scripts | **Verified core** | Larger/repeated capability runs are evaluation work, not missing design. |
| Agent development and quality | Dynamic repository context, owned documentation, product/research/chaos test tracks, temporary guardrail lifecycle, and composable resource cleanup | root bootstrap, repo-development Skill, context tool, CI workflow, Cordis-backed test wrapper | **Verified core** | Research characterization remains non-blocking and cannot redefine product contracts. |
| Cloud and sandbox | Pluggable future integration only; no default dependency | explicit product boundary | **Out of scope** | Pi sandbox plugins own execution isolation; cloud waits for multi-device scope. |

## Actual active blockers

Only three blockers currently prevent evidence-backed default activation of the
adaptive policies:

1. Natural Pi tasks rarely contain independently verified claim/evidence outcomes.
2. Retrieval/controller gains have not yet passed matched quality **and** token,
   tool-round, latency, and rollback gates.
3. Unattended STG consolidation and identity merge lack natural false-positive,
   contradiction, and reversal coverage.

These are validation blockers, not missing storage, graph, routing, or lifecycle
designs. Their executable checklist lives in [temporary-todo.md](temporary-todo.md).

## Completion rule

The NMG design is structurally complete when every intended responsibility is in
this matrix with an owner, invariant, activation authority, and evidence gate.
NMG is product-proven only when the active blockers pass on independent natural
use. New mechanisms should be added only when an observed failure cannot be
resolved by an existing owner; otherwise they increase maintenance cost without
closing a requirement.

Commit hashes are recorded only when they materially shorten recovery or prevent
repeating a superseded design. The curated owner map and notation live in
[implementation-lineage.md](implementation-lineage.md); Git remains the exhaustive
changelog.
