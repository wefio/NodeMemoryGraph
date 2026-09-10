# Recall instances: a self-contained, source-agnostic retrieval benchmark

**Status:** implemented  
**Approved:** unrecorded
Date: 2026-09-07
Branch: pr/recall-instance-benchmark

Governed by the self-governance meta-rule and the hidden-features rule
(`docs/decisions/implemented/2026-09-07-register-hidden-features.md`): this adds
a default-on env-gated feature (`NMG_RECALL_INSTANCES`), so it is registered in
the hidden-features registry in the same change.

zh: [2026-09-07-recall-instance-benchmark.zh-CN.md](2026-09-07-recall-instance-benchmark.zh-CN.md)

## Problem

The online-feedback loop kept starving: feedback only legitimately exists on a
recall that was retrieved **and** used in an answer, and answer-use is turn
level — rare relative to code work, and vulnerable to "I forgot to rate it". The
root cause was asking the wrong unit of supervision: usefulness of a recall to a
downstream answer is sparse and requires the answer. Retrieval **quality** is
not.

## Decision

Treat every disclosure recall as one **self-contained instance**:

```
instance = { trigger (the content that fired the recall),
             retrieved candidates (+ their text),
             activeGraphId }
```

Relevance of the retrieval to its trigger is judged **standalone** — the
(trigger, retrieval) pair needs no downstream answer, so it is complete and
independent, and a code-heavy session cannot starve it (density = recall events,
not answer turns). This is a **retrieval-layer** supervision signal: it is
exactly what the online router optimises, and it makes no causal "this helped my
answer" claim.

- **Every disclosure recall is an instance** — automatic pre-turn and the
  model's own explicit search alike; both have a trigger. Internal probes
  (`persistTrace:false`) surface nothing and are excluded, as they already are
  from online staging.
- The daemon appends unlabeled instances to `<dataDir>/recall-instances.jsonl`
  at the single disclosure choke point (`#search`), source-agnostic.
- **Capture is immutable; labels live in a separate append-only ledger**
  (`recall-instance-labels.jsonl`), so no producer ever rewrites the corpus.
  Relevance is labelled by two producers:
  - **remember-time settlement** (always-on): when the write path supersedes a
    memory, any outstanding instance that surfaced that memory is settled
    `on_target` — store-verifiable, attributable evidence, so it is a real data
    producer that never waits for a session or a judge run.
  - **offline judge** (`tools/recall-instance-judge.ts`, on demand): one of
    `on_target | partial | noise | misleading | gap`. `gap` names the missing
    case — a memory that should have been recalled was not — the sufficiency
    failure the retrieval layer must also account for. The judge may be an
    external model (`NMG_JUDGE_*`) or the agent itself: `--list` prints each
    instance (trigger + candidates + current label) for reading, and
    `--set <graphId>=<label>` records a manual judgement; both write the same
    `source: judge` ledger entry, and an invalid label or unknown instance is
    rejected rather than guessed.
- The corpus is the benchmark substrate: settled/judged instances accumulate
  into a regression/analysis set and provide real retrieval-level labels.

## Consequences

- Supervision density no longer depends on answer turns; every disclosure recall
  contributes an instance.
- Labels stay at the retrieval layer (no end-to-end overclaim). A recall can be
  on-target while the answer still fails on execution, and vice versa; this
  benchmark only measures the layer the router tunes.
- The `gap` axis keeps the "should have recalled" failure visible alongside
  wrong-retrieval failures, so recall sufficiency is measurable, not only
  precision.
- Capture is bounded (top-N candidates, truncated statements) and best-effort
  (never breaks a recall). Default-on but independent of online learning; off
  via `NMG_RECALL_INSTANCES=0`.
- These labels feed the retrieval-quality benchmark and the online router's
  real objective (should this recall be surfaced?). They are retrieval-layer
  supervision, kept distinct from explicit `recordFeedback` (which trains only
  the exact graph it names) and never used as an assistant usefulness claim.

## Data production (when labels actually appear)

A passive capture log alone produces no labels. Two producers make labels
appear without depending on organic memory-using turns or on someone running a
judge:

1. **remember-time settlement** — fires on every supersession; store-verifiable;
   the always-on producer.
2. **offline judge** — on demand over the capture log.

**Also implemented:** a **controlled recall probe** (`tools/recall-probe.ts`, on
  demand over a store snapshot) — the deterministic producer when live data is
  thin. Gold-free: each manifest row names the memory its trigger should recall
  (writer-declared recall intent) and the probe measures whether real retrieval
  (lexical, no embedding provider) surfaces it (`on_target`/`gap`) and stays
  robust under controlled perturbation. `collectionOrigin=controlled`, no LLM,
  no judge. Source: `src/lab/recall-probe.ts`.

## Alternatives considered

- **Keep asking turn-level usefulness inline only.** Rejected: it is the sparse,
  answer-dependent signal that starved the loop.
- **Infer "useful" from downstream behaviour.** Rejected as a standalone label:
  it re-introduces the causal overreach (mis-attribution) previously removed.
  Behavioural inference stays a separate weak backstop, not a corpus label.

## Evidence

- `tests/lab/recall-instance.test.ts` — append/read round-trip, malformed-line
  tolerance, candidate bounding, label aggregation (precision + gapRate), and
  label parsing.
- Hidden-features registry row for `NMG_RECALL_INSTANCES`.
