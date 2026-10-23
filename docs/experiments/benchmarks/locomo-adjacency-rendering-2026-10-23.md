# Adjacency: recalled content or useful relation? — 2026-10-23

[简体中文](locomo-adjacency-rendering-2026-10-23.zh-CN.md) · [Terms](locomo-adjacency-rendering-2026-10-23.terms.yaml)

Evidence boundary: one reader/judge model family, one run per arm, and only the
questions where placement could matter. These are answer-stage measurements on a
subset, not a benchmark score.

## Question

Session adjacency raised coverage on the temporal and single-hop categories
(+11.7pp, 21W/4L). Half of the rescued turns begin with a pronoun, which
suggested two competing explanations:

1. the neighbour **content** is what helps — adjacency is merely the channel that
   reaches it;
2. the **relation** helps — the reader needs the neighbour placed next to the
   record it follows.

## Method

Arms carry the same records and differ only in placement. Every line carries its
session date in all four arms, because the LoCoMo prompt instructs the reader to
use timestamps and the recorded page has none; without that, both accurate and
inaccurate answers would be indistinguishable for temporal questions.

| arm | records |
| --- | --- |
| `page` | the recorded 20-record page |
| `tail` | page, then the appended session neighbours at the end |
| `anchored` | page, with each neighbour immediately after its anchor, in session order |
| `placebo` | page, plus the same number of records from sessions the page never touched |

Scope: only questions where a labelled evidence turn was missing from the page
but present among the appended neighbours — the questions where placement can
change the answer. That is 23 of 145 temporal/single-hop questions and 84 of 279
multi-hop questions. Official LoCoMo answer and judge prompts, temperature 0,
thinking disabled.

## Results

Temporal + single-hop (n=23, 23 judged per arm):

| arm | correct | accuracy |
| --- | ---: | ---: |
| page | 10/23 | 43.5% |
| tail | 21/23 | **91.3%** |
| anchored | 21/23 | **91.3%** |
| placebo | 12/23 | 52.2% |

| pair | wins / losses / ties | exact p |
| --- | --- | ---: |
| tail vs page | 11 / 0 / 12 | 0.00098 |
| anchored vs page | 11 / 0 / 12 | 0.00098 |
| **anchored vs tail** | **0 / 0 / 23** | — |
| placebo vs page | 2 / 0 / 21 | 0.5 |

Multi-hop (n=84, 82–83 judged per arm):

| arm | correct | accuracy |
| --- | ---: | ---: |
| page | 51/83 | 61.4% |
| tail | 69/82 | **84.1%** |
| anchored | 65/82 | 79.3% |
| placebo | 53/83 | 63.9% |

| pair | wins / losses / ties | exact p |
| --- | --- | ---: |
| tail vs page | 19 / 1 / 61 | 0.00004 |
| anchored vs page | 17 / 2 / 62 | 0.0007 |
| **anchored vs tail** | **3 / 6 / 72** | 0.51 |
| placebo vs page | 5 / 3 / 75 | 0.73 |

## Reading

- **The recorded content is the value.** Appending the neighbours the chain rules
  select wins 30 questions and loses 1 across both scopes.
- **More context is not the value.** Appending the same number of records from
  untouched sessions moves almost nothing (2W/0L and 5W/3L).
- **Placement is not the value.** Anchoring each neighbour after its anchor is
  identical on 23/23 questions and slightly worse on multi-hop (3W/6L, p=0.51).
  The anaphora worry did not survive the answer stage: the neighbour's referent
  was already in the page, so position did not matter.
- Practical consequence: the product's existing `expandChains` shape — append
  members at the end, bounded — is sufficient. No anchored rendering is needed,
  and no ordering metadata has to survive into the prompt.

## Bracketed arm (explicit relation marker)

A fifth arm wraps each group of related lines in braces, keeping the anchored
placement: `{ anchor, neighbour }`. It isolates "the relation is stated" from
"the relation is implied by position".

`deepseek-v4-flash` returned 503 mid-session, so this arm ran on
`deepseek-v4.1-flash` with all five arms in the same run; within-run pairs are
the comparable ones, and the four-arm pattern reproduced (page 45.5% versus tail
95.7% at n=23).

| scope | anchored | bracketed | bracketed vs anchored |
| --- | ---: | ---: | --- |
| temporal + single-hop, n=23 | 100% (23/23) | 95.7% (22/23) | 0W / 1L / 22 ties, p=1 |
| multi-hop, n=40 | 87.2% (34/39) | 86.8% (33/38) | 0W / 0L / 37 ties |

Stating the relation explicitly changes nothing: one loss and 59 ties across 63
paired questions. The multi-hop scope stopped at 40 of 84 questions because the
remaining questions could not change an exactly-tied comparison.

## Acknowledgement arm (keep the chitchat, add the line after it)

A pure acknowledgement is identified as: after the speaker prefix, at most five
words, no digits, and no entity after the first word. That rule flags only
1.1–2.6% of appended turns — short answer-bearing turns such as "I bought it a
year ago in Paris" are not caught, which is why the wider "short or starts with
thanks" filter was rejected earlier. This arm keeps each such turn **and** adds
the line that follows it, so a slot spent on "Yeah!" does not hide the sentence it
was answering.

| scope | tail | ack-plus | ack-plus vs tail |
| --- | ---: | ---: | --- |
| temporal + single-hop, n=23 | 91.3% (21/23) | 95.7% (22/23) | 1W / 0L / 22 ties, p=1 |
| multi-hop, n=84 | 84.1% (69/82) | 76.8% (63/82) | 2W / 7L / 72 ties, p=0.18 |

Regression is a wash and multi-hop trends worse: the added sentence carries no
new evidence and lengthens the context by one to three records per question.

## Decision

Adopt the content channel only: append the neighbours the chain rules select,
deduplicated by memory id, bounded. No anchoring, no braces, no acknowledgement
padding. That is the shape `expandChains` already has — appended members after
the ranked page, capped — so the product needs no rendering change.

## Caveats

- Absolute accuracies come from one run per arm. Repeating the page arm on
  identical prompts gave 12/23 and then 10/23 at temperature 0, so single-run
  absolute gaps carry a couple of questions of noise; the paired comparisons
  within a run are the load-bearing evidence.
- One judge, same model family as the reader, no human spot check. `UNPARSED`
  judge outputs drop 1–2 rows per arm in multi-hop.
- The informative subset is chosen by where the mechanism can matter, so these
  accuracies are not the suite's accuracy.
- Token use: 234,862 prompt tokens (regression) and 854,287 (multi-hop), with no
  provider cache hits reported.
- `deepseek-v4-flash` and `deepseek-v4.1-flash` are aliases for the same model,
  so arms filled under either name are comparable.

## Artifacts

`evals/locomo/results/adjacency-rendering-reg23b/` and
`adjacency-rendering-multi84/` hold per-question answers and labels for six arms;
`adjacency-rendering-reg23-v41/` and `adjacency-rendering-multi84-v41/` hold the
earlier five-arm runs. The probe is
`evals/omnimemeval/research/probes/adjacency-rendering-ablation.ts`; rendering
tests are in `tests/evals/adjacency-rendering.test.ts`.

The probe now fills only the arms a stored row is missing, so adding a rendering
costs one arm rather than re-running the whole set. The first bracketed runs
re-ran all five arms, which was a probe design defect, not a measurement need.
