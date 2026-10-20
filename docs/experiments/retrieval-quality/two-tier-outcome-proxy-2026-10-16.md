# Two-tier recall shadow comparison: executed-action proxies and capacity pressure

[English](two-tier-outcome-proxy-2026-10-16.md) | [简体中文](two-tier-outcome-proxy-2026-10-16.zh-CN.md) · [Terms](two-tier-outcome-proxy-2026-10-16.terms.yaml)

## Results and run boundaries

This round found no held-out-backed useful tier subset, so FIFO stays and tiers are not
wired into the runtime path. In the 8-word, 1-hour shared-age replay with inferred word
sources, the pool peak was only 2 and capacity evictions were 0. A two-tier scheme that only
changes full-pool eviction order therefore never had the chance to produce a different
decision; that is not evidence that all tiers are useless.

This is the offline follow-up to the
[first vocabulary calibration](recall-tier-calibration-2026-10-16.md): it repeats no
distribution fitting and uses no within-tier variance as a stand-in for policy benefit. There
was no runtime code or configuration change, no shared restart, no Pi reload, no extra
evaluation model or embedding call, and no new online collector. A read-only status check on
2026-10-16 returned `recall_gate.activation = null`: this round enabled no online pilot and
did not verify which bridge version the current Pi has loaded, so the FIFO word pool cannot
be called live.

## Data and the upgraded proxy

A fixed, complete line prefix was read from 116 session files under the same project
directory from 2026-08-01 on. 114 branches passed the full latest-ancestor chain check and 2
corrupt files were excluded entirely rather than having their tool actions guessed. 27 rows
from non-current branches were dropped, and the 6,577 user rows older than each file's
creation time were not counted again. That conservative time filter avoids importing
historical double counts and may also miss a file's initial context. It yielded 112 sessions
with usable native records and 2,367 rows, of which the current static entry-rule replay
skipped 2,188. The user role does not independently prove a human author, and static rule
replay does not reconstruct historical task anchors or host scheduling.

| Checkable signal | Count | Interpretation boundary |
| --- | ---: | --- |
| Ordinary search requests inside the new time window | 160 | a request is not proof of execution or need |
| Direct request/result pairs with a successful structured search result | 140 | includes empty candidates, carries no quality label |
| Nested call execution metadata uniquely joined to an existing recall journal row | 17 | same session, verbatim query, parent-call time span; displayed text is not parsed |
| Successful post-search exact get returning the same record | 18 | main proxy; not model reading, adoption, factual support or real need |
| Extra chains with only the exact-get call and no return payload | 2 | secondary signal, not promoted to main proxy |
| Shadow admissions whose original text/matched search term align | 44 | 42 distinct word fragments from 25 sessions |

Joins preferred an explicit graph; without one, only same-turn, search-before-get and a unique
record-ID match were accepted. One multi-source join stays ambiguous and is not counted twice;
an empty exact-get result is never backfilled into a "successful return" from request
parameters. A nested `ok` is execution metadata, not the call syntax in code; missing arguments
or payloads stay unknown. No exact get, no later appearance and an automatic hit are never
labelled "not needed" or "beneficial".

Word sources are no longer drawn uniformly from the whole vocabulary: for each static skipped
turn, the first checkable word fragment that appears both in an ordinary search and in the
user's original text and passes the shared literal/reference/secret filters is taken, preferring
a valid declared cue and otherwise taking the longest 1–4 ICU word-unit fragment of 3–80
characters. 27 sources had several candidate fragments. This sample had no usable declared-cue
source, so all 44 are inferences, not actually admitted LLM cues. Preferring the longest
fragment is an engineering assumption, and the upgraded proxy does not remove cue-selection
uncertainty.

## Two-tier comparison and prespecified subsets

- Control: FIFO by admission order. Candidate: an ordinary/protected two-tier scheme that
  evicts the oldest ordinary word first and keeps FIFO inside a tier. Within the current word
  cycle, the protection condition is a successful exact-get follow-up on at least 1 or 2
  distinct ordinary queries. It is a weak behaviour count, not a probability, a stability
  verdict or permanent promotion.
- Same admission sources, capacity, lifetime, at most one shallow-lookup chance per turn, and
  the five-candidate/0-hop resource constraint. Automatic hits neither admit, promote nor
  extend life; repeated cues and exact gets do not update birth time. A late signal cannot
  revive or promote a replaced word cycle.
- Only capacity eviction is compared; TTL, trigger eligibility and query thresholds are not
  changed at the same time. The 1-hour common age bound is a shadow assumption, not a full
  reconstruction of the product's shared parent lease; no cross-session lifetime is inferred.
