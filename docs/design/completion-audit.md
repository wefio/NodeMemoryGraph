# NMG design completion audit

**Authority:** current requirement-to-evidence ledger. Normative intent remains
in [design.md](design.md); document ownership is defined by
[the documentation index](../README.md).

**Status:** requirement ledger
**Updated:** 2026-08-30
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
| **Designed target** | Normative target and ownership are accepted, but the current implementation still follows a superseded runtime shape. |
| **Calibration gate** | Mechanism exists; thresholds or default activation require independent natural evidence. |
| **Explicitly deferred** | Boundary is designed, but implementation waits for a stated prerequisite. |
| **Out of scope** | Another component owns it; NMG must only define an integration boundary. |

Lab is not a one-way holding area. The daemon publishes a capability directory and
session-scoped expiring leases through the existing client RPC. An Agent may
self-enable explicitly designated low-risk capabilities; controlled and active
actuation still require harness/operator authority and their existing receipts and
gates. Passing an evaluation is required to make a capability a Lite default, not
to use it explicitly for one suitable task.

## Requirement matrix

| Domain | Required contract | Implementation evidence | Current state | Remaining proof or work |
| --- | --- | --- | --- | --- |
| Product boundary | Local-first memory component; Pi is the primary optional adapter; Core/daemon do not require the Pi harness; no sandbox/cloud/runtime ownership | package manifest optional peer boundary, `extensions/nmg.ts`, `src/index.ts`, dependency-boundary test | **Verified core** | Package release/versioning and a future physical multi-package split are product work, not architecture work. |
| Stable model surface | Compact semantic/action headers without storage or scoring internals, exact get, governed remember, separate temporary board | shared `src/integration/agent-surface.ts` and `search-projection.ts`, prompt-owned headers, shared action contract, Pi/MCP/DSH thin registrations, OmniMemEval exact-evidence projection and cross-adapter contract tests | **Verified core** | Monitor host schema drift in real harness releases; semantic result changes belong in the shared surface first. |
| History and provenance | Retain useful source evidence; semantic memory remains mutable/rebuildable; rejected writes are auditable without retaining rejected content | store write/schema modules, evidence selection, write policy | **Verified core** | Physical erasure is a separate deferred privacy claim. |
| Semantic records | Typed facts, preferences, constraints, states, events and experience with stable IDs, actors, truth status, evidence roles, markers, and optional bounded recall triggers | `src/core/types.ts`, `src/core/recall-triggers.ts`, store writes/FTS rebuild and row parsing, CLI/Pi/MCP/DSH contract tests | **Verified core** | Natural extraction and trigger-selection quality remain model/harness dependent. |
| Scope and time | Scope objects are conjunctions; conflicts require overlapping scope and half-open validity intervals | `src/core/semantic-domain.ts`, write/query boundaries | **Verified core** | None at the mechanism level. |
| Nodes and relations | Nodes may start isolated; deterministic operation-entailed edges write immediately; other edges require evidence, stability or review | graph policy/store modules and topology proposals | **Verified core** | Natural proposal precision is a **calibration gate**. |
| Temporal/logical chains | Optional ordered/DAG references reuse exact memory IDs; temporal order needs explicit time, logical order needs attributable supervision; chain expansion cannot imply truth or causality | chain store/retrieval, exact-get hydration, STG/LTG edge merge, shared integration projection consumed by Pi/Claude plus CLI chain metadata, daemon protocol and chain tests | **Verified core** | Domain-specific automatic chain construction is a harness policy, not a Core default. |
| Node merge/split | Preserve redirects, transforms, provenance and rollback; automatic identity merge remains conservative | graph transforms, proposal review, maintenance actuator | **Calibration gate** | Collect true/false identity pairs, scope conflicts and rollback outcomes before default auto-merge. |
| STG/LTG residence | Session-private provisional STG; shared durable LTG; governed promotion, demotion, expiry and audit | `src/core/stg.ts`, explicit and opt-in scope-bound working-set sync, store lifecycle and Pi turn-end maintenance | **Calibration gate** | Mechanics are verified; natural sync cost/benefit, consolidation precision and retention thresholds are not. |
| Active Graph | Mutable, session-owned and memory-resident working graph; task frames, semantic/tool/reasoning content share a total hard budget; immutable projection revisions freeze model exposure | `SessionActiveGraphRuntime`, protocol v9 session AG RPC, daemon projection-to-trace registry, Pi tool/board ingestion and cleanup, runtime/service/adapter tests | **Verified core** | Automatic task-frame switching/cooling, branch ownership, one combined semantic/tool/reasoning budget, and the shared disclosure ledger remain open. |
| Progressive disclosure | Resident directory/kernel, compact automatic recall, explicit search headers, exact get, bounded deeper expansion | integration search plus shared Agent Surface, Pi/DSH recall flow | **Verified core** | Daily-use validation remains observational. |
| Retrieval | FTS/exact fallback, optional record embeddings, hybrid ranking, node/leaf hierarchy, query filters and caller-generated multi-query clauses | integration search, embedding providers/sync, bounded leaf-then-node summary drain, hierarchy, primary-first stable-ID query union | **Verified core** | Provider and summary quality are configuration/evaluation concerns; RRF and reverse retrieval remain candidate strategies, while HyDE generation belongs to the caller. |
| QPP and search recommendation | Independently switchable allocation, local folding and recommendation; preserve folded evidence in AG | QPP core, Pi modes, controller shadow | **Opt-in Lab** | Calibrate sufficiency and cost from independent outcomes before Lite promotion. |
| Differentiable controller | Framework-free autodiff substrate; learned heads cannot bypass hard safety/budget gates | `src/lab/autodiff.ts`, controller protocol/runtime/gate, matched telemetry and causal comparison | **Opt-in Lab** | After session AG exists, controller proposals may allocate projection budgets but remain subordinate to hard AG limits; natural quality, cost and rollback gates are required. |
| Hierarchical Activation | Optional multi-scale admission/cooling/reactivation scorer; fast state belongs to session/branch AG while slow parameters remain separately versioned | HA implementation, session-keyed Router runtime and release cleanup, deterministic cosine fallback | **Opt-in Lab** | Task-frame activation, typed activation edges, budget actuation and natural utility evidence are missing. |
| Feedback and posterior | Separate disclosure, diagnostic overlap and verified evidence; prevent self-reinforcing labels | feedback core, claim outcomes, Pi shadow channel | **Verified core** | The natural dataset lacks verified evidence attribution, so learning/calibration stays blocked. |
| Memory maintenance policy | Attribute content, scope and retrieval defects separately; require hash-bound policy identity and long-horizon evaluation; store reviewable proposals without implicit actuation | maintenance proposal table/store, daemon RPC, CLI and deterministic tests | **Calibration gate** | Automatic extraction and SkillOpt optimization wait for natural labels; accepted proposals still require an explicit journalled mutation. |
| Edge activation/stability | Query-local activation differs from durable stability; retrieval alone cannot consolidate an edge | edge activation, Active Graph telemetry, consolidation/demotion | **Calibration gate** | Calibrate independent-task definition, decay and hysteresis on natural reversals. |
| Retention | Indexed L0-L3, dormant/unindexed L4, quarantine L5; protect critical evidence independently of prompt residency | hierarchy and maintenance modules, CLI retention operations | **Verified core** | Automatic physical purge remains **explicitly deferred**. |
| Delete/export/privacy | Logical withdrawal, dependency cleanup and user-memory export | CLI/RPC service and deletion tests | **Verified core** | Raw-history/aggregate physical erasure and receipts are **explicitly deferred** until threat-model/consent work. |
| Session reasoning scratchpad | Private, atomic, bounded, restart-resumable, explicit checkpoint tool; never silently promoted | Daemon Lab authority/workspace plus CLI, Pi, MCP and DSH adapters | **Opt-in Lab** | Automatic capture was rejected; cross-session transfer/promotion waits for demonstrated need. |
| Memory-Graph Reasoner | Optional bounded traversal/what-if engine over an HA-selected session-AG subgraph; output stays hypothetical and separate from durable truth | Daemon Lab RPC requires a session projection, rejects out-of-projection nodes, inherits AG node/edge/step budgets, and labels output non-persistent/hypothetical | **Opt-in Lab** | TTL artifact materialization, typed reasoning edges and the HA rescore loop are not wired. Utility proof remains separate from wiring correctness. |
| Temporary coordination | Task Board is TTL/cursor/attribution based and does not enter LTG/FTS | board store, daemon, CLI/Pi/MCP adapters | **Verified core** | ACLs and multi-device transport are **explicitly deferred**. |
| Daemon and concurrency | One application authority/single LTG writer; synchronous SQLite phases serialize; no transaction spans an await; one frozen declarative RPC catalog drives method discovery and optional capability gates | CLI daemon/service/client, deterministic catalog fingerprint, validated hello discovery, reconnect refresh, registry/handler drift and concurrency tests | **Verified core** | Multi-process distributed writers are out of current scope; trusted runtime registration and hot reload are explicitly deferred. |
| Observability | Trace routing, scores, budgets, disclosures, outcomes, maintenance and rollback without treating diagnostics as truth | trace tables, shadow JSONL, reports/audits | **Verified core** | Natural labels must accumulate through use. |
| Benchmarks | Official-format adapters, matched arms, cacheable embeddings, one OmniMemEval execution entry and fail-closed scoring | config-driven NMG runner delegates all five user-memory suites to their pinned official scripts; official answer/judge prompts and envelopes remain benchmark-owned while model-visible memory uses the shared Agent Surface | **Verified core** | Stable and suite-only options are declared in one config; resume binds its exact result directory and rejects configuration drift; retrieval profiles remain separate from official prompts. Larger/repeated capability runs are evaluation work, not missing design. |
| Agent development and quality | Dynamic repository context, owned documentation, product/research/chaos test tracks, temporary guardrail lifecycle, and composable resource cleanup | root bootstrap, repo-development Skill, context tool, CI workflow, Cordis-backed test wrapper | **Verified core** | Research characterization remains non-blocking and cannot redefine product contracts. |
| Cloud and sandbox | Pluggable future integration only; no default dependency | explicit product boundary | **Out of scope** | Pi sandbox plugins own execution isolation; cloud waits for multi-device scope. |

## Actual active blockers

Four active work families remain; the first is remaining AG implementation work and the
other three prevent evidence-backed default activation of adaptive policies:

1. The session Active Graph runtime core is implemented; automatic task-frame
   lifecycle, branch ownership, shared disclosure accounting and one combined
   runtime budget remain incomplete.
2. Natural Pi tasks rarely contain independently verified claim/evidence outcomes.
3. Retrieval/controller gains have not yet passed matched quality **and** token,
   tool-round, latency, and rollback gates.
4. Unattended STG consolidation and identity merge lack natural false-positive,
   contradiction, and reversal coverage.

The AG item is a deliberate breaking runtime redesign; the remaining items are
validation blockers rather than missing storage mechanisms. Their executable
checklist lives in [temporary-todo.md](temporary-todo.md).

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
