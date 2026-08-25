# STG Isolated Store（STG 独立库）

**Status:** project-local shared store with session-row isolation implemented
**Updated:** 2026-08-13
**Related:** [memory-graphs.md](memory-graphs.md) §1/§3/§5, [external-source-design.md](external-source-design.md), docs/design/design.md §1

## 1. Problem

Legacy calls without `projectDir` may still use the shared residence flag, but
project-aware daemon, CLI, and Pi calls now route to separate stores. The former
runtime made STG and LTG share one SQLite database and one table
(`memory_records.residence` is a flag; `expireShortTermMemories` batch-marks
`stg` rows inactive). This contradicts the three-graph model in
memory-graphs.md §1 — STG is a *semantic lifecycle* (provisional,
task/project-local), not merely a residence flag:

- Project isolation: one project's provisional memories pollute another's
  search window; there is no natural "project folder = STG boundary".
- Deletability: there is no way to drop a project's provisional state without
  touching the shared authoritative store.
- Search locality: STG and LTG are co-scanned in one FTS pass; the hot
  project-local memories cannot be searched independently or first.

## 2. The three-storage model

```
LTG (authoritative, shared, durable)          SQLite, shared location
      │  usage-driven copy (cached subset)
      ▼
STG (project-local, session-isolated, cache+new) SQLite, project folder
      │  query projection
      ▼
AG (per-query memory)                         RAM, released with query
```

| Property | LTG | STG | AG |
| --- | --- | --- | --- |
| Location | shared store | **project store** (`<project>/.nmg/stg.sqlite`), with `session_id` row isolation | RAM |
| Authority | sole authoritative | local provisional + **cached LTG subset** | derived |
| Lifecycle | durable | session lifecycle enforced per row; project-store cleanup removes all project STG | per query |
| Write path | governed, durable | local fast writes | — |
| Backed up? | yes (the only one that matters) | no (recreatable) | no |

The original prototype used one physical database per session. The current v2
layout deliberately shares one STG database per project so indexes and cached
LTG subsets are not duplicated. Privacy remains session-level: every direct,
exact, attachment, and graph-expansion read applies the caller's `session_id`;
shared rows are visible only when explicitly written without a session owner.
Physical co-location is not semantic sharing.

## 3. Cached LTG subset: cache, not replica

A cached LTG memory in STG is a **search hint**, not an authority.

- Carries a marker:
  ```json
  { "kind": "cached_from_ltg",
    "attributes": { "sourceMemoryId": "<ltg id>", "cachedAt": "2026-07-31" } }
  ```
- **Never re-verified** — this reuses the external-source decision (marking
  not re-verification). The marker says "cached copy of LTG, may be stale";
  the agent can `nmg_get <sourceMemoryId>` for the authoritative content.
- **Never promoted back**: a `cached_from_ltg` memory must not enter the
  promotion pipeline (it already *is* LTG — promoting it would be a copy
  cycle). Promotion eligibility requires the absence of the marker.
- Repeated cache fills skip an already cached `sourceMemoryId`. Refresh and
  invalidation policy remains a later integration concern; the prototype does
  not create a second cached identity merely to update `cachedAt`.
- Expiry is usage-driven (symmetrical to copy): a cache entry not used by
  the project for N queries is evicted, independent of provisional-STG
  expiry.

## 4. What populates STG

Two kinds of content, distinguished by marker:

1. **Provisional STG** (no marker): new task-local facts/preferences written
   to the project store. Promotable (governed path, existing criteria).
2. **Cached LTG subset** (`cached_from_ltg`): copied from LTG by a
   **usage-driven** routine — not by blindly copying global L1/L2. The AG
   usage trace (retrieval_traces) aggregates which LTG memories a project
   actually *used*; the routine copies those (per project) into its STG.
   This mirrors CLS replay (memory-graphs.md §5: re-activated traces drive
   integration) and keeps each project's cache small and relevant: a
   globally-hot but project-cold memory is not copied; a globally-cold but
   project-used memory is.

## 5. Search: STG first, LTG fallback

```
query
  → search STG (local FTS; fast, project-scoped)
  → sufficient? (QPP/coverage)  ── yes → done
  └─ no → search LTG (shared store)
       → merge, dedupe (by sourceMemoryId for cached copies)
       → reconcile same-scope stateKey versions by event/valid/creation time
```

- STG-first gives project-local hot memories priority and avoids touching
  the shared store for the common case.
- The insufficiency signal reuses the tiered-disclosure SPRT design
  (tiered-disclosure-design.md §2.2).
- Budgets allocate across the two stores (maxEvidence split STG-first).
- A current-state projection exposes only the newest `stateKey + canonical
  scope` value across STG and LTG. LTG wins an exact timestamp tie as the
  authoritative store. Historical time filters run before reconciliation, so
  an older value remains available for an as-of query.
- Scope pushdown and filterUsage apply per store — the same pipeline runs
  twice, once per database.

## 6. What must not break

| Invariant | Guard |
| --- | --- |
| cached copies never promote | marker presence excludes from promotion pipeline |
| deleting STG store never touches LTG | separate file; LTG path never writes STG |
| provisional STG still expires | project-local expiry, independent of cache |
| LTG remains sole authority | `nmg_get` resolves through LTG for `sourceMemoryId` |
| dual-store dedupe | cached copies dedupe by `sourceMemoryId` on merge |
| cross-store state update | newest same-scope `stateKey` wins; historical filter preserves old value |

## 7. Phased rollout

| Phase | Scope | Evidence gate |
| --- | --- | --- |
| 1 | **Implemented:** separate project-local SQLite store | daemon/CLI/Pi isolation tests pass |
| 2 | **Implemented, opt-in:** `cached_from_ltg` marker + usage-ranked explicit or search-triggered sync | copy/idempotency and bounded cooldown tests pass; natural cost/benefit remains uncalibrated |
| 3 | **Implemented:** STG-first dual-store search with QPP fallback + authoritative dedupe | service and adapter tests pass; benchmark gate pending |

The daemon keys stores by `projectDir + sessionId` and opens them lazily. Pi
supplies both its current working directory and native session ID on remember,
search, automatic recall, and get. CLI exposes `--project-dir` plus optional
`--session-id`; when omitted it uses the isolated administrative session
`cli`, preserving the fallback workflow without joining a Pi session.

## 8. Non-goals

- No re-verification of cached LTG content (marker suffices; agent decides).
- No background sync daemon — copy runs as a maintenance action (same
  discipline as retention/prune) or as an opt-in, scope-bound read-through cache.
- LTG schema unchanged.
- No new memory types (cache is a marker, not a type).
