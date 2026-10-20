# Session capture and write path

[简体中文](session-capture-and-write-path.zh-CN.md) · [Terms used](session-capture-and-write-path.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Session capture and write path

Completed Pi turns are not copied automatically. Pi remains the owner of its
complete session history. During an accepted `nmg_remember`, the adapter may
resolve the LLM-selected evidence against the active Pi branch and retain only
that exact excerpt with stable `(session_id, source_message_id)` provenance.
NMG therefore stores governed evidence rather than a cumulative transcript
snapshot. A future `HistoryProvider` boundary may resolve other harness
references or provide managed copies for harnesses without durable history.

Session storage and semantic extraction are separate:

```text
Pi message/turn
  -> turn-local pending evidence
  -> governed extraction/admission
  -> zero or more retained HistoryRecord excerpts
  -> zero or more governed MemoryRecord writes into STG
  -> optional immediate atomic promotion into LTG
  -> later evidence-backed structural consolidation
```

NMG uses selective historical admission rather than duplicating every Pi
message. A message body becomes durable NMG history when it supports an accepted
memory, records an explicit user retention request, preserves a decision or
unresolved obligation, captures a conflict/exception, or contains an
irreproducible result. Otherwise Pi remains the temporary transcript owner and
NMG keeps no second body copy.

Admission has three current outcomes:

```text
reference  source/message identity only; body remains in the harness
excerpt    exact bounded source excerpt plus provenance
discard    no NMG history row
```

The same stable Pi write tool also exposes explicit logical withdrawal:
`nmg_remember action=forget` requires an exact memory ID and is intended only
for an explicit user request. NMG marks the record deleted, removes it from
normal retrieval and derived indexes, and retains a tombstone for audit. The
CLI equivalent is `nmg memory delete MEMORY_ID`. Neither interface claims to be
physical privacy erasure; full provenance and aggregate-signal erasure is a
separate lifecycle operation.

User-owned data is exportable without opening SQLite directly. `nmg memory export --json` emits a versioned `nmg.memory-export.v1` bundle containing each
MemoryRecord, its MemoryNode, and all retained HistoryRecord evidence/provenance.
The default actor filter is `user`; `--all-actors` and `--include-deleted`
broaden the export explicitly so routine Agent/tool material and tombstones are
not included accidentally.

The default Pi path treats a successful governed `nmg_remember` write as the
positive admission signal. The adapter resolves its exact `evidence` against
the most recent bounded window of the current Pi branch, preserves the original
case from the matched source, and binds the HistoryRecord by stable source
message ID. The projection contract is versioned as `pi.branch.v1`; an
incompatible Pi message shape fails closed to the self-contained evidence path
rather than binding false provenance. Evidence longer than the deterministic excerpt bound is not copied
through this path and should instead use an explicit external artifact
reference. If the source cannot be resolved, the supplied evidence remains a
self-contained explicit fallback. This keeps selected evidence after Pi deletes
a session without paying to preserve ordinary conversation.

Clear, stable user-stated facts, preferences, constraints, and replaceable
states may become atomic LTG memories automatically. They do not need to wait for
a stable local subgraph. Ambiguous, inferred, sensitive, or current-task-only
candidates remain in STG, require confirmation, or expire according to policy.
Inferred relations and derived concepts require repeated independent evidence
before structural consolidation. Casual chatter, credentials, secrets, and
unverified model claims do not become verified semantic memory. Assistant
content may be retained as unverified conversation evidence when it is useful to
remember that it was said.

### `remember` as the semantic maintenance boundary

Attribution is fail-closed at the harness boundary. The Pi adapter defaults an
unspecified `sourceActor` to `assistant`; a record attributed to `user`, `tool`,
or `system` must bind an exact excerpt from that actor in the current session,
or carry explicit external provenance. This prevents an Agent inference from
silently acquiring user authority before Core admission and consolidation.

`remember` is the deliberate LLM intervention point between semantic judgment
and deterministic storage. The two sides have different responsibilities:

| LLM / Agent | NMG core |
| --- | --- |
| Extract a self-contained statement; assign type, actor, time, scope, and importance; optionally provide a few short phrases by which the same fact is likely to be recalled; decide whether a returned candidate is the same meaning, a genuinely replaced old value, a related concept, or distinct. | Enforce admission policy, stable IDs, exact deduplication, scope/state invariants, provenance, transactions, trigger limits, index deltas, version history, and reversible graph changes. |

`recallTriggers` are optional retrieval metadata on the same governed write, not
additional facts, tags, or a second memory object. The Agent may supply up to 16
short, distinct aliases or likely query phrases when the canonical statement
uses wording that a future query may not repeat. NMG normalises and indexes the
phrases with the record, but never discloses marker syntax to the answering
Agent and never lets a trigger change truth, scope, provenance, importance, or
node membership. The canonical statement and evidence remain the content that
is returned after recall. This deliberately borrows the useful part of a Skill
header/body split: a small routing header may find a precise body, but it does
not become another instruction system.

```text
remember(statement, evidence, recallTriggers=[short alias, likely query phrase])
  -> validate and store one semantic record
  -> index statement + evidence + recall triggers
search(query)
  -> trigger text may nominate the record
  -> disclose only the canonical statement/evidence
```

Triggers should encode how the existing fact may be asked for, not broad topic
words, guesses about future facts, or copies of the whole statement. A missing
trigger is normal: semantic embeddings and FTS still operate on the canonical
record. A legacy `retrieveHint` marker remains readable during migration, while
new writes use the canonical `recall_trigger` marker.

The common path remains one call. NMG writes the governed atom and returns only
a bounded set of ambiguous near-duplicate or supersession candidates. When a
candidate requires semantic judgment, the Agent may submit a second phase
through the same `nmg_remember` tool. The first implemented resolution is
`supersede`: the Agent identifies the new and stale record; NMG verifies that
both records exist in the same LTG or session-owned STG store and have identical
scope before applying the versioned replacement. The write is idempotent and
enforces one direct predecessor and one direct successor per version, preventing
feedback retries from overwriting a chain link. Retrieval may use stale wording
as an anchor, but resolves the full chain and materializes the current or
requested as-of version before disclosure. Similarity alone never authorizes
replacement.

Exact duplicates and stable `stateKey + scope` replacement remain deterministic
and need no LLM round trip. Physical node merge, split, deletion, and arbitrary
SQL mutation are not part of model-facing `remember`; they require stronger
validation and remain reversible maintenance operations. This preserves a
small tool surface while allowing model capability to improve semantic
organization without moving database invariants into prompts.

Tool output and logs are ephemeral by default. NMG does not duplicate their
result bodies during session capture. A model or user may explicitly promote a
bounded exact excerpt, an irreproducible result, or a requested full artifact
through the governed memory/evidence path; that retained evidence keeps its tool
source identity. Successful routine output, build logs, and reproducible command
output remain in the harness history and follow its retention policy. Secrets
and credentials are never promoted automatically.

Raw-event identity and content storage are separate concerns. Repeated events
may retain distinct timestamps and provenance while sharing one
content-addressed body in a future object layer. Exact hash/identity
deduplication is safe for evidence; embedding-based semantic deduplication is
reserved for mutable memory organization and must not erase distinct historical
events.

Replaceable state uses a stable semantic `stateKey` plus canonical scope. A new
active value supersedes the prior value without deleting historical evidence.
Reuse the key only when the new value makes the old one no longer current; two
values that can remain true together (for example a personal best and a target)
are separate properties and require separate keys.

> `RememberInput.judgeDuplicates` (`DuplicateJudge`, `src/core/types.ts`) is an
> implemented Core injection point: exact, normalised, and near candidates are
> computed deterministically, then an embedding- or model-backed caller may
> return a validated merge/supersede decision. The daemon and adapters
> deliberately do not serialize callbacks across the RPC boundary; their
> governed path remains the explicit two-stage Agent resolution described above.
> Judge absence therefore degrades to candidates, never to an implicit model call.
