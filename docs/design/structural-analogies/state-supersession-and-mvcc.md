# State supersession = MVCC / temporal databases

[简体中文](state-supersession-and-mvcc.zh-CN.md) · [Terms used](state-supersession-and-mvcc.terms.yaml)

**Authority:** [Parent scope](../structural-analogies.md).

## State supersession = MVCC / temporal databases

**Current implementation:** `src/core/store/writes.ts` — `automaticPrevious` logic in `remember`.

**Structure:**

```
NMG                              MVCC (PostgreSQL / etc.)
────────────────────────────────────────────────────────────
stateKey + scope identify a state   (id, version) identify a row
new state → old.status =              UPDATE → old version marked expired
  'superseded'
supersedes_id → points to prior version  xmin / xmax → visibility interval
validFrom / validUntil → time window     transaction-ID range → visibility check
query selects active only                 query selects rows visible in current snapshot
```

**Similarities:**
- Old values are not deleted; they are marked invisible.
- There is an explicit link between old and new (supersedesId / version chain).
- The time dimension is modeled (`validFrom`/`validUntil`).

**Differences:**
- MVCC visibility is determined by transaction IDs (concurrency control); NMG uses `status = 'active'`.
- MVCC has vacuum (cleanup of dead tuples); NMG has no equivalent mechanism.
- NMG's `supersedesId` chain is singly linked; MVCC also has a version chain.

**Similarity to Event Sourcing:**
- `HistoryRecord` (immutable event stream) → `MemoryRecord` (projection/state).
- A new event → a new projection supersedes the old projection, while the event itself is retained.
- This is the standard CQRS/Event Sourcing pattern.

**Design implication:** A bitemporal model could introduce `valid_time` and `transaction_time` to distinguish “when the fact happened” from “when the system recorded it.” Currently there is only `validFrom`/`validUntil`.
