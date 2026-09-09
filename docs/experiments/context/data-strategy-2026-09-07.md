# Data strategy: which dataset, how to get training data, does it generalize, is it good?

**Date:** 2026-09-07
**Status:** synthesis of internal OmniMemEval data structure + external literature.
**Purpose:** answer the four data questions behind the pre-registered router experiment.

## TL;DR

The binding constraint is **not which benchmark JSON to read** — it is that a
decision policy needs *executed* `(state → action → reward)` samples, which the
benchmarks do **not** provide (they give gold answers + a corpus, not
intervention labels). Those labels cost real model runs to generate, with
exploration across actions, and must be owner-independent. Second, the benchmark
data itself is only as good as its audited ground truth and its judged
generalizability to real agentic "should I inject" decisions — both are
questionable and must be argued, not assumed.

## Q1. Which dataset?

Internal availability (grounded):
- **LoCoMo** `locomo10.json`: 10 owners, ~199 Q each (sequential per owner),
  temporal/recall; retrieval-context artifacts exist; official answer+judge is
  wired (canary ran it). But **only 10 owners** → too few for powered owner-level
  train/val/test with exploration.
- **LongMemEval** `longmemeval_s_cleaned.json`: 500 independent rows (each Q has
  its own haystack). Good owner count for accuracy generalization, but likely
  ~1 decision each → **no within-owner sequence** for H2 history.
- **PersonaMem v2**: 200 personas with multi-turn chat (strongest for sequential
  history / H2), but owner↔question mapping and official answer+judge wiring are
  not yet confirmed and cost the most to set up.

**External caution:** LongMemEval-S's per-question corpus fits in a modern context
window, so it is criticized as "a context-window test, not a memory test"
(AgentOS/penfield audits). LoCoMo is a real long-term benchmark but has broken
ground truth (see Q4).

## Q2. How do we get the data (the real bottleneck)?

A benchmark supplies gold `answer` + corpus. To learn which injection action was
good we must run the answer model with each candidate context and grade it —
i.e. **each training sample is an executed intervention costing ≥1 real
answer + 1 judge call**. To learn over 4 actions we need exploration (not just
one fixed action per state), so we cannot reuse a single fixed-policy pass.
Options grounded in the offline-RL / RAG-RL literature:

- Offline executed-sample regression (our `observed-action regression`): fit on a
  fixed collected dataset of `(features, executed action, verified outcome)`.
- Reward can come from a reward model / downstream graded quality (official
  grader) rather than needing human labels.
- Offline-to-online / on-policy RL (RL fine-tuning of retrieval) is how the
  literature learns such policies, but requires on-policy or richer exploration
  than a static one-shot benchmark pass.

Consequence: a powered owner-independent train/val/test with ≥30 owners ×
exploration across actions can require a **large executed-sample budget** — a
cost that must be predeclared and is the real "how to obtain data" answer. The
benchmark only lowers this by giving the gold; it does not remove the need to
execute interventions.

## Q3. Does it generalize?

- **Static one-shot recall benchmarks do not predict multi-session agentic
  performance** (MemoryArena / labelstud): they miss real failure modes
  (knowledge updates/corrections, contamination), and real "should I inject"
  decisions occur continuously inside an agent loop, not as one-shot QA.
- So a router tuned to beat a fixed fallback on a benchmark **is not shown to
  generalize** to real agent memory by that alone; generalization would need
  held-out owners, ideally a second dataset, and (best) a real-agent/agentic
  multi-session check.
- Guard against contamination/leakage: cross-user contamination in real harnesses
  is reported at 57–71% (Mem0 survey) — a real threat, and owner-level isolation
  in evaluation is exactly what protects against it in measurement.

## Q4. How do we show the data is good?

Independent audits show you **cannot trust benchmark gold or judge by default**:
- **LoCoMo**: 6.4% of the answer key is wrong; the LLM judge accepts up to 63% of
  intentionally wrong answers. This puts a hard floor on any LoCoMo score gap:
  below ~6 points is inside judge noise.
