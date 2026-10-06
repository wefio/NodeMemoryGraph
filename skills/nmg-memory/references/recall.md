# Recall manual

## Progressive recall and process limits

Treat automatically injected recall and search results as candidate headers.
Use `nmg get` to load selected exact records and evidence. Decide whether the
question needs one or several records; candidate count does not prove evidence
completeness. Treat the latest request as the recall target and older context as
disambiguation. No useful memory is a valid result. Start shallow. If information
may still be missing, try one narrower or complementary query, then increase
`--max-tier`, `--limit`, or `--graph-hops`. Verify volatile facts against a
current source before relying on them. If lexical results are still insufficient
and embeddings are configured, switch to `--retrieval-mode hybrid` (see
[embedding](embedding.md)). Do not load all candidate evidence into the model.

Pi applies a per-user-turn process budget: at most three searches and five total
search/get calls. Two searches without exact-evidence progression require a
`get`; two consecutive searches returning no new candidate IDs stop recall. Do
not work around these guards by paraphrasing the same query. Answer from loaded
evidence, state the remaining uncertainty, or wait for a new user turn.

## Result fields and narrowing

`nmg search --compact-json` returns `candidates[].id` and top-level
`activeGraphId`; `--json` returns `results[].memory.id` and `activeGraph.id`.
Pass that graph ID to `nmg get --active-graph-id` to attribute exact-evidence use,
not retrieval success.

Narrow by `--node`, `--scope` or `--source-actor user` when relevant.
Use `--include-historical` only for old/superseded state. Start with `--max-tier 1`
and `--limit 8`, not a full evidence dump.

## Escalation order

1. Rewrite the query around the missing entity, time, or relation.
2. Increase `--limit` from 8 toward 20.
3. Increase `--max-tier` one level.
4. Add `--graph-hops 1` or `2` for related concepts.
5. Use `--include-historical` only when old or superseded state is relevant.
6. If lexical results are insufficient and embeddings are configured and the
   index is ready, switch `--retrieval-mode hybrid` (see
   [embedding](embedding.md)).

Stop when evidence is sufficient. Use `nmg get` only for IDs likely to affect the
answer, and pass `--active-graph-id <ID_FROM_SEARCH>` so NMG can distinguish
actual evidence use from a merely displayed candidate.

## Warm-memory continuation

The CLI and Pi adapter rank the complete warm candidate pool once. Pools of up
to four records are exposed in full; pools of five or more initially expose
only their hotter half. When a search result reports folded records,
inspect the visible headers first. If they are insufficient, call `nmg_get`
once with the reported deferred memory IDs. Do not repeat `nmg_search`: the
deferred IDs are the budgeted second window of the same stable ranking, and
exact lookup does not repeat embedding or ANN work. Each response remains
bounded by the caller's evidence and token budgets. Use `--full-warm` only for
diagnostics that intentionally expose the entire ranked L1 pool immediately.

## Progressive second pass

To make physical storage progressively searchable, add `--tiered-disclosure`.
NMG opens internal tiers only while deterministic QPP still reports insufficient
evidence. It composes with, but is distinct from, `--second-pass`: the former
widens the physical search scope; the latter widens the evidence prefix inside
the opened candidate pool. Physical tier names remain an NMG diagnostic detail,
not evidence for the answering model.

When the first recall quality is doubtful but the query is right, re-select
within the same candidate pool instead of changing the query:

```text
nmg search "<query>" --project-dir . --second-pass --limit 8 --compact-json
```

`--second-pass` walks cumulative Fibonacci evidence tiers (1, 2, 3, 5, ...),
recomputing the QPP confidence after each tier from the same over-sampled
pool. No re-search occurs — it only widens the selected evidence.

## QPP tuning

NMG has three independent retrieval-confidence controls (environment
variables read at startup):

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `NMG_QPP1_MODE` | `off`, `shadow`, `active` | `shadow` | First-pass candidate-pool allocation |
| `NMG_QPP2_MODE` | `off`, `shadow`, `active` | `off` | Fibonacci progressive detection + fold |
| `NMG_QPP2_RETAINED_MASS` | `0..1` | `0.98` | Probability mass retained per fold |
| `NMG_SEARCH_RECOMMENDATION` | `off`, `advisory`, `guardrail` | `off` | Suggests an explicit search to the model on weak recall |

Shadow mode computes and logs the decision without acting on it — use it to
observe, then flip to `active` once behavior is stable. Lab feedback for
shadow evaluations:

`active` is still fail-safe before supervision: an untrained controller cannot
change QPP1 allocation or QPP2 listwise visibility. A caller-specified search
limit overrides learned allocation/folding, while explicit `--second-pass`
continues to request deterministic Fibonacci expansion.

```text
/nmg-shadow-feedback last success|failure|corrected|uncorrected|unknown
```

## Conflicts

Do not silently choose whichever result ranks first. Compare time, scope, status,
truth status, and evidence. Current active state normally overrides older state
with the same key and scope; old events remain historical evidence.

## Multi-part questions

Use complementary subqueries for independently required facts. A broad query may
retrieve only one aspect. List or count from exact loaded records, not from search
previews.

## No result

Say that no matching memory was found. Do not invent remembered facts. If NMG is
unavailable, continue without memory and disclose the limitation when it matters.
