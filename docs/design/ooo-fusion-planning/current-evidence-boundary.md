# What the ceiling says today

[中文](current-evidence-boundary.zh-CN.md) · [Terms used](current-evidence-boundary.terms.yaml)

**Authority:** [Parent scope](../ooo-fusion-planning.md).

## What the ceiling says today

Run against the fixtures and against the D arm's own spec
(`node --experimental-strip-types evals/ooo-execution/fusion-ceiling.ts [--spec <path>]`):

| plan | units | floor | cap 1 | cap 2 | cap 3 | cap 4 |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures/report/fine.spec.json` | 4 | 1 | 4 sessions | 2 (3.8 s) | 2 (3.8 s) | 1 (5.7 s) |
| `fixtures/pipeline/fine.spec.json` | 4 | 1 | 4 sessions | 2 (3.8 s) | 2 (3.8 s) | 1 (5.7 s) |
| the D arm's `spec-2.json` | 2 | 1 | 2 sessions | 1 (**1.9 s**) | | |

The third row is an arithmetic check, not an independent prediction: the ceiling uses a 1 900 ms
per-session assumption from the D arm's own runs. That arm's 1 900 ms median gap is smaller than its
2 228 ms within-cell spread, so the row shows that the tool applies its input to the arm's plan, not that
the assumption is a reliable startup constant. The fine-plan comparison below is a separate observation:
the same tool predicts 3 800 ms saved at cap 2, while the archived medians differ by 8 451 ms. This
mismatch shows that the flat assumption does not explain this sample; the missing instrument commit and
changed third-rep prompt do not identify a general plan-dependent model. The table also shows that the
structural floor is 1 for both multi-unit fixtures and that cap 3 buys nothing over cap 2 on these
shapes, because the fourth unit has to wait for the first three. These are properties of these shapes,
not evidence that a plan is generally fully fusible or that a particular bound is a product default.

### The cap experiment, measured (2026-09-19)

The ceiling's prediction for a four-unit plan was tested on `fixtures/pipeline/fine.spec.json` - three
independent units and one that joins them, the shape of the report fixture - live, `--slots 1`, with
the spec's canned answers stripped so the units really run. Cache accounting is recorded beside tokens
because a token count is not a cost on its own.

| bound | sessions | rep | wall | tokens | cache read / tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 1 | 26 186 ms | 45 482 | 0.847 |
| 1 | 4 | 2 | 27 053 ms | 45 887 | 0.806 |
| 1 | 4 | 3 | 25 270 ms | 33 941 | 0.607 |
| 2 | 2 | 1 | 17 735 ms | 41 806 | 0.802 |
| 2 | 2 | 2 | 17 998 ms | 37 693 | 0.798 |
| 2 | 2 | 3 | 17 427 ms | 35 444 | 0.690 |
| 4 | 1 | 1 | 16 480 ms | 54 834 | 0.836 |
| 4 | 1 | 2 | 16 810 ms | 55 738 | 0.834 |

One row per run, so no column has to be read positionally against another; the medians and the saving are
recomputed from the stored reports into the archive's `aggregate-3rep.json`. Bounds 1 and 2 carry a third
rep because the two-rep reading of this table was quoted as a policy, and the third rep is read as a later
observation of the same spec rather than as a third point of the same instrument version - the fused
cell's third run used a chain prompt that changed earlier the same day, and the reports record the spec,
the worker and the envelope but not the instrument's commit. Three things, and the second replaces this
document's earlier readings:

- **The recorded cap samples have lower wall time at larger bounds, but do not calibrate a general
  startup term.** Cap 1 to cap 2 differs by 8 451 ms and cap 1 to cap 4 by 9 541 ms on the archived
  medians, against 3 800 ms and 5 700 ms projected from the D arm's 1 900 ms assumption. The cap 1 and
  cap 2 within-cell spreads are 1 783 ms and 571 ms. The first two runs already have non-overlapping
  ranges; the third runs use a newer prompt and expand both cell ranges, but do not reverse the observed
  direction. Because the cap reports omit instrument commits, this remains bounded evidence about these
  samples, not a per-session price or a general claim that startup is plan-dependent. The ceiling's
  primary output is _sessions avoided_; a millisecond estimate must name its assumption.
- **The token count settles nothing at three reps.** A two-rep reading had every arm spending 80-84 % of
  its tokens on **cache reads** and the remainder nearly flat. The third rep puts that share at 0.607 in one
  cell (0.847 in another run of the same cell), and per-cell token spreads - 11 946 in cap 1 - are wider
  than the median gaps they would be compared across. So no token-direction claim is supported by these
  runs: the 1.3-1.9x that an unpaired token median once suggested is not replaced by a better number, it is
  unresolved, and the measurement phase is closed with it that way: resolving it needs either many more
  reps or the prices recorded apart, and the second is cheaper than the first - so the reports now record
  them: `inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite` and the provider's own `cost`, per unit,
  with the A, B and C cells the first runs to carry them (their totals decompose exactly, and the
  provider's price comes with them). The cap cells in the table above predate that and cannot be repriced,
  and no further fused run was bought to reprice them: one rep of the shape that failed at three would not
  settle it. So the cost of fusing stays **unpriced**, and this document says measured where it is measured
  and unpriced where it is unpriced. The ratio column beside them is **not** a price either:
  `tokens` counts input and output together, so subtracting cache reads leaves the tokens not served from
  cache - uncached input plus every output token - and the reports do not say whether the cache figure nests
  inside the total at all.
- **Cap 2 is the knee in these recorded medians, not a policy.** It takes 8 451 ms of the 9 541 ms
  observed cap-1-to-cap-4 difference while recording the fewest tokens of the three (median 37 693); cap 4
  differs by another 1 090 ms. The third prompt changed and the instrument commit is not recorded, so the
  medians remain bounded observations. Three runs per cell do not fix a policy, and fewer sessions is not
  the same quantity as a shorter parent task: with more than one slot, fusing units into fewer sessions
  removes parallelism the plan could have used. Two units per session is therefore a hypothesis for the
  A-D comparison on one parent task to settle, not a strategy this document declares.

**A spread wider than a difference is not the same as no difference.** The D arm's two-rep spreads
(about 2.2 s in both arms) exceed its 1.9 s median gap, so _that sample_ cannot resolve the effect; this
does not show that fusion never saves wall clock. In the fine-plan cap samples, the first two ranges do
not overlap (26.186-27.053 s against 17.735-17.998 s), and the third runs preserve that direction
(25.270 s and 17.427 s). They also expand both cells' ranges, use a newer prompt, and lack instrument
commits. The observed difference therefore predates the third run but remains a bounded sample result,
not a general causal estimate.
