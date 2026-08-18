# HaluMem operation-level evaluation — 2026-08-11

This evaluation measures write-time extraction pollution, expected-memory
coverage, interference rejection, and update retrieval. It is not a QA score
and is not yet a direct score of STG-to-LTG promotion.

## Protocol

- Source: the official HaluMem Medium JSONL distributed by OmniMemEval.
- Artifact fields follow the official HaluMem adapters:
  `extracted_memories` per session and `memories_from_system` per update point.
- Official HaluMem prompts, rubrics, `process_user`, and scoring functions are
  used unchanged.
- The wrapper accepts both fenced and bare JSON because DeepSeek returns valid
  bare JSON while the official parser accepts only fenced JSON.
- On Windows the official process pool is replaced with a bounded thread pool.
  Calls are HTTP-bound; this preserves the official scheduling and scoring while
  avoiding child-process parser drift and duplicated Python runtimes.
- QA fields are deliberately omitted. This run evaluates extraction and update
  operations only.
- Model: `deepseek-chat` (the configured DeepSeek flash route), temperature 0,
  at most four concurrent judge requests.

The adapter replays preceding sessions before scoring a later slice, so an
update query observes the same accumulated memory state. Commands:

```powershell
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 --reset
npm run eval:halumem:score -- --users 1 --workers 4
```

Generated stores and result artifacts stay under `.benchmarks/halumem-nmg/`
and are not committed.

## Natural-data smoke result

The selected sixth session contains 30 dialogue turns, two ordinary gold memory
points, one interference memory, and four updates. The preceding five sessions
were replayed but not scored.

| Metric | Result |
|---|---:|
| full expected-memory recall | 1.000 |
| importance-weighted recall | 1.000 |
| official target accuracy | 0.875 |
| all-candidate weighted accuracy | 0.683 |
| official extraction F1 | 0.933 |
| interference rejection | 0/1 |
| correct updates | 3/4 |

The official target-accuracy denominator includes only candidates whose fields
occur in the gold memories. Consequently extraction F1 can remain high while
many extra candidates are noisy. All-candidate weighted accuracy and
interference rejection expose that pollution more directly.

The interference failure is attributable: the benchmark bridge currently
materializes every dialogue message as `conversation_evidence`, including long
assistant suggestions. The rejected candidates are mostly assistant coaching,
questions, or synthesized interpretations rather than stable user facts. The
single update omission retrieved several relevant statements but did not make
the complete old-value-to-new-value replacement explicit.

## Product boundary and decision

This is an honest score of the current **benchmark raw-message ingress**, not
the Pi product ingress. Pi does not automatically persist the transcript or
tool output. Its durable boundary is an explicit, model-mediated
`nmg_remember`, with exact evidence retention and provenance validation.

Therefore this smoke does not justify changing Core ranking or enabling
automatic promotion. It establishes two requirements for any future automatic
write gate:

1. assistant statements require user confirmation or independently verified
   evidence before becoming durable user facts;
2. an update must preserve the new value and explicitly retire or supersede the
   attributable old value.

Before unattended STG-to-LTG promotion is enabled, the same operation scorer
must evaluate actual promotion candidates (not raw messages), over more users
and sessions, and report false-promotion cost plus successful retraction.

## Agent-filtered remember-policy arm

A second arm asks the configured Agent model to execute the current NMG durable
write policy over the dialogue, without access to HaluMem memory points or
questions. It returns atomic statements plus exact evidence, type, optional
time, and optional state key. The output is content-addressed by dialogue,
policy, and model, so reruns reuse the local ignored cache.

```powershell
npm run eval:halumem:agent-extract -- --users 1 --through-session 6
npm run eval:halumem:prepare -- --users 1 --session-start 6 --sessions 1 `
  --agent-extractions .benchmarks/halumem-nmg/results/agent-extractions.jsonl `
  --data-dir .benchmarks/halumem-nmg/store-agent `
  --output .benchmarks/halumem-nmg/results/nmg-agent_eval_results.jsonl --reset
npm run eval:halumem:score -- --users 1 --workers 4 `
  --input .benchmarks/halumem-nmg/results/nmg-agent_eval_results.jsonl `
  --output .benchmarks/halumem-nmg/results/nmg-agent_eval_stat_result.json
