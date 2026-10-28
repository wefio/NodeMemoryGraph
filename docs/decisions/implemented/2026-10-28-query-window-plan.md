# A long query is searched by its own clause and planned windows

[简体中文](2026-10-28-query-window-plan.zh-CN.md) · [Terms](2026-10-28-query-window-plan.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Payload caps are sized to the platform body, so a search may legitimately carry a
query far longer than an embedding model's token window: an entry can be up to
1,000,000 characters and the model sees 512 tokens. Long queries were therefore
split, and the split decided two things at once — which parts of the query reach
the model, and how many embedding calls a search spends.

The shipped split (`splitQueryChunks`) tiled windows forward from the start with
boundary-snapped cuts, then appended one window anchored at the end. For a
36,833-character query that is eight windows covering `[0, 14000)` and
`[34833, 36833)`: the opening is dense and the middle is a single contiguous blind
block of about 20,800 characters. The first feature was also the raw clause, up to
1,000,000 characters, which the provider truncates on its own — a head-only
embedding paid for at megabyte request sizes.

The measured consequence, on 281 LoCoMo multi-hop questions, was that a question
placed in the middle of the text scored **what it scored with no splitting at
all**: 2.14% full-page coverage, the same number as searching one unsplit string,
and worse than the 5.34% obtained when the question sat at the end. The extra
windows were not covering the middle, and at 36,000 characters the shipped layout
did not beat the no-split baseline on that condition at all (0W/0L).

## Decision

Plan the windows geometrically and spend a counted feature budget on them.

`planQueryWindows` (in `onlion/backend/query-chunks.mjs`) chooses one of two
layouts from `n = min(ceil(L / W), MAX_QUERY_WINDOWS)` where `W =
QUERY_CHUNK_CHARS`:

- `L <= n*W` — the budget covers the text: cut it into `n` equal, contiguous,
  disjoint segments that share one boundary-snapped cut point per seam, so nothing
  is dropped and nothing is embedded twice.
- `L > n*W` — budget-bound: `n` windows of `W`, the first at the start and the
  last anchored at the end, with the uncovered text spread evenly between them.

`selectQueryFeatures` then builds each clause's feature list as the **clause itself
first**, followed by the end-anchored tail and the interior windows. The planned
first window is **dropped**: it re-covers the opening, which the clause feature
already covers with a longer, token-based window.

The feature budget is counted, not timed. `MAX_QUERY_FEATURES = 24` is shared
across clauses round-robin, so every clause gets both ends before any clause gets
a third window and a request fills the budget instead of stopping at a fixed
count. `MAX_QUERY_WINDOWS = 10` is a per-clause ceiling, reported as
`limits.max_query_chunks`. No environment override is exposed: two ways to change
the same bound is one way too many, and the measured configuration ships as a
constant. The previous extra-call budget (`NMG_QUERY_INTERIOR_BUDGET`) is removed
for the same reason.

`src`-side embedding clients are unaffected: the whole query is never a single
input any more, so the truncation the provider used to perform silently no longer
decides what is searchable.

## Measured result

Zero LLM cost: gold-evidence recall on the 281 LoCoMo multi-hop questions of
`evals/locomo/results/locomo-eligible-manifest.json`, page 20, fresh local BGE
(`BAAI/bge-small-en-v1.5`), the same record vectors as the product path. Full page
coverage (`all%`) of the four long-form conditions, plus the `short` control which
must be identical across arms because a short query is one feature everywhere.

Arms: **E** = shipped (clause + forward tiling + one end-anchored window), **F** =
planned windows only, **G** = clause + all planned windows, **H** = clause +
planned windows minus the first window.

6,000 characters:

| arm              | long      | mixed | tail | mid  | total     |
| ---------------- | --------- | ----- | ---- | ---- | --------- |
| E                | **11.74** | 7.83  | 7.12 | 3.91 | 30.60     |
| F (adaptive n=3) | 9.61      | 7.83  | 5.69 | 5.34 | 28.47     |
| G (n=10)         | 11.74     | 7.83  | 7.47 | 5.69 | 32.73     |
| H (n=10)         | 11.74     | 7.83  | 7.47 | 5.69 | **32.73** |

36,000 characters:

| arm              | long      | mixed | tail | mid  | total     |
| ---------------- | --------- | ----- | ---- | ---- | --------- |
| E                | **11.74** | 7.83  | 5.34 | 1.78 | 26.69     |
| F (adaptive n=8) | 11.39     | 7.83  | 6.05 | 4.63 | 29.90     |
| G (n=10)         | 11.03     | 7.83  | 6.05 | 4.63 | 29.54     |
| H (n=10)         | 11.39     | 7.83  | 6.05 | 4.63 | **29.90** |

Paired significance is computed on the per-question all-or-nothing indicator:

- **H > E, mid, 36,000 characters: 8W/0L, p=0.0078.** E's `mid` is not merely
  weaker than H's, it equals the no-split baseline (1.78 against 2.14), so the
  windows E spends there move the reference answer _out_ of the page.
- **H > E, mid, 6,000 characters: 6W/1L** (not significant at this length).
- **H vs G: no difference on any condition at either length** (0W/0L everywhere
  except 36,000 `long`, where H is 1W/0L ahead). Dropping the redundant opening
  window costs nothing and saves one embedding call per clause.
- **E vs H, `long`:** within noise at 36,000 (0W/2L, p=0.5) and identical at 6,000,
  because both keep the clause itself as a feature.
- `short` is identical across all arms, as the control requires.

Live verification after deploying `dpedvhr1ryme` to `nmg-memory-api-overseas`
(`ap-hongkong`): `limits.max_query_chunks = 10`, `max_query_features = 24`,
`npm run smoke:edgeone` 9/9, and a 36,000-character query with the question at the
head, the middle and the tail each returned the planted record at `top_k=100`
(3.1 s, 4.3 s, 2.8 s).

## What this does and does not establish

- The padding in this probe is **filler text**, so the middle is uninformative by
  construction. What was measured is that a layout without a middle window cannot
  find a question placed there; it is not a measurement of how often real long
  queries carry information in the middle. Real transcripts make that more likely,
  which would favour the planned layout further — that is reasoning, not a number.
- Only retrieval is measured: gold-evidence recall at a 20-record page. No answer
  or judge model was involved, and no end-to-end score was produced for this
  change. The change is therefore not additive with any earlier benchmark result.
- `W = 2000` **characters** is calibrated for English (≈512 tokens for this model).
  For CJK text 512 tokens is roughly 500 characters, so a window may still exceed
  the model's token window; the layout is not wrong but `W` is not language-neutral.
- The stores, questions and vectors are fixed, so the numbers are comparable across
  arms but not to a different corpus, page size or embedding model.

## Alternatives considered

- **Keep the shipped forward tiling** — rejected: it leaves one contiguous blind
  block, and on the middle condition it matched the no-split baseline.
- **Planned windows only, without the clause feature (F)** — rejected: it loses
  head-aligned recall (6,000 characters: 9.61 vs 11.74, 7 losses) because the
  model's own token window gives the opening more context than a character window.
- **Keep the clause feature and all planned windows (G)** — rejected as H's
  superset with no gain: identical on every condition, one extra embedding call.
- **A wall-clock budget** ("stop splitting when time runs out") — rejected: the
  same query would resolve different windows on a fast and a slow machine, which
  makes every recorded retrieval number unreproducible.
- **Volume pooling of windows** — not revisited here; mean pooling was already
  measured as losing to per-feature maximum when a query's parts point in
  different directions. Nothing in the product pools windows, so the helper was
  removed from the service module and lives on only in the probe that measured it.

## Rejected alongside this change: additive delta writes for `Add`

The same investigation asked whether an Add could upload only its changed pages
instead of the whole partition snapshot, using the existing `makePageDelta`
machinery. Measured with the built worker and realistic 384-dimension vectors on
a ~3 MB partition: an 8-message Add changes **72–86 pages of 8 KiB** (576–688 KB),
20-message 80–121 pages, 30-message 94–102 pages, against a `PART_DELTA_LIMIT` of
256 KiB (32 pages). **0 of 13 measured Adds fit.** The overlay lives inline in the
manifest, so raising the limit would grow the object that every concurrent writer
competes for, and `USER_DELTA_LIMIT` is 1 MiB — about one Add. The change was
dropped rather than tuned.

## Consequences

- A long clause costs at most **10** embedding calls (the clause plus nine
  windows); before this change the same clause cost one unbounded input plus up to
  eight windows. Feature count is bounded by `MAX_QUERY_FEATURES` for every request,
  so the ceiling does not depend on how many clauses the caller sends.
- Retrieval is deterministic: the same query text resolves the same windows
  regardless of machine speed or load, which keeps recorded benchmarks comparable.
- The product keeps three constants (`QUERY_CHUNK_CHARS`, `MAX_QUERY_WINDOWS`,
  `MAX_QUERY_FEATURES`) and two functions (`planQueryWindows`,
  `selectQueryFeatures`). `NMG_QUERY_INTERIOR_BUDGET` never shipped, no override
  was added, and the pooling helper left the service module.
- The probe keeps every arm that produced this record, the previous layout
  included, and imports the product function only for the arms that are meant to
  track the product. Importing it for the baseline would make the baseline move
  with the product.