- When user input arrives the prediction is frozen first, then that turn's cue and exact get are
  processed. Main coverage requires a currently retained word to match the original input and
  the record IDs of its past successful exact gets to intersect this turn's exact-get returned
  IDs. That is a record-reuse opportunity, not an actual re-retrieval hit, model reading or a
  correct answer; the same ID does not guarantee the same fact revision. A looser
  "any retained word matched the input" upper bound is reported separately, and current-turn
  admission is never backfilled into a recall success.
- Four subsets were defined in advance: all turns, prior capacity-eviction pressure, pressure
  with a mixed ordinary/protected pool, and past keywords that already repeated. Grouping uses
  only the reference FIFO state before input arrival, never the current exact-get result.

The design was fixed before policy replay. The first version split at whole session starts, but
an audit found two training sessions whose observations crossed the held-out boundary; both
sessions and their 174 rows were removed entirely, the original report was kept, and no
protection threshold or subset was adjusted based on held-out benefit. Final training is 76
sessions / 1,471 rows and held-out 34 sessions / 722 rows with a boundary at
`2026-09-10T05:21:54.189Z`; all training native inputs and related memory-action observations
predate it. Session blocks still do not guarantee independent tasks, and the fixed historical
admission band is not a counterfactual trajectory that a new policy would naturally produce.

Query budget started from 25% of the training segment's ordinary searches, rounded up, then
mapped to held-out by the per-eligible-turn rate observed in training, giving 13/7; an
unbudgeted sensitivity run was also done. That is a resource assumption, not a monetary
optimum or product quota. Candidates were selected on the training segment only when they
strictly increased main coverage without increasing query counts inside a subset or overall;
ties kept FIFO. Held-out support also required the benefit not to be confined to one session
block, and no natural benefit may be claimed from it.

## Replay results

All counts below are replayed opportunities or budget units; none of these extra queries was
actually issued.

| 8-word / 1-hour shadow baseline | Training | Held-out |
| --- | ---: | ---: |
| Eligible skipped turns | 1,352 | 674 |
| Main exact-get follow-up chains | 7 | 10 |
| Query opportunities for FIFO and both two-tier schemes | 7 | 1 |
| Main record-reuse coverage | 0 | 0 |
| Upper bound of loose word-match coverage of main chains | 0 | 0 |
| Capacity evictions | 0 | 0 |

One of the 18 fully collected main chains was removed with the cross-boundary sessions, so the
table totals 17. Zero main coverage cannot be read as "no memory need", nor as proof that FIFO
word cues help. Sparsity of shared word sources, inferred-fragment selection and insufficient
literal repetition also limit the result.

Twelve settings (capacity 8/4/2 × age bound 1/24 hours × with/without quota) each ran three
policies. Extending to 24 hours at 8 words still peaked at 3; the only capacity contention
appeared when capacity was artificially squeezed to 2 words and the bound widened to 24 hours:
2 training evictions, 1 held-out eviction, a held-out pressure subset of 19 turns / 1 main
chain, and still no coverage gain. None of the four prespecified subsets selected a training
candidate better than FIFO, so no held-out advantage can be announced. Artificial
capacity/lifetime pressure cannot become valid subset evidence under the current 8-word
assumption. Empty pressure subsets get no confidence interval, and two schemes matching without
pressure is a structural limit, not an estimate of overall equivalence.

## Follow-up choices and verification range

FIFO stays; cutting points, tier counts and long-term/permanent rules are not adjusted further
for now. What deserves a later comparison is a scenario where capacity contention arises
naturally and the evicted item already has an independent ordinary exact-get follow-up, rather
than fitting further ratios on an unpressured sample. It needs real admitted cues and later
outcomes; inferred words or automatic hits cannot substitute. Existing ordinary search
parameters, session events and native logs are reusable; this round implemented no background
shadow evaluation, polling or second collector.

Twenty-one private computation self-checks passed, covering request/result binding,
ambiguity/empty results, no current-turn self-evidence, no life extension, expiry/replacement
fencing, hard budget, cross-boundary session removal and matching policies without pressure; a
synthetic contention sample can detect equal-query-count gains but is not natural-effect
evidence. LSP checks on the new scripts and compatibility with the old sampling interfaces have
separate receipts; they do not replace benefit proof. No online A/B, real post-eviction
relearning, provider send, model-read confirmation, full parent lease or net total cost
evaluation was run.

The private rerun package lives in `.nmg/verification/recall-tier-calibration/two-tier/` with the
design, hashed bounded source prefixes, aggregated data, the comparison matrix, self-checks,
pre-correction results and failure receipts; the shared history/word-source read helper is
reusable by the old sampler. The public report carries no raw messages or memory statements,
and private word fragments and input data are not published with the repository, so a fresh
clone cannot replay the private sample.
