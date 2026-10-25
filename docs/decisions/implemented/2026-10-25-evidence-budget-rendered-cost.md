# Budget accounting charges the rendered evidence surface

[简体中文](2026-10-25-evidence-budget-rendered-cost.zh-CN.md) · [Terms](2026-10-25-evidence-budget-rendered-cost.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

`estimateResultTokens` in `src/core/store/active-graph.ts` decided how many
records a search page could hold by summing four fields per candidate: the
statement, the node canonical name, the node summary, and the full evidence
content. Only two of those reach the reader. `renderEvidenceSurface` prints the
statement in full, a one-line details row, and at most `SOURCE_EXCERPT_CHARS`
(320) characters of the evidence as a `SOURCE=` excerpt. It never prints the node
summary at all.

Measured on the LongMemEval run `lme/nmg-longmemeval_20261025T095539Z` (500 users,
one store per user), two charges had no rendered counterpart:

- The node summary is node-level metadata shared by every record of that node —
  10.59 records per node in this corpus — so charging it per record multiplied a
  shared 1,483-character string by the node's record count.
- Evidence content averaged 1,037 characters and was charged in full against a
  320-character rendering.

Per record the estimator charged 898 tokens against 377 rendered, a factor of
2.38, so the 6,000-token envelope the launcher configures (`topK × 300`) admitted
6.68 records. The delivered pages averaged 6.894 records, ranged 1–12, and never
reached the requested 20; 143 of 500 questions would have needed the full page
and none received it.

The visible symptom was a search page that looked like a ranked page but behaved
like a truncated one: the budget was not exhausted by relevant evidence, it was
exhausted by text the reader never saw.

## Decision

Make the estimator charge the rendered surface and nothing else.

`estimateResultTokens` now charges the statement in full, a details-line allowance
built from the fields that line prints (`memory`, `node`, `type`, `truth`,
`scope`, `time`) plus a fixed separator allowance, and `min(evidence.length,
SOURCE_EXCERPT_CHARS)` only when the evidence differs from the statement. Node
summary is not charged: it is never rendered, and it is shared across the node's
records.

`SOURCE_EXCERPT_CHARS` is now exported from `src/integration/agent-surface.ts`
and used by both the renderer and the estimator, so the two cannot drift apart
silently. `tests/core/active-graph-budget.test.ts` pins the three properties that
were violated: a 50,000-character node summary must not change the estimate, a
50,000-character evidence must cost the same as its 320-character excerpt, and a
6,000-token budget must admit at least 15 rendered-sized records.

## Measured result

Same stores, same 500 questions, only the estimator changed. The search step was
re-executed from empty per-user checkpoints, so the pages are real retrievals and
not a replay of earlier ones.

| Page property                    | Before |  After |
| -------------------------------- | -----: | -----: |
| Mean records per page            |  6.894 | 17.316 |
| Median                           |      7 |     18 |
| Maximum                          |     12 |     20 |
| Questions reaching 20 records    |      0 |    143 |
| Mean rendered context characters |  8,143 | 23,107 |

Answer stage, identical reader and judge (`deepseek-v4-flash`, `temperature 0`,
answer budget 300 output tokens, judge budget 1,000, provider reasoning disabled):

| Metric       | Before |      After |
| ------------ | -----: | ---------: |
| LLM-as-Judge | 0.6480 | **0.7680** |
| F1           | 0.1500 |     0.1517 |
| ROUGE-L      | 0.1147 |     0.1115 |
| METEOR       | 0.2071 |     0.2109 |

By category (LLM-as-Judge):

| Category                  | Before |  After | Questions |
| ------------------------- | -----: | -----: | --------: |
| multi-session             | 0.3609 | 0.5714 |       133 |
| temporal-reasoning        | 0.5865 | 0.7218 |       133 |
| single-session-user       | 0.9429 | 0.9714 |        70 |
| single-session-assistant  | 0.8571 | 0.9643 |        56 |
| single-session-preference | 0.6333 | 0.8000 |        30 |

The judge change is +0.1200 over 500 questions, i.e. 60 questions judged correct
that were not before. Pipeline status for the comparison run: search 500 success,
answer 500 success, eval 500 success, zero failed users, zero skipped records,
zero empty answers, so the difference is not produced by skipping.

## Paired re-run on the other three suites

BEAM, HaluMem and PersonaMem v2 were re-run against the same stores, re-executing
search onward and keeping every earlier artifact in `.baseline-v1/` as the paired
baseline. Reader, judge and budgets were identical to the LME comparison.

| Suite            | Metric       | Baseline |  After |   Change |
| ---------------- | ------------ | -------: | -----: | -------: |
| LongMemEval      | LLM-as-Judge |   0.6480 | 0.7680 | +12.00pp |
| BEAM (100k)      | Nugget Score |   0.4816 | 0.5189 |  +3.73pp |
| HaluMem (medium) | QA Accuracy  |   0.8151 | 0.8509 |  +3.58pp |
| PersonaMem v2    | Precision    |   0.3622 | 0.3932 |  +3.10pp |

Delivered pages and their cost:

| Suite         |   Mean records |  Median |     Max | Mean rendered chars |   Prompt tokens |
| ------------- | -------------: | ------: | ------: | ------------------: | --------------: |
| LongMemEval   | 6.894 → 17.316 |  7 → 18 | 12 → 20 |      8,143 → 23,107 |           4.27M |
| BEAM          |    4.15 → 9.64 |   4 → 9 |  8 → 20 |      9,502 → 23,684 |   1.98M → 4.33M |
| HaluMem       |  11.03 → 19.95 | 11 → 20 | 14 → 20 |      5,816 → 10,914 | 15.79M → 27.70M |
| PersonaMem v2 |   7.25 → 18.90 |  7 → 20 | 13 → 20 |      7,735 → 20,668 | 12.15M → 39.91M |

Prompt tokens grew 1.75x–3.28x, so the accuracy gains are bought with input
cost; the two smallest page expansions (BEAM 2.3x records, HaluMem 1.8x) also
produced the two smallest gains. All four suites finished with zero failed units
and zero skipped records, so no score depends on skipped work.

## Two category results that argue against "more evidence is strictly better"

BEAM's `event_ordering` was the dimension expected to benefit most, because it
asks for the order in which utterances were mentioned and a fuller page should
contain more of them. It barely moved: 0.1215 → 0.1423 (+2.1pp), while
`temporal_reasoning` (+10.0pp), `information_extraction` (+6.9pp),
`preference_following` (+6.9pp) and `instruction_following` (+6.3pp) moved far
more, and `knowledge_update` fell 0.6000 → 0.5750 (−2.5pp).

PersonaMem v2's `ask_to_forget` was expected to be at risk, because a fuller page
carries more superseded content into the reader's context. It regressed:
0.2605 → 0.2261 (−3.4pp) while every other category gained (for example
`health_and_medical_conditions` 0.2905 → 0.3944 and `neutral_preferences`
0.3485 → 0.4138).

Both readings are consistent with the page being a boundary rather than a lever:
capacity recovers evidence that ranking already had, and it also recovers
superseded evidence ranking never marked as stale. Neither observation identifies
the mechanism, and neither was tested at question level.

## What this does and does not establish

**It establishes** that the budget misaccounting compressed the evidence page, and
that correcting it — under the same configured budget — restored page capacity and
improved answer judging on all four suites, most on LongMemEval. Those are
end-to-end effects of one accounting change across four datasets, one reader and
one judge.

**It does not establish** a recall@k gain. No recall metric was computed on the
before and after pages; the counted quantity is delivered page size and judged
accuracy, not evidence coverage against gold labels.

**It does not add to any earlier representation result.** The LoCoMo
contextualised-representation measurement and this fix were not crossed, so their
effects must not be summed or compared as if independent parts of one number.

**The F1 and ROUGE movement is an observation, not an explanation.** F1 rose by
0.0017 while ROUGE-L fell by 0.0032 and the judge rose by 0.1200. Vocabulary
explaining the divergence — longer pages diluting n-gram overlap, a weak reader
benefiting more from complete evidence — is a hypothesis about mechanism, not a
measured result; confirming or rejecting it needs question-level comparison of
answers and gold spans, which has not been done.

**"Within budget" holds only on the estimator's own basis.** The 23,107 mean
rendered characters are about 5,777 tokens at the estimator's 4-characters-per-token
basis, below the 6,000 envelope. The actual model input is larger: it carries the
prompt template and instructions on top of the rendered surface, and those were
not measured.

## Alternatives considered

- Raise the configured envelope instead of fixing the accounting: would deliver
  the same page while hiding a 2.38× overcharge, and would inflate real input
  tokens by the same ratio the next time a summary or evidence field grows.
- Drop the node summary charge only: leaves evidence charged at 3.2× its rendered
  size, still short of a full page.
- Reduce `SOURCE_EXCERPT_CHARS` so the raw charges would fit: trades evidence
  content for record count under a broken budget, and makes the excerpt budget
  instead of the page.
- Compute exact rendered length by rendering twice: correct but pays a full
  surface render per candidate during ranking, and couples ranking cost to the
  renderer's formatting rather than to its declared budget fields.

## Consequences

This is the baseline the later retrieval work is measured against: from here, a
change to record selection is read against a page that is actually full at the
configured budget. The paired re-run above replaces the earlier note that the
other suites were not comparable; all four suites are now measured under the same
accounting, and their baselines are kept in each run directory's `.baseline-v1/`.

Two categories boundary the value of capacity: BEAM's `event_ordering` (+2.1pp)
and PersonaMem v2's `ask_to_forget` (−3.4pp) show that filling the page neither
fixes ordering nor keeps superseded content out of the reader's context.

The estimator is now coupled to the renderer. If `renderEvidenceSurface` starts
printing something the estimator does not charge (for example a longer excerpt or
a rendered summary), the page silently grows past its budget; the exported
`SOURCE_EXCERPT_CHARS` plus the guard tests make the excerpt case explicit, and any
new rendered field needs the same treatment.

Pages are roughly 2.8× longer than before at the same nominal budget, so latency
and input-token cost per query rise with page capacity. That shift is a
consequence of the fix, not evidence about retrieval quality.

Earlier planning put event-graph and cross-session mechanisms first. This result
makes that ordering premature: a substantial share of the measured capability loss
came from a budget that shrank the actual evidence page, so the corrected baseline
has to exist before the remaining failures can be attributed to a missing
mechanism. The next lever is not a new mechanism but the quality of what fills the
page — the `SOURCE=` excerpt is still the first 320 characters of the evidence
rather than a question-relevant, source-preserving span.
