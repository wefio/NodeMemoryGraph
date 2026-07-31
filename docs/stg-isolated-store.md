# STG Isolated Store（STG 独立库）

**Status:** design proposal
**Updated:** 2026-07-31
**Related:** [memory-graphs.md](memory-graphs.md) §1/§3/§5, [external-source-design.md](external-source-design.md), docs/design.md §1

## 1. Problem

Today STG and LTG share one SQLite database and one table
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
STG (project-local, deletable, cache+new)     SQLite, project folder
      │  query projection
      ▼
AG (per-query memory)                         RAM, released with query
```

| Property | LTG | STG | AG |
| --- | --- | --- | --- |
| Location | shared store | **project folder** (`<project>/.nmg/stg.sqlite`) | RAM |
| Authority | sole authoritative | local provisional + **cached LTG subset** | derived |
| Lifecycle | durable | project lifecycle; **deleting the folder drops it** | per query |
| Write path | governed, durable | local fast writes | — |
| Backed up? | yes (the only one that matters) | no (recreatable) | no |

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
```

- STG-first gives project-local hot memories priority and avoids touching
  the shared store for the common case.
- The insufficiency signal reuses the tiered-disclosure SPRT design
  (tiered-disclosure-design.md §2.2).
- Budgets allocate across the two stores (maxEvidence split STG-first).
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

## 7. Phased rollout

| Phase | Scope | Evidence gate |
| --- | --- | --- |
| 1 | STG as separate project-local SQLite file (write path separated; search still reads both via merged view) | existing test suite + STG-orphan tests |
| 2 | `cached_from_ltg` marker + usage-driven copy routine | copied set matches usage trace; promotion pipeline rejects cached |
| 3 | STG-first dual-store search with fallback + dedupe | eval:scale latency no regression; LongMemEval recall no regression |

Each phase is independently shippable; phase 1 alone delivers project
isolation and deletability.

## 8. Non-goals

- No re-verification of cached LTG content (marker suffices; agent decides).
- No background sync daemon — copy runs as a maintenance action (same
  discipline as retention/prune).
- LTG schema unchanged.
- No new memory types (cache is a marker, not a type).