```

On the same sixth-session slice:

| Metric | Raw-message ingress | Agent-filtered ingress |
|---|---:|---:|
| extracted candidates | 30 | 12 |
| full expected-memory recall | 1.000 | 0.500 |
| all-candidate weighted accuracy | 0.683 | 1.000 |
| interference rejection | 0/1 | 1/1 |
| correct updates | 3/4 | 4/4 |
| official extraction F1 | 0.933 | 0.667 |

The Agent boundary eliminates the observed pollution and improves update
handling, but over-filters one gold point: the user's optimism that a changed
pet preference could help manage stress. This is a real precision/recall
trade-off, not a reason to restore raw assistant messages. A future automatic
writer should preserve explicit user attitude and causal qualifiers while
continuing to reject the benchmark's contradictory skepticism.

This arm is closer to the product `remember` responsibility split, but still is
not posterior consolidation: it measures candidate formation before repeated
cross-task outcome evidence. Automatic STG-to-LTG actuation remains off.

## Second matched natural slice

To check that the sixth-session result was not an isolated prompt accident, the
same two arms were run on user 1, session 5. The preceding four sessions were
replayed in both stores. This session contains 52 dialogue turns, eight ordinary
memory points, two benchmark interference points, and one update.

| Metric | Raw-message ingress | Agent-filtered ingress |
|---|---:|---:|
| extracted candidates | 52 | 8 |
| full expected-memory recall | 1.000 | 0.875 |
| all-candidate weighted accuracy | 0.971 | 1.000 |
| interference rejection | 0/2 | 0/2 |
| correct updates | 1/1 | 1/1 |
| official extraction F1 | 1.000 | 0.933 |

The filtered arm again removes the large candidate surplus while preserving a
high proportion of the ordinary evidence. Its one missed ordinary point is an
interpretation that pets are essential to the user's emotional support and
mental well-being; the dialogue supports comfort and relaxation, but the Agent
did not promote the stronger “essential” formulation.

The interference score needs careful interpretation. One benchmark
interference point changes “new experiences and interactions” into “different
pet species and unique behaviours”; the filtered memories do not contain that
claim and the judge rejects it. The other changes the same evidence into
“willingness to try unconventional pet choices”; the official judge accepts it
against a retained preference-change memory even though HaluMem labels it
interference. Therefore `interference_accuracy_all = 0` is not, by itself, proof
that the Agent admitted both injected claims. For product gating, report the
per-record judge decision and attributable stored candidate alongside the
aggregate score.

Across these two small matched slices, the stable signal is the precision/recall
trade-off: model-mediated admission greatly reduces stored volume and candidate
pollution, but can omit soft attitude or causal interpretations. This is enough
to continue evaluating actual STG candidates; it is not enough to tune the
product write prompt or enable unattended LTG promotion.

## Posterior STG promotion audit

The next arm uses the product lifecycle rather than treating filtered candidates
as already durable:

```text
Agent candidate with exact user evidence
  -> real session-owned STG remember
  -> later sessions inspected without gold memory points
  -> exact later user excerpt becomes an independent support/contradiction vote
  -> existing recordClaimOutcomes posterior and default consolidation gate
  -> qualified candidates only
```

Assistant-only or unattributable origin evidence is rejected before STG. Later
topic similarity, assistant statements, silence, and partial inference do not
become votes. The model returns a smallest exact user excerpt, and the adapter
verifies that it occurs in the claimed later session before Core sees the vote.
Gold memory points remain scorer-only.

```powershell
npm run eval:halumem:promotion-audit -- --user 1 `
  --origin-start 5 --origin-end 6 --observe-through 11 --reset 1
```

| Origin sessions | Later sessions | STG candidates | Rejected at origin | Independent votes | Qualified |
|---|---:|---:|---:|---:|---:|
| 5–6 | 7–11 | 17 | 3 | 0 | 0 |
| 1–2 | 3–11 | 16 | 0 | 0 | 0 |

This is a useful negative result. Some themes recur, but later user messages
often support only one component of a broad earlier candidate. For example, a
later statement about improving healthcare access does not independently confirm
an earlier compound claim that also specifies a global initiative and a numeric
reach target. Weakening the vote rule would convert topical recurrence into
self-reinforcement, which violates the posterior design.

HaluMem therefore provides an operation-level admission and update gate, but
does not provide the successful tool outcomes, answer-use attribution, or
explicit repeated confirmations needed to calibrate NMG's default posterior
promotion policy. The zero-qualified result does not mean STG is broken; it
means this benchmark cannot by itself authorize automatic consolidation. It also
adds an extraction requirement: independently changeable qualifiers should be
separate claims or records so later evidence can update them independently.
