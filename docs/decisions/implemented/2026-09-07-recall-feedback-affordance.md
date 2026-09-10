# Attach the online feedback ask to every recall (not a scheduled auto-only nudge)

**Status:** implemented  
**Approved:** unrecorded
Date: 2026-09-07
Branch: pr/feedback-affordance

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) — this change to a standing feedback/staging convention is itself recorded as a governed decision.

中文版: [2026-09-07-recall-feedback-affordance.zh-CN.md](2026-09-07-recall-feedback-affordance.zh-CN.md)

## Problem

The online context-use feedback loop (RSCB-style, daemon-owned `ContextRouter`
learner) produced almost no trustworthy training signal, and the little it did
produce was mis-attributed:

1. **Elicitation was a fragile one-shot nudge.** `online_feedback_nudge` was
   armed only when an *automatic pre-turn* recall injected memory, then shown
   once on the next user turn and cleared on feedback or session end. It never
   fired for the model's own explicit `nmg_search` calls — which are the primary
   way a model actually retrieves under a "the model decides whether to recall"
   design — so the dominant recall path had no ask point at all.
2. **Only `autoRecall` searches staged.** An explicit search surfaced content,
   was used, and got feedback, but its graph was never staged. The feedback then
   fell through to a session-scoped fallback.
3. **The fallback was a mis-attribution machine.** `recordFeedback` without an
   explicit `activeGraphId` bound to `latestStagedGraph(session)` — whatever the
   session happened to have staged most recently, which was usually an unrelated
   recall. Observed: a positive weather-recall rating trained the router on an
   earlier design-doc turn's decision, silently. This is systemic, not one-off:
   every feedback about an explicit search either mis-binds or is skipped.

## Decision

1. **The feedback ask is a property of recall output, allowed on every recall.**
   Each recall surface — the automatic pre-turn injection and the model's own
   `nmg_search` results (pi), and each recall snapshot at first presentation
   (dsh) — carries a compact affordance that names the `activeGraphId` being
   rated and invites `nmg_remember action=feedback`. No one-shot next-turn
   scheduler, no session-scoped state machine.
2. **Every disclosure search stages.** The daemon stages any search that surfaced
   a disclosure graph (auto and explicit alike); `persistTrace:false` internal
   probes opt out.
3. **Feedback binds by the graph it names — nothing else.** `recordFeedback`
   trains only the explicit `activeGraphId` it is given. The session-latest
   fallback is removed; absent an explicit graph, feedback is skipped rather
   than mis-bound.

## Consequences

- The weather-style failure is addressed on the *presentation* axis: an explicit
  search that surfaces content can now be rated and trains the correct graph.
- The earlier auto-only gating and the `latestStagedGraph` fallback are removed
  (`src/lab/context-router-online.ts`, `src/cli/service.ts`).
- Whether to recall at all remains the model's call (see the trigger-regime
  design); a cheap lexical detector may raise a candidate but never decides.
  The neural `ContextRouter` is deliberately not the pre-search trigger — its
  defensible role is post-search content/escalation control, which needs this
  cleanly-bound per-use data before it is worth training.
- Adapter-local queue state (`onlineFeedbackPending` pi, `onlineNudgeQueue` dsh)
  is deleted; the affordance text lives once in `src/prompts/nmg-prompts.yaml`
  (`recall_feedback_affordance`).

## Alternatives considered

- **Keep the one-shot auto-only nudge, broaden to explicit searches.** Rejected:
  it preserves a scheduling state machine that (a) misses recalls that never
  arm it and (b) still relies on a next-turn reminder rather than the recall
  being rateable at the moment it is shown.
- **Bind via controller-shadow attribution traces only.** Rejected for the
  online trainer: attribution is derived from which memories the answer used,
  which is a different (shadow/coverage) dataset and not the per-decision
  features the online router trains on.
- **A session-latest fallback guarded to "only when unambiguous".** Rejected:
  ambiguity is exactly the failure mode; an explicit graph id on the surface is
  always available, so a fallback adds risk with no benefit.
- **Mechanical end-of-turn labeler (option B) as the ask itself.** Deferred, not
  rejected: deriving labels from answer-overlap never needs an ask and is a good
  cold-start complement, but it cannot judge quality dimensions (noise,
  misleading). Kept as the documented follow-up if affordance responses
  under-produce.

## Evidence

- `tests/cli/context-online-rpc.test.ts` — any disclosure search stages,
  `persistTrace:false` probes do not, feedback without an explicit graph does not
  train.
- `tests/extensions/nmg/context-router-online.test.ts` — `consumeFeedback` binds
  by exact graph id with no session-scoped fallback.
- Live shadow-events audit (2026-09-07): all three that day rated explicit-search
  graphs; two of three mis-bound or were skipped under the old fallback.
