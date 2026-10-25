# Can the structural layer carry part of retrieval? Six measurements on LoCoMo

[简体中文](2026-10-25-structure-index-probe-locomo-2026-10-25.zh-CN.md)

**Revision (2026-10-25):** three inferences in sections 1, 6 and 8 are withdrawn — see §5 and R1–R3 at the end. The relation-expansion arm was not runnable.

## What this record answers

The proposal: let **nodes, leaf blocks, records and edges share the navigation job**, with the structure acting as a **partial index** — SPANN-shaped region routing overall (cluster representatives locate a region, boundary records are handled), Vamana/NSG-shaped edge construction locally (bounded out-degree, connectivity, cross-region shortcuts), HNSW as the performance reference.

This record splits that proposal along two axes that are independent of each other:

| Axis   | Question                                                                                      | Answer here                                              |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Recall | can structure bring evidence into the candidate pool or the page that direct retrieval misses | No (entry blind spot ≤4%, in-page ranking −6pp)          |
| Cost   | can structure make a query scan fewer records                                                 | Yes, but a single structural level is too shallow to pay |

Every number is computed locally with **zero LLM calls**; paired comparisons all go through the same frozen contract (`pairedComparison`), and p-values are exact sign tests.

## Data and measurement

- Corpus: ten LoCoMo conversations, **5,879 records**, 282 multi-hop questions (`category=1`, gold resolvable to records by exact turn text).
- Average store per question **595 records**, average **3.12 gold labels**.
- Embeddings: `BAAI/bge-small-en-v1.5` (384-d, queries carry NMG's `bge-en` prefix, documents do not), encoded locally on CUDA for 5,879 records and 282 questions.
- Lexical: a local BM25 with one tokenizer and one stop-word policy.
- Two metrics: **full coverage** (every labelled turn of a question has a record inside the page, per question) and **recall** (labels inside the page / total labels).
- Store: NMG's persisted `memory_records` / `memory_nodes`, one database per conversation.

## 1. Structure as a candidate entry: the blind spot is essentially zero

Comparing the sessions/leaf blocks that direct retrieval touches against those holding gold (BGE ranking, 100 candidates):

| Granularity                         | @20 blind | @20 partial |  @20 full | @100 blind | @100 partial | @100 full |
| ----------------------------------- | --------: | ----------: | --------: | ---------: | -----------: | --------: |
| Session (19–32 per conversation)    |      2.1% |       40.4% | **57.4%** |   **0.0%** |         1.1% | **98.9%** |
| Leaf block (16 consecutive records) |      3.9% |       45.4% |     50.7% |   **0.0%** |         4.6% |     95.4% |

With 100 candidates, **98.9% of questions already have every gold session touched** and the blind spot is 0. "Retrieval keeps circling the first topic it hit" is not a repairable defect on this corpus: as a candidate _entry_, nodes/blocks/edges have work on at most 4% of questions.

## 2. The k ladder: where the ceiling is, where we are

BGE ranking over the same questions, treating the first k records as the pool to choose from:

| k        |    5 |   10 |   **20** |   40 |   60 |      100 |  200 |
| -------- | ---: | ---: | -------: | ---: | ---: | -------: | ---: |
| full %   | 10.3 | 16.7 | **24.1** | 35.8 | 44.7 | **59.6** | 77.7 |
| recall % | 23.2 | 33.5 |     45.2 | 58.7 | 66.5 |     76.8 | 89.7 |

Three different ceilings, kept apart:

| Ceiling                                         |     Value | Meaning                                                           |
| ----------------------------------------------- | --------: | ----------------------------------------------------------------- |
| Candidate ceiling (all gold inside the top 100) | **59.6%** | the best any selector of 20 slots can reach from these candidates |
| Current page (top 20 by similarity)             | **24.1%** | today                                                             |
| Whole store                                     |      100% | labels are in the store (a denominator check, not a target)       |

**The page is 40% of the candidate ceiling; the remaining 35.5pp is entirely "which 20 of the pool".** Supporting detail: among the 215 partially covered questions, the nearest missing gold sits at vector rank 21–25 for 32 questions, 26–30 for 25, 31–50 for 56, 51–100 for 56, and beyond 100 for 46 — the missing evidence clusters near the boundary rather than being unreachable.

## 3. Channel ladder and fusion weight

| Arm | Construction                      |   full % | recall % | versus vector-only                         |
| --- | --------------------------------- | -------: | -------: | ------------------------------------------ |
| V   | BGE vector top-20                 | **24.1** |     45.2 | —                                          |
| L   | BM25 top-20                       |      9.2 |     26.2 | 8W/50L, p<0.001                            |
| A   | equal-weight RRF(vector, lexical) |     18.1 |     38.1 | **17W/34L, p=0.024 (significantly worse)** |
| A73 | weighted 0.7/0.3                  |     25.5 |     44.8 | 16W/12L, p=0.57                            |
| A91 | weighted 0.9/0.1                  |     25.5 |     45.4 | 6W/2L, p=0.29                              |

Equal-weight RRF is a strawman: mixing a weak lexical list into a strong vector list at 1:1 significantly lowers coverage. Weighted fusion is +1.4pp and **not significant**.

For comparison, the proposing side measured "vector plus lexical fusion beats vector-only by 4.12pp (73.37% → 77.49%)" on 81 questions from one conversation. **This record does not reproduce that magnitude** on 282 questions across ten conversations (weighted +1.4pp, not significant). The difference may come from the lexical implementation (a hand-written BM25 here; possibly the product FTS with stemming and name normalisation there) or from corpus size, and needs a cross-check.

## 4. Structure as a selection signal: useless as a ranker, directional as a supplement

Same 100 candidates, only the choice changes:

| Arm    | Construction                                          |   full % | recall % | versus V                 |
| ------ | ----------------------------------------------------- | -------: | -------: | ------------------------ |
| V      | page = vector top-20                                  |     24.1 |     45.2 | —                        |
| BV     | page = vector + 0.25·**block centroid** cosine        |     18.1 |     38.6 | 16W/33L, p=0.021 (worse) |
| CV     | page = vector + 0.25·**session centroid** cosine      |     18.1 |     38.4 | 16W/33L, p=0.021 (worse) |
| **DV** | page = V, **supplement 5 picked by structure**        | **30.5** |     50.3 | **18W/0L, p<0.0001**     |
| **EV** | page = V, supplement 5 picked by similarity (control) |     28.0 |     49.0 | **11W/0L, p=0.001**      |

**DV versus EV: 30.5% against 28.0%, 15W/8L/259T, p=0.21** — the direction is right, the size is small, significance is absent.

The supplement itself is worth +3.9pp (EV, purely "five more slots"); the structural signal adds +2.5pp on top. As soon as structure enters **in-page ranking**, it is significantly worse: twenty slots is a zero-sum allocation.

## 5. SPANN-shaped region routing: boundary replication is the dividing line

Regions are the stored sessions; leaves are k-means clusters inside a region (target 16 records); boundary replication at τ=0.9 adds a record to its second-nearest block as well.

| Configuration               |   full % | recall % | vectors compared | versus exhaustive        |
| --------------------------- | -------: | -------: | ---------------: | ------------------------ |
| Exhaustive                  |     24.1 |     45.2 |              595 | 1.0×                     |
| R=all, L=all (no pruning)   |     24.1 |     45.2 |              595 | **identical**            |
| R=8, L=12 (no replication)  |     16.3 |     39.4 |              221 | 2.7× cheaper, −7.8pp     |
| **R=8, L=12 + replication** | **23.0** |     44.5 |          **330** | **1.8× cheaper, −1.1pp** |
| R=4, L=6 (no replication)   |      9.6 |     32.0 |              125 | 4.8× cheaper, −14.5pp    |
| R=4, L=6 + replication      |     19.9 |     41.8 |              200 | 3.0× cheaper, −4.2pp     |

1. **Without pruning the result is identical to exhaustive** — an index approaches the ceiling, it does not change it. This is the same phenomenon as the proposing side's "fixed hierarchical navigation" matching full vector search digit for digit.
2. **Boundary replication is not an optimisation, it is the usability boundary**: at the same budget it turns −7.8pp into −1.1pp, paid for with +50% comparisons.
3. The net gain is **1.8×**, not an order of magnitude.

## 6. Graph navigation on the structural layer (Vamana idea): one level is not worth it

Pooling the ten conversations into one store (**5,879 records / 506 leaf blocks / 282 questions**), a bounded-degree graph is built over block centroids (symmetrised for connectivity) and navigated best-first; the control scores every block centroid and keeps the best B. The budget B counts evaluated blocks.

| Arm                       |   full % | recall % | block comparisons | records scored |
| ------------------------- | -------: | -------: | ----------------: | -------------: |
| Exhaustive (record level) |     20.6 |     42.3 |                 0 |          5,879 |
| flat B=8                  | **17.4** |     39.6 |               506 |            295 |
| graph B=8                 |      7.4 |     16.7 |                80 |            263 |
| flat B=16                 | **19.5** |     41.8 |               506 |            589 |
| graph B=16                |     12.4 |     27.0 |               160 |            558 |
| flat B=32                 | **21.3** |     42.7 |               506 |          1,160 |
| graph B=32                |     18.1 |     34.1 |               320 |          1,142 |
| flat B=64                 |     21.3 |     42.7 |               506 |          2,326 |
| graph B=64                |     18.4 |     38.4 |           **640** |          2,326 |

1. Graph navigation **loses at every budget** to scoring all block centroids; at B=64 it even costs more comparisons (640 versus 506).
2. The arithmetic: block centroids cost 506 comparisons, records cost 5,879, so **the block layer is only 8.6% of the record cost**. Even a free block layer saves 8.6% at most, and the price is choosing blocks less accurately.
3. General rule: **the ceiling of an index's gain ≈ (units in the indexed layer / records) × pruning rate**. To benefit from vector-index machinery the hierarchy must shrink an order of magnitude per level (records 10⁵ → blocks 10⁴ → sessions 10³ → topics 10²); the deepest layer here has 506 units.
4. Incidental finding: `flat B=32` (21.3%) is **above exhaustive top-20** (20.6%). Coverage is not monotone in similarity — restricting candidates to a few blocks filters out high-similarity distractors.

## 7. Cost model: is a full-store scan actually expensive

Local Node, `Float32Array`, 384 dimensions, single thread, exhaustive cosine over the whole store:

| Store size N |   Per query | Per record |
| -----------: | ----------: | ---------: |
|        1,000 | **0.31 ms** |     308 ns |
|       10,000 |  **3.0 ms** |     303 ns |
|      100,000 |   **34 ms** |     344 ns |
|    1,000,000 |      315 ms |     315 ns |

A typical NMG store (10²–10⁴ records per user) scans in 0.3–3 ms already; an index in that range saves 0.1–3 ms while paying 1–8pp of recall. An index earns its place above **10⁵**, or under a strict p99 with concurrency (single-threaded JS blocks the event loop). The marginal cost that does hurt is not the vector scan but the **answer-context tokens**: going from a 20-record page to 25 records is worth +3.9pp at roughly +650–690 characters per question.

## 8. Verdict per proposed component

| Component                      | Verdict                                                                                               | Evidence                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| SPANN region routing           | **Valid, but a cost lever only**; a single structural level gains nothing, the layer needs ≥10³ units | sections 5, 6                  |
| Boundary replication           | **Required**; it is the usable/unusable boundary                                                      | 5 (+6.7pp at +50% comparisons) |
| Vamana/NSG edges               | Measured **worse** on one structural level; the sound use is an upper-level graph after deepening     | 6                              |
| HNSW                           | Performance reference only; cannot raise recall                                                       | 5 (no pruning = exhaustive)    |
| Structure as candidate entry   | **Ineffective** (@100 blind 0%, @20 blind 2.1–3.9%)                                                   | 1                              |
| Structure as in-page ranker    | **Harmful** (−6pp, p=0.021)                                                                           | 4                              |
| Structure as supplement picker | **Directional, not significant** (+2.5pp, p=0.21)                                                     | 4                              |
| Lexical fusion                 | +1.4pp weighted, not significant; equal weights significantly worse                                   | 3                              |

## 9. Limitations

- One dataset, one batch of 282 questions; λ swept only over 0.1/0.25/0.5; single k-means initialisation; "16 records per leaf" is a convention, not an optimum.
- BGE document vectors were re-encoded from turn text, which is not the same pipeline as the onlion capture path (`/search` with BGE); the baseline here (24.1%) therefore **cannot be compared** with the 20.8% in other records.
- Two embedders appear (`nmg-hashing-v1` 256-d and BGE 384-d); any comparison involving both is labelled, and numbers across them are never placed side by side.
- Two of this round's own errors were corrected and re-run: treating equal-weight RRF as a strong baseline, and omitting the records inside selected leaves from the routed cost. The conclusions they produced ("structure has no place at all", "14× cheaper") are withdrawn.

## 10. What would overturn these conclusions

1. **If the lexical side is replaced by the product FTS and weighted fusion becomes significantly positive**, section 3 has to be rewritten and "fusion does not help" withdrawn.
2. **If graph navigation over a layer with ≥10³ units beats flat selection at equal budget**, section 6's "one level is not worth it" becomes "deepen the hierarchy", and the structural index is valid on the cost axis.
3. **If a cross-encoder-class signal moves in-page selection from 24.1% toward the 59.6% candidate ceiling**, the source of the 35.5pp is confirmed and the centre of the work moves from structure to the judgment signal.
4. **If a real 10⁵-record store exceeds the p99 budget with exhaustive scanning**, the index moves from "not worth it" to "required", and its acceptance metric becomes p95 latency at equal recall.

## 11. Reproduction

```sh
# 1) produce BGE vectors locally (no LLM)
python evals/omnimemeval/research/probes/embed-bge.py \n  --stores <omnimemeval-nmg> --data <locomo10.json> --out <vector dir>

# 2) channel ladder / structural selection signal / supplement
node --experimental-strip-types evals/omnimemeval/research/probes/structure-selection-probe.ts \
  --data <locomo10.json> --stores <omnimemeval-nmg> --bge <vector dir> --out <out.json>

# 3) SPANN-shaped routing with boundary replication
node --experimental-strip-types evals/omnimemeval/research/probes/structure-routing-probe.ts \
  --data <locomo10.json> --stores <omnimemeval-nmg> --bge <vector dir> --out <out.json>

# 4) graph navigation over the structural layer
node --experimental-strip-types evals/omnimemeval/research/probes/structure-graph-probe.ts \
  --data <locomo10.json> --stores <omnimemeval-nmg> --bge <vector dir> --out <out.json>
```

All three probes pass the repository's eslint and `tsc -p tsconfig.tests.json`. The vectors and stores are not in the repository (size and data policy), so this is a **re-runnable** rather than a **literally reproducible** record.

## Revision (2026-10-25, after external review)

Three inferences in the sections above are **withdrawn**. They are left in place
so the correction stays visible.

### R1. Section 1 does not support "structure can help at most 4% of questions"

Session reachability (98.9% at top-100) says the _sessions_ are found. It says
nothing about whether the evidence inside them is retrieved: record-level full
coverage at 100 candidates is 59.6% (section 2). The two coverages cannot be
substituted for each other, and the inference drawn from the first is invalid.

### R2. Section 6's "8.6% bound" is a statement about one denominator only

506 centroid comparisons against an exhaustive 5,879-record scan is 8.6%; against
the already-trimmed `flat B=8` it is 506/(506+295) ≈ 63%. The ratio therefore
does not bound a structural index in general. What the run supports is narrower:
this graph variant is less accurate than scoring every centroid at every budget
tested. Whether a deeper hierarchy pays is **untested**, not refuted.

### R3. Section 8 over-generalises from two implementations

"Structure as an in-page ranker is harmful" was measured for one blending rule
(vector + centroid cosine). "An index only pays above 10⁵" was reasoned from one
pooling, not measured. `flat B=32` exceeding exhaustive top-20 (section 6) is a
further signal that the recall verdict must stay narrow.

## 5. Expansion arms at equal budget, and where the missing evidence goes

Fixed starting point: BGE top-100 over the whole store; page = the top-20 of that
pool; every arm adds exactly 5 records (mean added text 642–685 characters, so
the comparison is close to character-matched). Only the source of the 5 differs.

| Arm | Where the 5 come from                                                  |                                                     page full % | union full % | union recall % | labels newly found | added chars |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------: | -----------: | -------------: | -----------------: | ----------: |
| A   | ranks 21–25 of the same similarity order                               |                                                            24.1 |         28.0 |           49.0 |                 34 |         685 |
| B   | session neighbours (±1, then ±2) of the top page hits                  |                                                            24.1 |         26.2 |           46.7 |                 13 |         642 |
| C   | further records from the sessions the page already touched, best first |                                                            24.1 |         28.7 |           48.9 |                 33 |         685 |
| D   | relation edges                                                         | **not runnable**: `node_relations` holds 0 rows in these stores |            — |              — |                  — |           — |

Paired against A: **B 4W/9L (p=0.267), C 3W/1L (p=0.625)**. Neither structural
expansion beats simply extending the vector list; the differences are one or two
questions out of 282.

Where the missing evidence actually is (label level; 483 labels absent from the
page):

| Missing at the page                    |         Count | What would have to change |
| -------------------------------------- | ------------: | ------------------------- |
| absent from the base pool entirely     |     204 (42%) | the candidate generator   |
| present in the base pool, not selected | **279 (58%)** | selection                 |

Coverage varies widely by conversation (A: 15.0%–45.2%), and the C−A difference is
not concentrated: C gains most on conv-26 (+3.1pp) and conv-42 (+2.7pp), loses on
conv-41 (−3.3pp). With 282 questions inside ten conversations those are
single-digit question counts, which is why the paired tests are uninformative.

Reading: the page does not mostly fail because the pool lacks evidence — 58% of
the misses are already in the pool — but neither expansion tried here converts
that into coverage any better than a larger vector list does. The relation arm
(D) is the one hypothesis this round did **not** test, because the edges do not
exist in the stores yet.

### Superseding verdicts

| Component                       | Narrowed verdict                                                                                                                                                       | Evidence           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Structure as candidate entry    | session-level reachability is complete, so an entry channel has almost nothing to add **at session granularity**; at record granularity this was not measured directly | R1, §5             |
| Structure as in-page ranker     | one blending rule (vector + centroid cosine) is worse than no blend; other rules untested                                                                              | R3                 |
| Structure as supplement picker  | no better than extending the vector list at equal budget (§5); the earlier +2.5pp came from a different pairing and is not repeated here                               | §5                 |
| Adjacency expansion             | finds fewer new labels (13) than a plain vector extension (34)                                                                                                         | §5                 |
| Relation expansion              | **untested** — requires materialising `node_relations` first                                                                                                           | §5                 |
| SPANN routing                   | valid as a cost/recall trade at fixed store size; boundary replication is what makes it usable                                                                         | §5 of the original |
| Graph over the structural layer | this variant loses to flat centroid scanning at every budget; the scale regime where it would pay is unmeasured                                                        | R2                 |
| Deep hierarchy                  | **open question**, not a conclusion                                                                                                                                    | R2                 |

## 6. Complementary selection at a fixed text budget

Fixing the _record count_ leaves text cost uncontrolled, so this round fixes the
**character budget** instead: every arm may spend exactly the text that the
similarity page spends on its own 20 records (mean 2,612 characters). Pool is the
BGE top-100; MMR's λ is fixed at 0.3 before the run.

| Arm    | Selection rule                              |   full % | recall % | records | sessions | vs S       |          p |
| ------ | ------------------------------------------- | -------: | -------: | ------: | -------: | ---------- | ---------: |
| S      | similarity greedy (today)                   | **24.1** |     45.2 |    20.0 |     11.8 | —          |          — |
| M      | maximal marginal relevance, λ=0.3           |     23.8 |     45.1 |    20.7 |     12.2 | 1W/2L      |      1.000 |
| W      | prefer sessions not yet in the page         |     16.7 |     37.8 |    20.9 | **18.9** | **5W/26L** | **<0.001** |
| K      | prefer 16-record blocks not yet in the page |     15.2 |     37.2 |    21.3 |     16.7 | **1W/26L** | **<0.001** |
| M\@0.5 | MMR at double weight (exploratory)          |     22.7 |     44.5 |    21.4 |     12.8 | 2W/6L      |      0.289 |

The mechanism fires and the outcome is worse: W raises the number of distinct
sessions in the page from 11.8 to 18.9 — it really does stop circling one region —
and full coverage falls from 24.1% to 16.7%. Recall falls too (45.2% → 37.8%), so
this is not a diversity-for-coverage trade; spreading across sessions simply
replaces relevant records with irrelevant ones.

Two consequences:

1. **Cross-region navigation is counter-productive at the page level.** The gold
   turns of a multi-hop question sit across ~2.7 sessions, but the page already
   touches 11.8 sessions on average, so the constraint was never "which region"
   — it was "which records inside the regions already touched". Diversifying over
   regions spends budget away from where the evidence is.
2. **Semantic novelty does not help either.** MMR is neutral at λ=0.3 and slightly
   negative at λ=0.5: the direction is monotone toward "less diversity is better".

This closes the selection-signal family that can be built from similarity geometry
and structure membership alone. What is left untested is a relevance signal that
knows _why_ a record answers the question (a cross-encoder, or a rule-based facet
matcher over question entities and time expressions), which is outside the
zero-LLM constraint of this round.

## 7. Arms A/B/C: representation beats reranking, bridge search beats the pool but not the page

Three arms, same questions, same 5/5 conversation split (weights fitted on
conv-26/30/41/42/43, reported on conv-44/47/48/49/50). "Confirm" means the five
conversations the weights were **not** fitted on.

| Arm                   |                                                                         Candidate pool | recall@20 (confirm) | full % (confirm) | pool recall % | recall@20 (all) | paired vs A        |
| --------------------- | -------------------------------------------------------------------------------------: | ------------------: | ---------------: | ------------: | --------------: | ------------------ |
| A raw text            |                                                  top-100 by cosine over `${statement}` |                42.4 |             21.4 |          75.8 |            44.2 | —                  |
| **B contextual text** |               top-100 by cosine over `[date \| session] speaker: text + previous turn` |            **50.5** |         **24.3** |          78.6 |        **51.5** | 9W/5L/126T, p=0.42 |
| C second hop          | union(raw top-100, top-100 of a query extended with 4 bridge terms from the first hop) |                45.8 |             22.9 |      **88.4** |            46.7 | 5W/3L/132T, p=0.73 |

Baseline for the go/no-go is the un-reranked cosine page: **45.2% recall@20**.

1. **B clears the bar on held-out conversations** (50.5% against 45.2%), and its
   tuning-half number (52.7%) is consistent with the confirmation half, so this is
   not tuning optimism. The mechanism is the one the review predicted: the
   production representation (`${canonicalName}: ${statement}`, search-ranking.ts)
   carries no speaker, date or neighbouring turn, and adding them makes records
   retrievable that were previously unattributable.
2. **B's gain is spread across labels, not across questions.** Paired on full
   coverage it is 9 wins against 5 losses (p=0.42): the extra recall comes from
   questions that gain a label without flipping to full coverage.
3. **C proves the discovery half and fails the conversion half.** The bridge-extended
   query lifts pool recall from 75.8% to 88.4% — it really does reach records the
   raw top-100 never contains — but only 45.8% of that reaches the page. The
   zero-LLM bridge feature cannot tell which of those new records answers part of
   the question, which is exactly the reranker the review asked for and which a
   lexical feature does not provide.
4. **Arm A is not a lever**: on the confirmation half the tuned reranker scores
   _below_ plain cosine (42.4 against 44.5), i.e. its weights add noise of the same
   size as any gain.

What this implies for the route: representation (B) is worth productising; the
bridge (C) needs a real reranker before its discovery converts; adding surface
features to a similarity score (A) is exhausted.

## 8. Controls: the gain is the date, the reranker is noise, the bridge loses at equal size

All numbers below are on the **confirmation conversations** (conv-44/47/48/49/50),
ranked by plain cosine unless stated, page = top-20. No weights are fitted in this
section, so nothing here is an optimised number. The comparison baseline is the
raw representation on the same set: **recall@20 44.5%, full coverage 22.1%**.

### The gain is the date, not "context"

| Representation                                  | recall@20 |   full % |
| ----------------------------------------------- | --------: | -------: |
| raw `${statement}`                              |      44.5 |     22.1 |
| B full context (date + speaker + previous turn) |      48.4 |     23.6 |
| **date only**                                   |  **48.4** | **25.0** |
| previous turn only                              |      45.4 |     21.4 |
| date + previous turn                            |      48.6 |     23.6 |

Date alone reproduces the entire recall gain (+3.9pp) and gives the best full
coverage; the previous turn adds nothing measurable and costs coverage on its own.
The stored statement already begins with `Speaker:`, so there was no separate
speaker variant to ablate. **The mechanism is the session timestamp, not "context"
in general** — which also makes the change far cheaper: one field, not a dialogue
window.

### The hand-weighted reranker is noise in both directions

Arm B scored 50.5% earlier _with_ arm A's reranker attached, and 48.4% here with
plain cosine. Arm A lost 2.1pp with the same reranker while B gained 2.1pp. The
reranker therefore moves results by about ±2pp either way: it is not a lever, and
"B plus reranker" (50.5%) should not be read as better than "date alone" (48.4%)
until a reranker that reads instruction and record exists.

### The bridge query loses to simply taking more candidates

| Pool                           | pool recall % | page recall % | full % | mean pool size |
| ------------------------------ | ------------: | ------------: | -----: | -------------: |
| raw top-100                    |          75.8 |          44.5 |   22.1 |            100 |
| **raw top-200**                |      **89.9** |          44.5 |   22.1 |            200 |
| bridge top-100 alone           |          56.1 |          42.0 |   18.6 |            100 |
| union C (raw-100 ∪ bridge-100) |          83.3 |          44.5 |   22.1 |            168 |

At a comparable candidate count the bridge pool is **worse** than the raw top-200
(83.3% against 89.9%), so C's earlier pool advantage was pool size, not the bridge
query — the review's suspicion is confirmed. The bridge query alone is a poor
retriever (56.1%).

The same table settles a question left open in §5: doubling the pool from 100 to
200 lifts pool recall by **14.1pp** and moves the page by **0.0pp**. The page is
selection-bound; no amount of extra candidates improves it without a better way to
choose.

## 9. The full corpus changes the attribution: the previous turn matters, and by category

Every measurement before this section ran on **multi-hop questions only** (282 of
1,977 answerable ones). Re-running the representation ablation over all categories
by category reverses one attribution made in section 8.

Question vectors for the other categories did not exist when the earlier probes
ran, so they silently produced no rows; `embed-bge-queries.py` now encodes the
whole question set (1,974 questions; categories 1=282, 2=319, 3=89, 4=841, 5=446).

| Category      |   n | raw  | date only | date, no session index | previous turn | date + previous |
| ------------- | --: | ---- | --------- | ---------------------- | ------------- | --------------- |
| 1 multi-hop   | 282 | 45.2 | 48.8      | 47.7                   | 45.2          | 49.0            |
| 2 temporal    | 319 | 74.3 | 74.8      | 73.7                   | 72.4          | 72.9            |
| 3 open-domain |  89 | 32.0 | 34.0      | 32.5                   | 34.5          | 34.5            |
| 4 single-hop  | 841 | 72.5 | 76.3      | 74.1                   | **77.8**      | **80.3**        |
| 5 adversarial | 446 | 56.7 | 56.3      | 55.4                   | **78.0**      | 76.7            |

Weighted over all 1,977 questions (recall@20): raw **63.5%**, date only 65.7%
(+2.2), date without session index 64.2 (+0.7), previous turn 70.4 (+6.9),
date + previous turn **72.1 (+8.6)**.

**Section 8's attribution is withdrawn.** "The mechanism is the date, the previous
turn adds nothing" holds only for multi-hop. On single-hop the previous turn is
worth +5.3pp and the full bundle +7.8pp; on adversarial questions the previous turn
alone is worth **+21.3pp**, the largest single effect measured anywhere in this
record, while the date contributes nothing there. The mechanism is context, and
_which_ part of the context carries the information depends on the question type:
multi-hop needs the timestamp to locate the other hop's time window, single-hop and
adversarial need the adjacent turn to resolve who and what the record is about.

Two consequences:

1. **A representation change must add both, not just the date.** The product
   recommendation from section 8 (+2.2pp weighted) understates the available
   effect by roughly 4x against the +8.6pp of the full bundle.
2. **Every earlier experiment in this record is multi-hop-only**, and the numbers
   above show that category membership changes conclusions materially. Sections 1
   through 8 therefore describe the multi-hop regime, not the corpus.

### 9.1 Denominator reconciliation (63.5% vs 58.7%, 1,974 vs 1,977)

The record quotes three different question counts and two different recall figures.
All of them are correct; they are different denominators and different
aggregations, and quoting one against the other would overstate the effect.

| Count                                                      |     Value | What it is                                         |
| ---------------------------------------------------------- | --------: | -------------------------------------------------- |
| qa items in the dataset                                    |     1,986 | every question object                              |
| distinct (conversation, question)                          |     1,974 | 12 questions repeat verbatim inside a conversation |
| questions whose evidence labels resolve to a stored record | **1,977** | the denominator every probe actually uses          |

Aggregations, computed in one pass over the same 1,977 questions (`reconcile` run):

| Representation       | label-level micro recall@20 | question-weighted mean of per-category recall | per-question full coverage |
| -------------------- | --------------------------: | --------------------------------------------: | -------------------------: |
| raw statement        |                        58.7 |                                          63.5 |                       60.0 |
| date + previous turn |                    **65.8** |                                      **71.8** |                   **68.1** |
| change               |                  **+7.1pp** |                                    **+8.3pp** |                 **+8.1pp** |

- The ladder in section 10 (58.7% at k=20) is the **label-level micro** average:
  total labels found over total labels. Multi-hop questions carry 3.12 labels each
  and single-hop 1.06, so label-weighted averaging is pulled down by the category
  with both the most labels and the lowest recall.
- Section 9's 63.5% is the **question-weighted mean of the five per-category
  label-recalls**. It weights a multi-hop question the same as a single-hop one.
- Neither is wrong; they answer different questions. Quoted correctly, the gain is
  **+8.3pp on section 9's aggregation, +7.1pp on the micro aggregation, +8.1pp on
  per-question full coverage** — the effect is robust to the choice, but the
  magnitude is not identical, and "+8.6pp" should be retired in favour of these
  three numbers.
- A 0.3pp drift exists between this table (71.8) and section 9's headline (72.1) for
  the same representation; it comes from recomputation in a separate pass. The
  numbers above are preferred because raw and contextualised are computed by one
  identical code path in one run.

## 10. The three structural experiments, re-run on the whole corpus

Every structural result in sections 1–8 came from multi-hop questions. The three
experiments that could plausibly change with the category mix were re-run over all
1,977 answerable questions, per category, with the same probes and no tuning.

### 10.1 Entry reachability survives

| Category      |    n | session blind @20 | session full @20 | session blind @100 | block blind @20 | block blind @100 |
| ------------- | ---: | ----------------: | ---------------: | -----------------: | --------------: | ---------------: |
| 1 multi-hop   |  282 |              4.3% |            59.6% |               0.0% |            5.7% |             0.0% |
| 2 temporal    |  319 |              4.4% |            94.0% |               0.0% |            6.0% |             0.3% |
| 3 open-domain |   89 |              9.0% |            67.4% |               0.0% |           18.0% |             2.2% |
| 4 single-hop  |  841 |              4.9% |            95.1% |               0.1% |            6.8% |             0.2% |
| 5 adversarial |  446 |              6.3% |            93.7% |               0.0% |            7.4% |             0.0% |
| all           | 1977 |              5.2% |            88.3% |               0.1% |            7.1% |             0.3% |

The conclusion holds across the corpus: at a 100-candidate pool the sessions and
blocks holding the gold turns are essentially always touched, so a structural
_entry_ cannot be the missing lever anywhere. The open-domain category has the
only visible gap (18% of questions have no touched block in the page), and it is
the smallest category.

The page itself is much stronger on the full corpus than on multi-hop: 60.0% full
coverage at twenty records, against 24.1% for multi-hop. The ladder still shows the
same shape — 58.7% recall at 20 against 82.8% at 100 — so the binding constraint is
still selection, just with less room than multi-hop suggested.

### 10.2 Adjacency expansion is not useless: it is category-dependent (withdrawn claim)

Same page (top-20 by cosine), same supplement budget of five records, only the
source of the five differs. Full coverage of page ∪ supplement:

| Category      | A: more vector candidates | B: adjacent turns | C: more from touched sessions |
| ------------- | ------------------------: | ----------------: | ----------------------------: |
| 1 multi-hop   |                      28.0 |              26.2 |                          28.7 |
| 2 temporal    |                      75.2 |              76.2 |                          76.2 |
| 3 open-domain |                      36.0 |              36.0 |                          37.1 |
| 4 single-hop  |                      75.1 |          **77.1** |                          75.9 |
| 5 adversarial |                      59.2 |          **73.5** |                          60.1 |

Section 5's "adjacency finds fewer labels than simply extending the vector list" is
**withdrawn as a general statement**. On adversarial questions adjacency is worth
**+14.3pp** over more vector candidates, and on single-hop +2.0pp; it is only on
multi-hop that it loses (−1.8pp). This matches section 9: the categories where the
previous turn improves the representation are the same ones where adjacent-turn
expansion improves the supplement.

### 10.3 Structural diversity stays harmful in every category

Fixed character budget, page only, no supplement:

| Category      | S: similarity | M: MMR λ=0.3 | W: new session | K: new block |
| ------------- | ------------: | -----------: | -------------: | -----------: |
| 1 multi-hop   |          24.1 |         23.8 |           16.7 |         15.2 |
| 2 temporal    |          72.4 |         72.4 |           64.6 |         63.9 |
| 3 open-domain |          33.7 |         33.7 |           25.8 |         24.7 |
| 4 single-hop  |          72.1 |     **72.7** |           57.3 |         56.5 |
| 5 adversarial |          56.5 |     **57.2** |           41.3 |         39.7 |

This one survives, and is now stronger evidence than before: preferring unseen
sessions or blocks costs **7–17pp in every category**, and semantic novelty (MMR)
is neutral in five of five. Diversifying by structure is not a multi-hop artefact;
it is uniformly counter-productive.

### 10.4 What the full corpus says the lever is

Sections 9 and 10.2 point at the same missing information from two directions. On
single-hop and adversarial questions, adding the **previous turn** to the record's
representation is worth +5.3 and +21.3pp of recall, and adding **adjacent-turn
records** to the supplement is worth +2.0 and +14.3pp of full coverage. Two
different uses of one thing: the turn is what makes the record attributable and
what completes the evidence.

The cheapest of the two is the representation change, because it costs one extra
field per record rather than a retrieval channel, and it is applied once at write
time instead of on every query.
