# NMG design baseline

[中文](design.zh-CN.md) · [Terms used](design.terms.yaml)

**Status:** current — 0.11: core persistence stable; session Active Graph runtime core implemented
**Updated:** 2026-10-16

## Definition

Node Memory Graph (NMG) is a local-first long-term memory component for
long-running agents. It preserves immutable historical evidence, derives mutable
semantic memory from that evidence, and progressively discloses only the context
needed by the current task.

NMG separates physical memory residence from runtime exposure:

- the **Short-Term Graph (STG)** is private to one Agent session and holds new,
  provisional, task-local, or not-yet-consolidated semantic information;
- the **Long-Term Graph (LTG)** is the only shared graph and holds durable atomic
  memories and consolidated semantic structure;
- the **Active Graph (AG)** is a private, session-owned, mutable and strictly
  memory-resident runtime graph. It maintains the bounded working set selected
  from that session's STG and the shared LTG together with temporary tool state,
  task frames, activation metadata, and reasoning artifacts;
- a **ProjectionRevision** is an immutable, budgeted model-visible snapshot
  frozen from AG for one retrieval/disclosure/feedback boundary.

AG is not a third authoritative or shared memory graph. Its only mandatory
physical property is that the graph itself remains in memory and disappears
with its owning session; durable truth and provenance remain in STG/LTG. Agents
never write a shared AG or STG: durable collaboration occurs through admitted
LTG memories; temporary coordination occurs through the separate Task Board
and is projected into each caller's private AG. The rationale and migration
contract are recorded in the implemented
[session Active Graph decision](../decisions/implemented/2026-08-29-session-active-graph-runtime.md).

> **Standalone reference:** the STG/LTG/AG model, its theoretical lineage
> (Atkinson–Shiffrin 1968, Complementary Learning Systems 1995, ACT-R/SOAR,
> MemGPT/Letta), provisional-memory rules, promotion/demotion thresholds, and
> implementation state are consolidated in
> [memory-graphs.md](memory-graphs.md). design.md keeps the normative model;
> details moved to the standalone document.

The primary integration target is the Pi agent harness. Pi owns the model loop,
session lifecycle, tools, and UI. NMG owns durable memory, provenance, retrieval,
and memory-maintenance policy. NMG is not an agent harness, a sandbox, or a cloud
platform.

