# Node identity and reversible canonicalization

[中文](node-identity-and-reversible-canonicalization.zh-CN.md) · [Terms used](node-identity-and-reversible-canonicalization.terms.yaml)

**Authority:** [Parent scope](../active-graph-activation-and-consolidation.md).

### Node identity and reversible canonicalization

Node similarity is only a blocking signal that proposes pairs for comparison.
It does not authorize a merge. NMG distinguishes:

```text
SAME_ENTITY    same real-world object
EXACT_MATCH    concepts broadly interchangeable for retrieval
CLOSE_MATCH    concepts interchangeable only in some contexts
BROADER        source concept contains the target
NARROWER       source concept is contained by the target
RELATED        associated but independently meaningful
DIFFERENT      explicit non-identity evidence
```

This follows the distinction between strict identity and the weaker
`exactMatch`, `closeMatch`, `broader/narrower`, and `related` relations in
[OWL identity](https://www.w3.org/TR/owl2-rdf-based-semantics/) and
[SKOS](https://www.w3.org/TR/skos-reference). In particular, `CLOSE_MATCH` is
not transitive and must not create an equivalence closure.

Identity resolution uses three decisions rather than a forced binary merge,
following [Fellegi–Sunter record linkage](https://doi.org/10.1080/01621459.1969.10501049):

```text
log_odds_same =
  prior_log_odds
  + sum(feature_log_likelihood_ratio)

high confidence -> SAME_ENTITY candidate
middle interval -> possible link / human or Agent review
strong mismatch -> DIFFERENT
```

Names, embeddings, shared evidence, aliases, time, scope, stable external IDs,
and defining attributes are comparison features. Node-kind incompatibility,
different stable IDs, disjoint scope, event-time differences, incompatible
validity intervals, or explicit non-identity are hard vetoes. Correlated
features must be grouped or calibrated rather than counted as independent
evidence.

For concepts, merge is also a model-selection decision. An
[MDL](https://arxiv.org/abs/math/0406077) gain is positive only when one shared
description plus exceptions is shorter than two separate descriptions:

```text
delta_MDL =
  [L(separate_model) + L(data | separate)]
  - [L(merged_model) + L(data | merged)]
```

If a merged description needs many scope qualifiers, conflicts, or exceptions,
NMG keeps the nodes separate or creates a common broader parent. This mirrors
[COBWEB incremental concept formation](https://axon.cs.byu.edu/~martinez/classes/678/Papers/Fisher_Cobweb.pdf),
which compares adding, creating, merging, and splitting categories instead of
assuming merge is the only operation.

The safe lifecycle is:

```text
candidate pair
  -> classify identity/match/hierarchy relation
  -> shadow canonical view
  -> compare retrieval utility, conflicts, and MDL
  -> accept or reject
  -> reversible canonical view
```

Acceptance never physically deletes source nodes or evidence. The current
explicit (or deliberately enabled, strongly gated automatic) `mergeNodes`
actuator does move memory ownership to a target node and
rewrites its local relation neighbourhood, so each new merge also writes an
exact rollback journal: source/target node snapshots, original memory
assignments, and the complete pre/post relation sets. `node rollback` restores
that state in one immediate transaction only if every moved memory, involved
node status, and relation still matches the recorded post-merge state. It
refuses to overwrite later edits. A newly created merge target remains as an
inactive tombstone after rollback so stable IDs and audit history are not
reused; a pre-existing target is restored exactly. Merge transforms created
before journaling cannot be rolled back automatically. A later split reassigns
only evidence with known provenance; ambiguous members remain under the
old/common parent rather than being guessed into a child.

Node kinds require different defaults:

- entities may become `SAME_ENTITY` under strong identity evidence;
- concepts normally use exact/close/hierarchical relations;
- states with different time or scope use `SUPERSEDES` or coexistence, not merge;
- repeated events remain distinct events and may share an event/problem cluster.

Because false merges are more destructive than missed merges, automated
identity uses a high asymmetric-loss threshold. The default action for uncertain
pairs is a typed link, not a merge.

The BPID hard-negative audit (`topology-bpid-evaluation-2026-08-09.md`) shows
why that threshold cannot be supplied by raw field similarity: even a `0.98`
multi-field blocking score selected 19 false matches among 241 candidates while
recalling only 222 of 4,333 true matches. Candidate generation and identity
acceptance are therefore separate stages. A cheap blocker may bound semantic
review, but its score is not accepted as calibrated merge confidence.

The optional Namesakes adapter (`topology-namesakes-evaluation.md`) makes that
separation explicit for ambiguous names. It uses labelled `Same`/`Other`
mentions to report alias-like positive recall and exact-name negative rejection
over a full threshold curve. It is a streaming, read-only Lab evaluation; it
does not submit proposals or export a benchmark threshold into Core. The
official Entities split was run in full (4,148 rows; 23,996 scored mentions).
The local hashing baseline cannot separate aliases from namesakes: at threshold
0.5 it gives 0.942 recall, 0.716 precision, and rejects only 0.026 of exact-name
negatives; at 0.7 rejection rises to 0.684 while recall collapses to 0.304. It is
therefore acceptable only as a broad candidate generator, never as merge
confidence or an automatic topology actuator.

A fixed ten-entity paired Agent probe additionally compared clean `Same`
evidence with the identical evidence plus one high-scoring record taken from a
separately resolved foreign entity page. Across five stochastic repeats and 50
paired observations, DeepSeek V4 Flash exact attribution was 84% clean versus
88% contaminated; five pairs became wrong, seven became correct, the exact
McNemar p-value was 0.774, and no foreign record was accepted. The corrected
probe therefore finds no stable downstream attribution effect on this small
sample. Natural correction/recovery cost, larger-pair behavior, and end-to-end
answer damage remain unmeasured. Automatic identity mutation remains off.

The implemented `remember` boundary enforces that distinction. After saving a
memory, an Agent may classify one bounded candidate as `same_entity`, `related`,
`refines`, `conflict`, or `distinct`. NMG validates that both evidence memories
belong to the same physical LTG or session-owned STG store, conservatively
rejects identity/refinement/conflict claims with incompatible scope, and rejects
conflicts whose explicit validity intervals do not overlap. It then stores a
provenance-bearing **pending topology proposal**. `same_entity` creates a
regulatory `same_as` proposal; it does not call `mergeNodes`, redirect an ID, or
change either node's status. Proposal review and physical identity merge remain
separate maintenance operations. The daemon exposes one typed topology-proposal
administration RPC, and the CLI provides `topology proposals`, `assess`, `review`,
and `actuate`. Assessment is read-only; review records an explicit decision; and
actuation still accepts only an eligible accepted automatic merge proposal.
These operations remain outside the Pi model-facing tool surface.