- LongMemEval-S corpus fits in a context window → weak as a memory test.

Therefore "data is good" must be **demonstrated, not assumed**, via pre-registered
data-quality gates:
1. **Gold audit on the chosen subset**: verify a sample of ground-truth answers
   (spot-check / reconcile) and report audited error rate; drop or flag rows whose
   gold is unreliable.
2. **Judge reliability**: report judge agreement/noise on the subset; treat any
   accuracy gap smaller than judge noise as non-significant (hard floor, per
   LoCoMo audit).
3. **No contamination/leakage**: owner-level isolation; confirm the subset is not
   in the answer model's training window in a way that inflates scores (hard to
   prove, but report contamination risk).
4. **Coverage**: chosen subset spans the memory abilities the experiment actually
   tests (temporal, update, abstention...) rather than one easy class.
5. **Independence**: ≥N owners, no owner across folds.
6. **Transfer honesty**: generalize claim is limited to the benchmark sandbox;
   real-agentic transfer is a separate, predeclared check, not implied.

## Recommendation (for discussion)

- Treat any single benchmark (esp. LoCoMo) as a **sandbox whose validity must be
  argued**, not as ground truth; bake the Q4 gates into the pre-registration.
- Do **not** interpret the canary's LoCoMo retrieve 2/3 as anything beyond wiring
  (we already label it so) — LoCoMo judge/gold noise makes fine-grained claims
  unsafe there.
- The largest decision is **data acquisition budget + owner independence**, which
  may dominate whether the powered experiment is affordable at all; and whether
  the honest target is the benchmark sandbox (cheap, limited generalization) or
  real-agentic multi-session collection (expensive, generalizable).

## Suitable datasets (decision-shaped, not recall-shaped) — Q1 reframed

Pure recall benchmarks (LoCoMo/LongMemEval/PersonaMem) test "can the gold be
recalled when the right memory is in context" and therefore bias toward
retrieve-always. The router's question is different: *should I inject, how much,
and does injecting ever hurt under a budget?* There are datasets shaped for that:

- **Detrimental contexts in open-domain QA** (Oh & Thorne, EMNLP 2023;
  `xfactlab/emnlp2023-damaging-retrieval`): QA rows annotated where *too much
  retrieved context hurts* vs selective. Directly gives the "more is worse"
  cases the router needs.
