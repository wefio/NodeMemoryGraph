# External Source Design（外部来源设计）

**Status:** design proposal
**Updated:** 2026-07-31
**Related:** [memory-graphs.md](memory-graphs.md), [edge-activation-design.md](edge-activation-design.md), [tiered-disclosure-design.md](tiered-disclosure-design.md), design.md §5a/§9

## 1. Principle

**External content is perception, not memory.** Search results and file
contents are the world's state, not the user's history. NMG stores memory
*about* the user and their experience; external content enters memory only as
**marked, unverified evidence** — never as first-class memory content, and
never through a background re-verification pipeline.

Maintenance of external facts is delegated to the agent **at inference
time**: the marker tells the agent "this came from outside and is not
verified; re-check if it matters", and the agent decides. No scheduled
re-fetch, no freshness crawler.

## 2. Why marking, not re-verification

| | Marked + agent re-checks (chosen) | Background re-verification (rejected) |
| --- | --- | --- |
| Cost | validation only when memory is used | perpetual re-fetch of mostly-unused memory |
| Context | agent knows how critical this fact is to the current task | timer knows nothing about task context |
| Auditability | marker is a deterministic fact written at write time | freshness state depends on scheduler |
| Boundary | no background channel, no new maintenance component | new always-on subsystem, violates Lite |
| Failure mode | agent may use stale fact (visible via marker) | agent may use stale fact (invisible — false freshness) |

The last row is the decisive one: a background re-verifier that fails to run
**lies** (the memory looks fresh when it is not), while a marker can never
lie — it says "external, unverified" regardless of what the agent does. NMG
rejects invisible freshness.

This also matches the memory-reconsolidation view: a memory is re-validated
when it is retrieved and used, not on a schedule. Unused memories do not need
to be fresh.

## 3. The marker

External provenance reuses the existing open `MemoryMarker` mechanism
(src/core/types.ts:104) — the same mechanism as `[forget]` in the PersonaMem
work. No new schema, no new memory type.

```json
{ "kind": "external_source",
  "attributes": { "source": "web:https://example.com/page",
                  "retrievedAt": "2026-07-31",
                  "hash": "a3f2c9..." } }
```

| Attribute | File (`file:`) | Web (`web:`) | Notes |
| --- | --- | --- | --- |
| `source` | `file:src/core/store.ts` | `web:https://example.com` | path / URL; the `file:`/`web:` prefix separates domains |
| `retrievedAt` | import / read time | search time | ISO date; lets the agent judge staleness |
| `hash` | content hash (optional) | page hash (optional) | agent compares on re-check; local files make this a one-line diff |

`normalizeMarkers` (store.ts:4311) already deduplicates and validates
attributes; `external_source` needs no core change beyond being documented as
a recognized kind.

## 4. Three orthogonal dimensions

| Dimension | Mechanism | Content |
| --- | --- | --- |
| Provenance | marker `external_source` | which file/URL + when; static, written at write time |
| Trust | `truthStatus: "unverified"` | external facts default to unverified; user confirmation upgrades to verified |
| Rendering | adapter renders `[external]` at model boundary | the agent sees the flag and may re-check |

`truthStatus` and the marker are independent: a *user-confirmed* fact that
came from a URL still carries `external_source` provenance (the marker never
drops), while its trust level rises. Rendering is adapter-side, like the
existing `[forget]` marker — core stores the marker, adapters decide how to
surface it (design.md §5a's "enforced at rendering and use, not merely
documented").

Suggested rendering (adapter):

```text
[external, unverified] <statement>
  source: https://example.com/page (retrieved 2026-07-31)
```

## 5. Where external content enters

### 5.1 Web search results

Search results are tool output — `sourceActor: "tool"`, the existing type.
The governed write policy already covers them (README: conversational evidence
is unverified unless the user or a tool confirms it). No automatic write of
search results; a fact the user confirms is written with:

```
sourceActor: "tool"        existing
sourceRef:   URL           existing field (may become structured later)
truthStatus: "unverified"  until user confirmation
eventTime:   search date   existing
evidence:    result excerpt
markers:     [external_source web:...]
```

### 5.2 File content

The same rule: file contents are not memory; *statements about* files are.
Reading a file is a tool output. Confirmed facts from a file carry
`external_source file:path` and optional `hash` so the agent can detect
changes on re-check (local diff, cheaper than web).

### 5.3 What never enters

- Raw search results / file contents as memory (no full-text indexing of
  external content — NMG is a memory layer, not a code indexer or crawler).
- Web-scoped memories in tier 0 without a marker (external facts decay
  faster and are always marked).
- A background freshness pipeline (section 2).

## 6. Interaction with existing mechanisms

| Mechanism | Interaction |
| --- | --- |
| Retention candidates (store.ts:296) | `external_source` is **not** in the protected kinds (`critical`, `pinned`, `protected`, `safety_constraint`, `user_defined`); external memories are normally retainable. If a kind needs protection later, the existing allowlist already works |
| `sourceRef` (HistoryRecord) | stays as-is; marker is the structured extension. A future pass may upgrade `sourceRef` to structured refs, but the marker works today |
| Confidence posterior (design.md §5c) | external facts start from a lower prior; outcome votes update them normally — a web fact that repeatedly helps in verified tasks can earn confidence, without losing its `external_source` provenance |
| File/Web as node kinds | a `kind: "file"` node is possible later (file = stable alias, merge-friendly, per the project-folder intuition); the marker works without it |
| Tiered disclosure | external memories follow normal tiers; the marker is orthogonal to tier |

## 7. Explicit non-goals

- No re-verification scheduler, freshness crawler, or stale-detection pass.
- No automatic fetching of external content on retrieval (the agent may
  choose to re-check; NMG never fetches on its own).
- No indexing of external document content into the semantic store.
- No new memory types (`web_fact`, `file_fact`, ...) — the memory type stays
  semantic (`fact`, `state`, ...); `external_source` is provenance.
