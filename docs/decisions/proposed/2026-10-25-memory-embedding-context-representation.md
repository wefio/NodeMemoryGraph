# Give the memory retrieval representation its date and previous turn

[简体中文](2026-10-25-memory-embedding-context-representation.zh-CN.md) · [Terms](2026-10-25-memory-embedding-context-representation.terms.yaml)

**Status:** proposed
**Approved:** explicit

## Problem

A memory's retrieval text is `${canonicalName}: ${statement}`. The record keeps
`event_time` (populated for every row in the LoCoMo stores we measured), and the
turn it came from sits in `history_records` next to its predecessor — neither is
part of the text that is embedded, so a record like "last year, and then every
week" is encoded without a date, a speaker attribution or the question it answers.

Measured on LoCoMo across all 1,977 answerable questions (plain BGE cosine, page of
twenty records, no reranker, nothing fitted):

| Aggregation                       | raw text | date + previous turn | change |
| --------------------------------- | -------: | -------------------: | -----: |
| label-level micro recall@20       |    58.7% |            **65.8%** | +7.1pp |
| question-weighted category recall |    63.5% |            **71.8%** | +8.3pp |
| full evidence coverage            |    60.0% |            **68.1%** | +8.1pp |

The two components are not interchangeable: the date carries most of the gain on
multi-hop questions, the previous turn carries +5.3pp on single-hop and +21.3pp on
adversarial ones. On temporal questions the bundle loses 1.4pp, which is the next
thing to fix; it is not a reason to withhold the other four categories.

## Proposal

`memoryEmbeddingText` accepts an optional context of `eventTime` and
`previousTurn`, and the vector identity gains a representation version.

- The text is `[YYYY-MM-DD ]<node>: <statement>[\nprevious: <turn>]`. Only the
  calendar day of `event_time` is used; a value the date parser cannot read
  contributes nothing rather than an arbitrary string. The previous turn is
  whitespace-collapsed and bounded at 240 characters.
- Without context the output is byte-identical to the previous text, so callers
  that have no context cannot silently change their vectors.
- The identity becomes `memoryEmbeddingModelId(embedderModel)` =
  `<embedder>@rep2-date-prev`. This is not cosmetic: `memory_embeddings` is keyed
  by `(memory_id, model)` and the indexer only re-embeds rows whose model id is
  missing, and retrieval joins `memory_embeddings ve ON ve.model = ?`. Changing
  the text under the old id would leave stale vectors that read as valid.

### What the wiring requires

1. **Resolve the previous turn.** The record's source turn is reachable through
   `memory_evidence_links` → `history_records`; the previous turn is the row in the
   same `session_id` with the largest `source_message_id` below the current one.
   No new column is needed.
2. **Thread `event_time` into the three writers and the reader** —
   `embeddingDocuments`, `refreshEmbeddings`, `rebuildVectorIndex`, and
   `memoryText`.
3. **Swap the identity in one change, not two.** The write path and the retrieval
   join must move together: half a change either leaves stale vectors in use or
   hides every vector from search.
4. **Re-embed.** After the identity bump, `rebuildVectorIndex` populates the new
   rows; rows under the old id stay behind and are ignored. A store must not be
   readable under both ids at once.
5. **Acceptance on the real path.** Re-ingest LoCoMo through the product path and
   confirm the page still returns twenty original records with the gain intact,
   referenced against the measured 65.8% micro / 68.1% full coverage.

## Acceptance criteria

- A store re-ingested through the product path returns twenty original records per
  query, never context windows, with label-level micro recall@20 at or above the
  measured **65.8%** and full evidence coverage at or above **68.1%** on the LoCoMo
  protocol used in the experiment record.
- Vectors written under the previous representation id are never used together
  with text produced by the new one; a store read under both ids at once is a
  defect, not a fallback.
- A record with no `event_time` and no resolvable predecessor keeps the exact text
  it has today (the unit test pins this).

## Risks

- **Half a migration.** Changing the writer without the retrieval join (or the
  reverse) either serves stale vectors or empties the vector channel. The identity
  swap must land as one change.
- **Temporal regression.** The bundle loses 1.4pp on temporal questions; adopting
  it without the refinement below trades a small loss there for large gains
  elsewhere. That trade is deliberate and reversible by representation version.
- **Context availability.** The previous turn depends on `history_records` still
  holding the predecessor. Where history has been pruned the text degrades to
  date-only, which is a smaller gain but not a wrong one.
- **Re-embedding cost.** A full re-embed is linear in records and is paid once per
  representation version, not per query.

## Alternatives considered

- Store the context on the record (extra columns for previous turn): duplicates
  dialogue already in `history_records`, and the copy goes stale when history is
  pruned.
- Recompute the text at query time instead of write time: the passage being
  compared would be a hallucination of the join, not a stored representation, and
  every query would pay for it.
- Keep one identity and rewrite vectors in place: briefly leaves a store whose
  vectors and text disagree, with no way to tell which rows are current.

## Consequences

The representation becomes a function of three stored fields instead of one, so a
record whose date or predecessor changes needs its vector recomputed — the
maintenance pass already re-embeds by memory id.

