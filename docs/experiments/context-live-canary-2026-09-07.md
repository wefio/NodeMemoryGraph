# Context live canary: wiring real main-model exposure through the official grader

**Date:** 2026-09-07
**Status:** exploratory wiring canary — **not** an effectiveness claim, not a benchmark.
**Owner context:** agent-convergence-feedback-design (§9), phase after #25.

## Purpose

Answer the prerequisite question: can the offline-designed intervention actions
(`none` / `cue` / `retrieve`) be executed against a **real main model** end to end
and judged by the **official** OmniMemEval grader — with exact capture at the
model `create()` boundary?

The #25 offline probe used only a custom lexical scorer and estimated
character/4 tokens; no real LLM ever consumed an intervention's context. This
canary closes that seam for a tiny fixed question set.

It is deliberately **not** an efficacy or strategy comparison: n=3, single model,
temporal-only questions, and replay of a historical retrieval artifact.

## Setup and artifacts

- Code: `evals/omnimemeval/research/context-live-canary.py` (+ no-network dry-run
  tests in `tests/evals/context-live-canary.test.ts`).
- Config (gitignored local): `.nmg/context-live-canary.config.json`; env derived
  from `.env` (never committed, never printed).
- Retrieval context: replayed from an existing search artifact
  `results/locomo/nmg-locomo_20260831T104024Z/nmg_locomo_search_results.json`.
- Dataset: official `OmniMemEval/data/locomo/locomo10.json`.

## Design

### Three arms (same `(group, question)`, same model, only the injected context changes)

| Arm | Context | Notes |
| --- | --- | --- |
| `none` | `""` | no memory content at all |
| `cue` | one short literal (`CONTEXT_CUE`) | no concrete memory |
| `retrieve-replay` | the question's full non-empty search context (≤12000 chars) | replayed, not a live retrieval |

All three are injected via the official `LOCOMO_ANSWER_PROMPT.format(context=.., question=..)`
then call the model.

### Question selection (deterministic, never by score)

1. First `3` distinct `locomo_exp_user_N` groups in numeric order.
2. Within a group, take the **order-first** question whose search context is
   non-empty and ≤ `maxContextChars`, and whose dataset category is not `5`.
3. Chosen: g0/g1/g2, all temporal ("When did ..."), gold = a specific date.

### Model and grading

- Model: official `create_async_openai_client("ANSWER")` → `deepseek-chat`
  (same provider/model is used for answer and judge here; in this env
  `ANSWER_MODEL == EVAL_MODEL == deepseek-chat`, so no deviation is material).
- Judging: official `locomo_grader`, not a custom scorer.
- Capture: a client-side proxy around `chat.completions.create` records the real
  `messages`, `messagesHash`, `usage`, and per-call duration; one record per answer
  and per judge.

### Hard constraints baked into the design

- Retrieval is **replayed**: metadata marks `retrievalLive=false`,
  `source=replayed-context`; no retrieval cost is observable and no executor call
  count is fabricated.
- No training/admission labels are generated (`admitContextIntervention` is not
  called).
- At most 9 answers + 9 judges; per-call timeout ≤ 120 s; errors are recorded and
  never zero-filled; each run gets a fresh non-overwriting directory; env/secrets
  are never printed.

## Live result

Run dir (ignored local): `.nmg/canary-out/context-live-canary-20260907T051333230591Z`
(9 answers + 9 judges, all succeeded, usage recorded).

| Group / Q | none | cue | retrieve-replay | gold |
| --- | --- | --- | --- | --- |
| g0 Caroline (LGBTQ support group) | 12 Mar 2023 ✗ | "need memories" ✗ | **7 May 2023 ✓** | 7 May 2023 |
| g1 Jon (lost job as banker) | 12 Mar 2023 ✗ | "no memories" ✗ | **19 Jan 2023 ✓** | 19 Jan 2023 |
| g2 Maria (donated car) | 12 Mar 2023 ✗ | "need memories" ✗ | 22 Dec 2022 ✗ | 21 Dec 2022 |

Judge outcome: none 0/3, cue 0/3, retrieve-replay 2/3.

An earlier run failed with 401 (expired key in a stale `snapshot_eval.env`); it
was retried with a current key from `.env`. The failure was recorded, not
zero-filled, and confirmed the error path behaves as designed.

## What this does and does not establish

**Establishes:** the "decision → real model exposure → official grading → usage"
path is wired end to end and auditable; three context regimes produce distinct,
internally consistent behavior on a real model (no memory → hallucinate a fixed
date or honestly refuse; retrieval present → answer the factual date).

**Does NOT establish:** that `retrieve` is better than `none`/`cue`. n=3, single
model, temporal-only questions, and non-live retrieval are insufficient for any
statistical or activation claim. No default activation, no strategy conclusion.

## Why this is recorded but not submitted

The user's guidance: this result has no standalone value yet and should not be
rushed into a commit/PR. It is wiring scaffolding, not a feature milestone. The
canary source and test remain uncommitted on the working branch until they carry
real value (e.g. a pre-registered, larger, same-model matched comparison, or when
the router / sequential-history decision is actually attached to this chain).

## Follow-ups (non-blocking)

- Pre-registered larger matched comparison (arm × same model, more groups,
  explicit metric/margin) before any strategy or default-activation claim.
- Attach `runContextTrial` / `ContextRouter` to this real chain, including
  sequential-history and actual (non-replay) retrieval.
- Independent external verifier adapter for reward/cost authenticity (not the
  same-evaluator component scorer).
