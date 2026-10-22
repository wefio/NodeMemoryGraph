# Core data model

[简体中文](core-data-model.zh-CN.md) · [Terms used](core-data-model.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Core data model

```text
HistoryRecord
  - immutable evidence during normal maintenance
  - stable session/message/tool source identity
  - exact content and timestamp
       | mandatory provenance
       v
Semantic memory store
  |- STG
  |    - provisional/task-local MemoryRecord and MemoryNode
  |    - observed/candidate relations and pending structure
  |    - persistent when crash recovery is required; short-term is a
  |      semantic lifecycle, not necessarily volatile RAM
  |
  `- LTG
       - durable atomic fact | state | event | preference | constraint
       - consolidated strategy | derived concept | typed relation
       - stable semantic addresses and bounded leaf/block hierarchies

STG + LTG + query + session task belief + tool observations
       |
       | select/update under one hard runtime budget
       v
Session Active Graph (mutable, memory-resident, non-authoritative)
  - task frames and selected STG/LTG references
  - temporary tool observations and unresolved working state
  - typed semantic / activation / reasoning edge layers
  - disclosure ledger and total node/edge/evidence/token/depth/latency budget
       |
       | Freeze(VisibleSubset)
       v
ProjectionRevision (immutable exposure and feedback boundary)
```

A `MemoryRecord` is a retrievable semantic statement with provenance and an STG
or LTG lifecycle. A `MemoryNode` is a stable semantic address for a coherent
group of records. Creating one permanent node for every new memory would
reproduce a flat store with extra graph overhead and is not the target model.

`MemoryRecord.eventTime` is the historical time of the event represented by the
statement and may be unknown. `MemoryRecord.createdAt` and
`HistoryRecord.createdAt` record retention/write time; neither substitutes for
missing historical time. `validFrom`/`validUntil` describe validity rather than
occurrence. A raw imported utterance can use its validated message/session time
as `eventTime`: this dates the utterance, not necessarily an event mentioned
inside it. Preserve known historical time independently of display policy and
keep stored statements/evidence unmodified. Read-boundary labels follow
[temporal evidence presentation](progressive-retrieval.md#temporal-evidence-presentation).

An unresolved structure is represented on the record itself, not as a new
memory type. `resolution` is `resolved` by default and may be `open` or
`reopened`; open records carry `openedAt` and one or more
`relatedMemoryIds`. The related IDs are attributable anchors, not inferred graph
edges. Open records remain indexed and are excluded from both LTG heat-based
retention candidates and STG expiry. Explicit `resolve` returns them to normal
retention; explicit `reopen` restores archived records to the searchable index.
Every transition is appended to `memory_resolution_events`, preserving the
reason and anchors without rewriting source history.

Retrieval gives this state bounded reachability. When direct search retrieves an
anchor, at most two related open records are inserted near the end of the normal
first evidence window. They consume the same node, evidence, tier, and token
budgets as every other AG record and do not start a second retrieval cascade.
Pi renders them with `[open]`. The harness therefore guarantees reachability,
but the Agent decides whether the unresolved item matters and must explicitly
call `nmg_remember` with `action=resolve` or `action=reopen` to revise it.

One record can contain several atomic facts. Following the chat.completions
content-parts model, a record stays the single evidence unit (embeddings, FTS,
provenance, and lifecycle all operate at record granularity) while carrying a
`claims` array (`claims_json`) of atomic `MemoryClaim` items — each with its
own text, polarity, predicate key, confidence, and extraction provenance. The
record-level polarity/predicate/confidence columns are a derived rollup cache
(first non-neutral claim), never the source of truth. Contradiction detection
joins claims, not records, so a contradiction inside one long message is as
visible as one across messages. At query time, `contradictionNotes()` renders
each detected pair as a note appended to the retrieved statement, so the
answer-stage reader sees the flag without any harness-side changes.

Scope and time use one deterministic compatibility model throughout ingestion,
relation proposals, and contradiction rendering:

- a scope object is a conjunction of exact `key=value` constraints;
- two scopes overlap when no key constrained by both has different values;
- their intersection is the union of both compatible constraint maps, so a
  broad user-wide record and a project-scoped record conflict only inside the
  project intersection rather than globally;
- validity is the half-open interval `[validFrom, validUntil)`, with a missing
  end treated as unbounded;
- adjacent intervals do not overlap and therefore describe temporal succession,
  not a simultaneous contradiction;
- malformed, empty, or reversed explicit ranges fail at the write boundary.

Query-time contradiction notes require both a compatible scope intersection and
overlapping validity. When the overlap is narrower than either source record,
the rendered note carries the intersected scope. `supersedes` remains the normal
representation for sequential state changes; `contradicts` is reserved for
opposed claims that can be true or false in the same semantic domain.

STG and LTG describe semantic residence, not separate truth systems. Promotion
should preserve the same stable record/node identity and provenance rather than
copying content into a second graph. Demotion or expiry changes normal
visibility but never rewrites the underlying `HistoryRecord`.

AG contains references and query-local annotations, not authoritative copies.
When AG is released, temporary nodes and edges disappear; only explicitly
recorded usage outcomes, stability observations, and accepted writes survive.

Harness-local execution observations follow the same rule. The Pi extension
selectively captures recent tool errors, test outcomes, and edited paths as
temporary, session-local AG observations through `observe()`. The runtime's
per-session item and character bounds limit retained state; this is not a
separate FIFO ring buffer or durable store. When turn metadata is available,
the normal Pi projection includes tool observations only from the current and
immediately preceding model turn. Before compaction, the extension activates
the bounded AG projection for the next turn. These observations are not
`MemoryRecord`s and are never written to SQLite merely because a tool ran; they
disappear when the owning session ends. Only an explicit, semantically judged
`nmg_remember` call may turn an outcome into STG/LTG memory. Pi remains
responsible for conversational compaction; NMG must not copy the doomed raw
message span into durable storage as an automatic "rescue" path.

### Influence permissions

Memory type answers **what a record describes**. Scope answers **where it may
apply**. Influence permission answers **how a recalled record is allowed to
change the Agent's result**. These dimensions are orthogonal: retrieval
relevance alone never grants authority.

The initial permission vocabulary is:

| Permission | Permitted influence | Forbidden influence |
| --- | --- | --- |
| `reasoning_context` | Supply a scoped, confidence-weighted premise or source | Override newer state, stronger evidence, or explicit constraints |
| `presentation_style` | Change language, tone, detail, ordering, or formatting | Change factual conclusions or tool decisions |
| `interaction_hint` | Suggest a non-binding interaction pattern inferred from repeated behaviour | Become a hard requirement from one observation |
| `task_continuation` | Restore goals, progress, decisions, and open work within the matching task/workspace | Generalize temporary state into a user-wide preference |
| `scoped_constraint` | Restrict an action inside its explicit scope while active | Apply outside that scope or survive a superseding constraint |
| `experience_advisory` | Offer evidence-backed experience for the Agent/user to interpret and adapt | Silently become an executable procedure, system prompt, Skill, or mandatory plan |

Default mappings may be inferred from memory type, but the effective permission
must also respect source, scope, truth status, residence, recency, and
supersession. For example, an explicit expression preference normally receives
`presentation_style`; a repeated behavioural observation receives the weaker
`interaction_hint`; a project constraint receives `scoped_constraint`; and a
strategy candidate receives `experience_advisory`.

Permission is enforced at rendering and use, not merely documented in prose.
Until a structured field is implemented, adapters must render an explicit use
instruction with every selected record. A future schema migration may persist
the permission when tests show that type-derived defaults are insufficient.

The promotion threshold grows with both scope breadth and influence strength:

```text
session/task < project/workspace < user < team/organization
interaction hint < reasoning context < scoped constraint
```

Wider or more behaviour-changing memories require more independent evidence,
stronger provenance, and an explicit correction/rollback path.

### Transferable experience

NMG may consolidate repeated, outcome-linked episodes into **transferable
experience**, but it does not decide the final behavioural artifact. An
experience is descriptive evidence about what happened under which conditions,
not an instruction that must be executed.

The logical experience projection contains:

```text
summary
situation / preconditions
action or approach observed
outcome
possible explanation
applicability and scope
known limitations
counterexamples and failed variants
confidence and independent-task count
source memory, outcome, and HistoryRecord references
```

Formation requires multiple compatible episodes or an explicitly confirmed
experience, attributable outcomes, preserved counterexamples, and a stable
scope. A single successful action remains an event or provisional STG strategy.
Repeated failure lowers confidence or narrows applicability; it does not erase
the original episodes.

NMG exposes the experience information through normal retrieval or a neutral
structured export. It does **not** create or modify a `SKILL.md`, system prompt,
runbook, script, policy, or model weights. The current Agent and user may choose
to turn the same experience into any of those artifacts—or not use it at all.
Keeping the stable layer limited to semantics, conditions, outcomes, and
evidence allows experience to survive changes in Agent harnesses and artifact
formats.

Existing `strategy` memories are therefore interpreted as provisional or
consolidated experience candidates with `experience_advisory` permission, not
as executable procedures. The model may adapt them to the current task, but
must inspect applicability and contrary evidence before acting.

### Confidence as a posterior: the outcome feedback loop

Claim `confidence` today is a prior — the extractor's self-assessment at write
time. A memory system earns the word "experience" only when that number is
corrected by an outcome that can be attributed to a claim. Retrieval and
rendering alone do not supply that attribution. The external harness can capture
user confirmation, tool validation, and benchmark evidence after inference;
model upgrades improve the prior but cannot replace this auditable loop.

Mechanism (minimal, deterministic):

1. **Observation logging.** Retrieval, disclosure, and heuristic answer overlap
   are separate events. They support latency, coverage, and interaction analysis
   but do not create usefulness votes.
2. **Verified outcome attribution.** A claim receives a vote only when the
   caller identifies both the claim and an auditable outcome source: explicit
   user confirmation/correction, a validating tool result, or official
   benchmark evidence. Broad task success is not sprayed across every rendered
   claim. Outcomes are provenance-bearing events, never silent in-place edits.
3. **Posterior update.** Claim confidence becomes
   `posterior = f(extraction prior, accumulated outcome votes)` — a Beta-style
   running update keeps the storage to two counters per claim and stays
   auditable. The raw prior is preserved so re-weighting rules can change
   without re-extraction.
4. **Retrieval weighting.** Rank fusion consumes the posterior, not the
   prior: repeatedly useful memories surface more easily; memories that
   correlate with failures sink toward archival review rather than being
   deleted (history stays immutable).
5. **Credit discipline.** Correlation is not causation. API-model answer overlap,
   counterfactual response differences, tool-call presence, and uncorrected
   completion remain diagnostics because model/provider drift makes them poor
   portable labels. Verified votes from the same task are deduplicated, and a
   posterior is trusted only after enough independent observations.

This loop also addresses, at claim granularity, part of the open routing
question in [Remaining design questions](open-design-questions.md): the
usefulness signal lives on the claim, not on the router's selection, so
reinforcing a good memory does not require reinforcing the path that found it.

### Optional interaction profile, not a hidden user model

NMG does not currently maintain a learned user model. A future adapter may keep
a small, explicit **interaction profile** when repeated cross-task behaviour
shows a stable preference for recall depth or interaction style—for example,
the user repeatedly requests more results, stops after shallow evidence, or
corrects overly aggressive recall. Such black-box behavioural measurement is
about the user's observable choices, not an API model's hidden cognition.

The profile may tune user-scoped defaults such as evidence budget, automatic
recall aggressiveness, or whether to recommend another search. It must use
decay, a minimum number of independent tasks, inspectable features, and reset/
export controls. A single interaction remains telemetry. The profile may never
change fact truth, claim confidence, graph stability, node merging, or global
controller weights; those continue to require verified evidence. Until this
need is demonstrated, the event log is sufficient and no new subsystem is
implemented.