Temporal questions currently lose 1.4pp under this representation. The recorded
next step is a narrower context ("the entities, referents and event time needed to
read _this_ record") rather than a longer window; the bundle as measured is the
baseline that refinement must beat.

## Implementation status and the first re-measure (2026-10-25)

Wired as specified: `memoryEmbeddingText` carries `eventTime` and `previousTurn`,
the previous turn is resolved from `history_records` by one correlated subquery
(shared as `MEMORY_PREVIOUS_TURN_SQL`), and the identity is
`memoryEmbeddingModelId(embedderModel)` at the three writers and in the single
read path (`search()` → `searchWithVector`). Two tests pin it: re-embedding
produces the dated, predecessor-bearing text under the versioned id, and a search
still reaches the memory afterwards — the failure mode this change could have
introduced is a silent empty vector channel, so that half is tested explicitly.

Re-measured through the shipped builder on the product's **default** embedder
(deterministic hashing, 256-d), 1,978 questions, page of 20, full corpus:

| Arm                        | label micro recall@20 | full coverage |
| -------------------------- | --------------------: | ------------: |
| raw text                   |                  37.0 |          40.3 |
| + date                     |                  37.0 |          39.8 |
| **+ date + previous turn** |              **37.9** |      **42.4** |

That is **+0.9pp recall and +2.1pp full coverage**, not the +7.1/+8.1 measured in
the experiment record. The difference is the embedder, not the wiring: the
recorded gains were measured with `bge-small-en-v1.5`, and the hashing embedder is
largely insensitive to the added tokens because its features are hashed
word-shingles.

**Consequence for the acceptance criterion.** The 65.8% / 68.1% bar can only be met
on a store whose embedding profile is BGE; on the product default profile the
change is worth roughly a quarter of that. The re-measure that closes this record
must therefore run the benchmark harness against a BGE-profile store (the local
embedding server, or the deployed profile), not the default embedder. Until then
this record stays proposed and the change must not be cited as a 7-point gain.

## Real-path re-measure on the BGE profile (2026-10-25)

Run through the product path instead of a side channel: each LoCoMo store is
copied, the stale same-id vectors are cleared, `syncRecordEmbeddings` writes the
text that `memoryEmbeddingText` now produces, and the page is ranked from the
vectors the product stored. Both arms use the same client
(`bge-small-en-v1.5`, `bge-en` profile) and the same 1,978 questions.

| Arm (same path, product text shape) | label micro recall@20 | full coverage |
| ----------------------------------- | --------------------: | ------------: |
| legacy text `${node}: ${statement}` |                  58.1 |          59.8 |
| **date + previous turn**            |              **60.8** |      **64.3** |
| change                              |            **+2.7pp** |    **+4.5pp** |

Two facts to keep apart:

1. **The direction survives the product path, the magnitude does not.** Offline the
   same change was worth +7.1pp / +8.1pp; here it is +2.7pp / +4.5pp.
2. **The gap is the node name.** The product text is
   `${canonicalName}: ${statement}`, and in these stores the canonical name is
   `Conversation batch-<hash>` — the same noise prefix in every arm. It costs the
   harder categories the most: multi-hop context recall is 40.7% on the product
   path against 49.0% offline.

Consequently the acceptance bar set above (65.8% / 68.1%) is **not met** on the
current text shape: 60.8% / 64.3%. The record stays proposed.

The next lever is now specific and cheap: the node name in the embedding text is
noise for retrieval (it is a conversation batch identifier, not a topic), and
dropping it from the embedded string is a one-line change that both arms above
would benefit from. That should be measured before any further representation work,
because it accounts for most of the distance between 60.8 and 65.8.

## Dropping the node name (2026-10-25, representation `rep3-no-node`)

The node name is no longer part of the embedded text. Node names stay in the
lexical index (`ftsIndexedText`), where an exact name match still works; they no
longer dilute the dense representation. Re-measured through the same product path:

| Arm                                      | label micro recall@20 | full coverage |
| ---------------------------------------- | --------------------: | ------------: |
| legacy text `${node}: ${statement}`      |                  58.1 |          59.8 |
| + date + previous turn, with node name   |                  60.8 |          64.3 |
| **+ date + previous turn, no node name** |              **62.9** |      **65.5** |

Dropping the node name is worth **+2.1pp recall / +1.2pp coverage** on top of the
context, and the total against the legacy text is **+4.8pp / +5.7pp**.

The earlier estimate in this record that the node name "accounts for most of the
distance between 60.8 and 65.8" was **too optimistic**: it recovers about a third
of it. The acceptance bar (65.8% / 68.1%) is therefore still **not met** on the real
path — 62.9% / 65.5% — and this record stays proposed.

The residual ~3pp gap has three identified candidates, all cheap to test:

1. **Date shape.** The offline variant that measured best carried the full session
   timestamp string from the dataset (`2:32 pm on 29 January, 2023`, plus the
   session index); the product writes a bare `YYYY-MM-DD`. The session index alone
   was worth 1.1pp offline, and it has no product equivalent, so part of the gap is
   expected to be unrecoverable.
2. **Previous-turn shape.** The offline variant prefixed the turn with
   `previous turn — Speaker:` and did not truncate; the product uses
   `previous: …` bounded at 240 characters.
3. **Ranking path.** The offline numbers rank every stored record by cosine; the
   product path here still ranks stored vectors by cosine, so this one is not a
   difference — it is listed to record that it was checked.