- **Distracting passages / counterfactual noise** (ACL 2025 "The Distracting
  Effect"; NAACL 2024 "Why So Gullible"): irrelevant-yet-related or conflicting
  retrieved docs mislead — the model should not blindly trust context.
- **GRAB-RAG / AbstentionBench / evidence-sufficiency** (NQ/HotpotQA under
  supportive/degraded/missing/**misleading** context): graded abstention where
  the right move is to *not trust* injected context.
- **STALE** (ICLR-adjacent, 2025; `icedreamc/STALE`): agentic, long-context,
  400 conflict scenarios / 1200 queries over everyday user profiles — when a
  stored memory is stale/invalidated by a later observation, decide whether it
  is still usable. Closest to NMG's personal-memory validity concern.
- **TEPA / Selective QA over conflicting multi-source personal memory**: revoke
  stale memories, decide under conflicting sources.
- **Cost-aware / token-budget selection** (AB-RAG; "Cost-Aware Evidence
  Selection"; AdaGReS; A2C-RAG): explicit token budgets and redundancy; one
  paper shows *no static selector dominates across datasets*, which is itself
  evidence that a data-dependent router is warranted.

Mapping caveat: most of these are general-knowledge RAG, while NMG is about
*user memory*. The closest faithful fit is the staleness/conflict slice (STALE,
TEPA, selective personal-memory QA), where "don't inject/trust this memory" is
the decision. A purely recall benchmark is the wrong proxy for a cost-quality
injection router.

### Candidate suitability audit (B, 2026-09-07)

Both candidates have a real "more is worse" condition; they split on H2.

- **Layer A — detrimental-context QA** (Oh & Thorne, EMNLP 2023, MIT): JSON/JSONL
  per-question passage lists; 1 gold + damaging/counterfactual docs; NQ/TQA
  short-answer gold; **cheap extractive EM/token-F1** grading (no judge LLM).
  "More is worse" is central. But **single-turn, no within-owner order** →
  **cannot host H2**. Official reader is FiD (not a matched already-exercised
  pipeline). Clean and cheap for the H1 mechanism probe.
- **Layer B — STALE** (2026-05 preprint): best structural fit for
  **owner + order + H2 + conflict** (multi-session timestamped user-assistant,
  implicit conflict / stale-memory invalidation). But: **license unconfirmed**;
  full contexts up to **150K tokens** (far over our 12K/120s budget; bounded
  sampling may discard the very conflict signal); **semantic-judge grading cost**;
  new/unproven.

Neither is a drop-in for the LoCoMo canary path: each needs a new dataset file,
judge wiring, and a hash-pinned owner↔row map. Minimal live probe (5–10 owners,
few queries) should measure `delta(current-context accuracy) vs
(retrieve-all incl. damaging/stale)` to confirm a real router-exploitable gap
within budget before any powered spend.

### Repo reuse inventory + recommended abstraction (Explore, 2026-09-07)

Needed: decouple the shared policy driver (none/cue/resurface/retrieve + main
model + usage capture + reward) from per-dataset shape (owner-ordered rows /
gold / per-condition evidence / grader), so H1 (cheap single-turn) and H2
(ordered, semantic-judge) run on A/B/LoCoMo under one harness.

Already exists to reuse (do not rebuild):
- `evals/retrieval/datasets.ts` `DatasetSpec` + offline driver `run.ts` + cheap
  scorer `score.ts` — closest to a dataset adapter, but a CLOSED union; new
  dataset needs code, not config.
- `src/lab/context-*.ts` (schema/admission/`runContextTrial`/journal/`ContextRouter`)
  — reward-agnostic TS substrate; strongest reuse target.
- `controller-shadow/context-dataset.ts` + `context-report.ts` — owner/source
  stable-hash split + leakage guard + per-group stats, currently hard-wired to
  locomo; reusable once decoupled.
- `judge-provider.ts` — OpenAI client pattern usable as a TS semantic judge.

Genuinely missing (the real framework, not a thin adapter):
- A dataset-agnostic LIVE runner (arbitrary spec x arms x real model x usage).
- A pluggable Grader seam: official-python / cheap EM / semantic. Today offline
  (EM) and live (official) are two disconnected pipelines.

Language seam: live grading lives in gitignored upstream Python, so the canary
is Python and cannot reuse TS `src/lab` types. But EM and semantic judge are
feasible in TS (semantic via judge-provider pattern); only LoCoMo official stays
a special-case Python grader adapter. So ~90% can stay in TS reusing
datasets.ts + src/lab; LoCoMo official is one grader adapter.

## Reward/learning contract (locked 2026-09-07, implemented in src/lab/context-reward.ts)

Design decisions reached with the user after research (RSCB-MC, arxiv 2604.27283):

- **The simple neural net is adjustable** (the 132-param linear head is not
  sacred); the only architecture-independent truth is that value/RL training
  needs ONE scalar reward per executed decision. So the semantic-to-scalar
  bridge is the crux; features/actions/outputs/multi-usage sharing are free to
  design.
- **Recall has several usages** — automatic recall and explicit search are two
  decision points / signal sources; both can feed one controller and one signal
  pool. Do not hang learning only on a single injection-arm evaluation.
- **Judgement is in place, not on a synthetic S block**: the recalled memory is
  already in the live context; the judge reads that and the produced answer and
  returns a SEMANTIC verdict; a deterministic layer converts it to the scalar
  the net consumes.
- **Semantic verdict (minimal)**: `{ quality: correct|partial|incorrect,
  harmful?: bool }` — `harmful` only meaningful for injection actions
  (resurface/retrieve).
- **Asymmetric reward = RSCB-MC event form** (copied, arxiv 2604.27283
  Equation 12 minus the latency/token terms already handled as lambda*K at
  selection). Judge returns one semantic RECALL outcome and maps to a scalar:
  `verified +0.6` (够且好用上) / `correctAbstain +0.3` / `insufficient -0.5`
  (漏关键) / `rejected -0.2` (注了没用上) / `falsePositive -1.0` (错误/过时/
  矛盾误导). Invariant `|gamma|>|alpha|>|kappa|` and `|gamma|>|iota|>|delta|`:
  harmful injection is always the worst outcome. The judge evaluates the RECALL
  RESULT (好不好/充分不充分), not downstream answer correctness. Inconsistent
  (outcome, action) pairs throw so a mislabel can never train.
  Implemented: `contextUseReward(outcome, action)` in `src/lab/context-reward.ts`
  + `tests/core/context-reward.test.ts` (7/7 pass). Natural auto-recall turns
  only observe injected outcomes (verified/rejected/insufficient/fp);
  correctAbstain/rejected-by-choice need the controller to explore none/cue.
- **Reuse the existing natural feedback path (2026-09-07)**: the cheap label is
  ALREADY produced by `nmg_remember action=feedback` (labels taskSuccess /
  evidenceSufficient / expansionUseful / excessiveNoise / noMemoryNeeded,
  bound to activeGraphId) via the next-turn nudge; 45 natural events exist. No
  new judge tool or HTTP call needed. Consumers audited: only the extension
  runtime writer + controller-shadow/report.ts are live (CI runs none of the
  eval:* consumers; skillopt/tau/calibrate/independence are dormant).
- **Added optional `memoryMisleading`** (the RSCB false-positive / gamma term,
  the one axis the old schema lacked) to ShadowFeedbackEvent + the
  `nmg_remember` tool + controller-shadow pass-through + nmg-prompts.yaml
  (regenerated). Non-breaking for all consumers (additive, JSONL-tolerant).
- **Explicit label->outcome mapping** `contextOutcomeFromFeedback(labels)` in
  `src/lab/context-reward.ts`: priority falsePositive (memoryMisleading) >
  rejected (noMemoryNeeded) > insufficient (evidenceSufficient=false) >
  verified (evidenceSufficient=true && taskSuccess!==false; expansionUseful NOT
  required — real rows often set only evidenceSufficient); noise falls to
  rejected; no-signal / contradictory -> null (skipped, never a silent vote).
  Tests 10/10. Validated on 108 real natural feedback rows: 68 map
  (verified 35 / rejected 13 / insufficient 20), mean reward +0.124;
  memoryMisleading not yet present in old data (field just added).
- **Cost stays separated**: lambda*K is subtracted at SELECTION (Q - lambda*K),
  never in the outcome reward, else it double-counts (matches context-cost.ts
  comment). This keeps the reward minimal and correct.
- **What NOT to copy from RSCB-MC**: it optimizes only immediate single-step
  reward and explicitly does not model multi-turn/credit/H2 — that stays open
  and separate; and its pure-abstain policy over-abstains (0% answer, 42.9%
  wrong abstain), so correct use must keep a positive alpha.

## Sources
- LoCoMo ground-truth audit (penfieldlabs); AgentOS "Memory Benchmark Transparency".
- LongMemEval (ICLR 2025); "LongMemEval numbers don't compare"; LongMemEval-S
  context-window critique.
- "How to evaluate agent memory" (labelstud/MemoryArena): static recall ≠
  multi-session agentic.
- Mem0 survey: 57–71% cross-user contamination in real harnesses.
- Offline RL for adaptive policy retrieval (arxiv 2604.05125); "Optimizing
  Retrieval for RAG via RL" (NeurIPS 2025) — executed-sample / on-policy training.