Repository development orchestration is also outside the NMG daemon. The
run-to-completion Repository Control Plane lives in this repository and may use
NMG through an optional client adapter, but the dependency direction is strictly
`Repository Control Plane -> NMG client -> NMG daemon`. Git contracts, repository
observations, verification receipts, pull-request state, and merge readiness
remain control-plane or forge concerns; they do not become STG/LTG truth and the
NMG daemon never schedules or reconciles repository work. An explicit RCP client
may project a validated receipt into a named session/task frame as bounded
`tool_observation` feedback through the existing AG RPC. This does not infer
quest completion, admit a training reward, or transfer verification authority to
NMG; full evidence remains in the receipt. The implemented core
and deferred boundary are specified in
[ci-cd-and-quality.md](ci-cd-and-quality/repository-control-plane.md#repository-control-plane-1) and the
implemented [Repository Control Plane decision](../decisions/implemented/2026-08-29-repository-control-plane.md).

NMG has two intentionally different surfaces:

- **NMG Lite** is the default product surface: a zero-configuration Pi plugin
  backed by SQLite, a small model-facing API, and the framework-free
  differentiable computation substrate used by optional controllers.
- **NMG Lab** contains non-default capabilities such as graph routing, adaptive
  tiers, ANN, learned routing, and topology refinement. Lab is an opt-in product
  channel, not a permanent quarantine: a capability can be used while it remains
  in Lab when an Agent profile, harness, operator, or user explicitly enables its
  feature gate. It becomes part of the Lite default only after an ablation shows
  sufficient benefit over a simpler baseline at acceptable quality, latency,
  token, and maintenance cost.

The repository may contain both surfaces, but experimental complexity must not
become an installation or prompt dependency for the default plugin. Disabled Lab
capabilities must stay out of the model's active tool schema and ordinary prompt;
opting in accepts the capability's documented cost and maturity limits without
claiming that it has passed the Lite promotion gate.

Lab capability lifecycle therefore has two independent transitions:

```text
implemented Lab capability
  |-- explicit per-capability opt-in --> enabled Lab capability
  `-- evidence-backed promotion -----> Lite default capability
```

The first transition is an explicit bounded lease, not proof of usefulness. The
second is a product-default decision and must remain reversible. The daemon's
capability directory states which features an Agent may lease for its own session.
Low-risk scratch, read-only reasoning, and shadow observation are self-service;
cost-bearing or mutating controller modes still require delegated harness/operator
authority and cannot be unlocked by a model request. `nmg_lab` is therefore one
small always-available discovery/control entry, while the capability-specific
schemas and state stay unloaded until enabled. Pi's optional `nmg_reason` remains
only a typed convenience wrapper over this shared boundary.

The autodiff substrate belongs to Lite because product features may depend on
its numerical graph and it adds no Python, PyTorch, GPU, or model-service
dependency. This does **not** promote every consumer of that substrate:
learned routing, hierarchical activation, fork/merge experiments, and the
Memory-Graph Reasoner each retain an independent feature gate and evidence
requirement.

## First principles

NMG follows these principles:

1. **History is the durable source; semantic memory is a rebuildable
   interpretation.** Normal maintenance never rewrites historical evidence.
2. **A memory system improves access to relevant prior state, not the base
   model's reasoning ceiling.** It may improve continuity, personalization,
   constraint compliance, and experience reuse, while bad memory can make the
   agent worse.
3. **Storage can grow without prompt growth.** Most turns should see no dynamic
   memory or only a compact directory.
4. **Progressive disclosure precedes aggressive prefetch.** The agent first sees
   what memory exists, then fetches exact evidence when useful.
5. **Missing a speculative relation is safer than persisting a false one.** Raw
   and provisional memories remain globally searchable while semantic structure
   develops.
6. **The simplest measured implementation wins.** A graph, ANN, adaptive tree,
   or learned router is optional until it improves quality or cost against a
   simpler control.
7. **Residence, activation, and consolidation are different decisions.** STG or
   LTG determines persistence; AG determines current visibility; activation
   describes current use; stability determines whether provisional structure
   should be consolidated.
8. **Facts may persist before structure stabilizes.** A confirmed fact,
   preference, constraint, or replaceable state can enter LTG directly with
   provenance. Inferred relations, derived concepts, and reusable strategies
   require stronger cross-task evidence before becoming LTG structure.

## Responsibility boundaries

| Component | Responsibilities |
| --- | --- |
| Base model | Identify candidate facts/preferences/constraints, summarize, reformulate queries, decide whether more evidence is needed, propose semantic relations or splits, and synthesize an answer. |
| Agent harness | Run the model/tool loop, expose session lifecycle events, preserve current-turn execution state, and provide context/tool integration points. |
| Harness adapter | Translate native messages and lifecycle events into NMG integration contracts, register tools, and inject returned context. It contains no retrieval or storage policy. |
| NMG integration | Apply shared configuration, retain admitted source evidence, run hybrid retrieval, and expose an Agent-independent application boundary. |
| NMG core | Maintain stable IDs, provenance, STG/LTG lifecycle, time/scope/state invariants, Active Graph budgets, semantic organization, consolidation signals, and rebuildable indexes. |
| SQLite/index backend | Provide transactions, WAL/crash recovery, FTS, versioned records, dirty queues, content hashes, and physical index/cache persistence. |
| Optional learner | Learn query-to-node/leaf scores, edge usefulness, expansion depth, or stopping policy from labelled retrieval outcomes. It does not own persistent topology. |

Stronger models can improve extraction, summarization, query planning, conflict
interpretation, and topology proposals. They cannot naturally provide
cross-session persistence, transactions, stable provenance, deletion propagation,
index maintenance, or deterministic budget enforcement. Those remain system
responsibilities.

## Product boundary: NMG Lite

Read the complete responsibility: [Product boundary: NMG Lite](design/product-boundary.md).

## Core data model

Read the complete responsibility: [Core data model](design/core-data-model.md).

## STG/LTG connectivity and provisional memory

Read the complete responsibility: [STG/LTG connectivity and provisional memory](design/stg-ltg-connectivity-and-provisional-memory.md).

## Active Graph, activation, stability, and consolidation

Read the complete responsibility: [Active Graph, activation, stability, and consolidation](design/active-graph-activation-and-consolidation.md).

## Information and communication interpretation

Read the complete responsibility: [Information and communication interpretation](design/information-and-communication-interpretation.md).

## Session capture and write path

Read the complete responsibility: [Session capture and write path](design/session-capture-and-write-path.md).

## Incremental storage and index maintenance

Read the complete responsibility: [Incremental storage and index maintenance](design/incremental-storage-and-index-maintenance.md).

## Progressive retrieval

Read the complete responsibility: [Progressive retrieval](design/progressive-retrieval.md).

## Learnable routing and minimal differentiable query graphs

Read the complete responsibility: [Learnable routing and minimal differentiable query graphs](design/learnable-routing-and-differentiable-query-graphs.md).

## Memory-Graph Reasoner — retained numerical Lab prototype

Read the complete responsibility: [Memory-Graph Reasoner — retained numerical Lab prototype](design/memory-graph-reasoner.md).

## Session reasoning workspace and compaction checkpoint

Read the complete responsibility: [Session reasoning workspace and compaction checkpoint](design/session-reasoning-workspace-and-compaction-checkpoint.md).

## Current implementation versus target

Read the complete responsibility: [Current implementation versus target](design/implementation-versus-target.md).

## Evaluation and falsifiable claims

Read the complete responsibility: [Evaluation and falsifiable claims](design/evaluation-and-falsifiable-claims.md).

## Cloud and execution boundaries

Cloud sync is optional and never authoritative. A future backend may exchange
immutable operations and content-addressed encrypted objects rather than copying
a live SQLite file. Cloudflare coordination is not part of NMG Lite.

NMG stores and retrieves memory; it does not execute remembered commands or
provide an `ExecutionBackend`. Pi can obtain execution isolation through its
own sandbox plugins, independently of NMG. NMG may preserve a sandboxed tool
result as provenance-bearing evidence, but sandbox selection, permissions,
lifecycle, and policy remain responsibilities of Pi and the selected plugin.

## Revised implementation order

Read the complete responsibility: [Revised implementation order](design/implementation-order.md).

## Remaining design questions

Read the complete responsibility: [Remaining design questions](design/open-design-questions.md).

## Concise technical definition

> NMG is an adaptive semantic coding system for agent memory. It encodes
> immutable historical evidence into mutable, variably granular semantic nodes
> and relations across a short-term graph and a long-term graph; maintains a
> session-owned, mutable, memory-resident Active Graph as the bounded working
> space; freezes immutable projection revisions as model-visible evidence;
> optionally uses HA to manage activation and MGR to perform temporary reasoning;
> consolidates stable evidence-backed structure while allowing governed atomic
> memories to persist immediately; and preserves exact history as a lossless
> fallback against semantic retrieval error.

## Companion engineering notes

This document defines the architectural contract. The supporting notes explore
implementation choices without making all of them core requirements:

- [`math-physics-foundations.md`](./math-physics-foundations.md) distinguishes
  implemented mathematics from useful analogy and proposes measurable models.
- [`structural-analogies.md`](./structural-analogies.md) relates NMG to LSM,
  event sourcing, content addressing, association learning, and graph methods.
- [`function-signatures-from-structures.md`](./function-signatures-from-structures.md)
  derives possible API boundaries from those structural analogies.
- [`sqlite-assessment.md`](./sqlite-assessment.md) records why SQLite remains the
  correct authoritative store for the current scale and plugin boundary.
- [`improvement-areas.md`](./improvement-areas.md) tracks unresolved engineering
  risks and should not be read as implemented design.
- [`ci-cd-and-quality.md`](./ci-cd-and-quality.md) describes the current local
  quality checks and CI automation.
