# Status Audit — 2026-08-24

[English](status-audit-2026-08-24.md) | [简体中文](status-audit-2026-08-24.zh-CN.md) · [Terms](status-audit-2026-08-24.terms.yaml)

**Authority:** [Parent scope](../improvement-areas.md).

## Status audit — 2026-08-24

The detailed notes below preserve a **historical status snapshot as of 2026-08-24**. They are not a live status register; follow the parent scope and current source owners for present behavior.

| # | Area | Status recorded on 2026-08-24 |
| --- | --- | --- |
| 1 | Store decomposition | **Resolved for the current architecture.** `store.ts` is an eight-line mixin façade; base, graph, retrieval, writes, maintenance, schema, ranking, Active Graph, row parsing, and vector concerns are separate modules with boundary tests. Revisit only when a measured module boundary becomes a maintenance problem. |
| 2 | Vector-cache invalidation | **Resolved for the stated mechanism.** `Float32VectorCache.remove(id)` and targeted invalidation tests exist. Revisit only if measured rebuild latency regresses. |
| 3 | Router expressiveness | **Mechanism and causal engineering comparison complete; promotion rejected.** The custom autodiff controller learns node, memory, edge, control, and budget heads. A frozen candidate actuates bounded node reranking, allocation, and folding in matched Pi runs, with typed action telemetry and fail-closed official scoring. A fixed 14-question, seven-category development comparison improved answers and official evidence recall, but increased tokens and latency enough to fail the product gate; the separate LoCoMo retrieval gate also failed. Natural matched evidence and acceptable product costs remain required before promotion. |
| 4 | Privacy deletion | **Product surface partial.** Logical withdrawal and versioned user-memory export exist in CLI/RPC/Pi, with FTS/embedding/evidence/leaf/claim/proposal/AG cleanup and unsupported-derived-memory cascade. Physical history erasure, non-subtractable learned aggregate reset, adapter hooks, and erasure receipts remain open. |
| 5 | Regex-only recall gate | **Open.** English/Chinese deterministic coverage is tested; multilingual semantic gating and measured false-positive/false-negative rates are not. |
| 6 | Test coverage | **Substantially improved.** The listed Chinese, graph, split, cache, deletion, QPP mode/recommendation/folding, and controller-actuation paths have deterministic coverage. Real Pi schema drift and natural topology adaptation remain important gaps. |
| 7 | ANN recall | **Deferred by evidence.** Exact local scan remains the default; the current ANN path must not be promoted without a recall/latency crossover. |
| 8 | Concurrency model | **Resolved for the current daemon architecture.** One resident daemon is the application-level authority; synchronous SQLite phases are serialized while external calls may overlap without holding transactions. |
| 9 | Session serialization | **Partial.** Capture is automatic and idempotent; Pi projection has a fail-closed `pi.branch.v1` shape contract and tests, but it is still hand-validated from `unknown` rather than negotiated with an upstream schema. |
| 10 | Topology acceptance | **Intentionally Lab/manual.** Proposal creation and explicit review work; unattended mutation lacks a precision gate. |

---
