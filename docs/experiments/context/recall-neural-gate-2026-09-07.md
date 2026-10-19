# Neural Recall Gate: Historical Proposal and Feedback Observation (2026-09-07)

[English](recall-neural-gate-2026-09-07.md) | [简体中文](recall-neural-gate-2026-09-07.zh-CN.md) · [Terms](recall-neural-gate-2026-09-07.terms.yaml)

**Status:** Historical proposal, not an adopted product design. The original note also records a dated feedback-generation observation. Neither its proposed pre-probe/neural gate nor its 2026-09 counts should be treated as current behavior without checking current owners.

## Proposal: decide whether a cheap probe merits disclosure

The note identified a limitation in a keyword-first auto-recall gate: a turn with no intent keyword could be routed to `none` before the system checked whether useful memories existed. It proposed a small FTS top-k pre-probe, followed by a decision to leave the turn at `none`, inject a small `cue`, or perform fuller `retrieve` disclosure. The claimed cost separation was: lexical probing is cheap; semantic expansion and context injection carry more latency, token, and distraction cost.

The proposed decision would combine probe evidence, the existing intent classification, turn/session context, and prior feedback. It explicitly distinguished a per-turn “inject anything?” decision from per-item ranking or disclosure mechanisms such as QPP/QPP2. The suggested rollout was shadow measurement before any actuation, with no second independent gate model.

## Additional research seam: global pool context

A separate section proposed a low-dimensional “virtual node” or global-view channel for per-item pool decisions, while rejecting it as a fit for the per-turn gate. The note marked it experimental, with no code and no implementation commitment. Its stated trigger was evidence that the same memory's utility changes across candidate pools, followed by shadow comparison against independent per-item scoring.

## Dated feedback-generation observation

The note records that on 2026-09-07 the user reported zero real-session `nmg_remember(action=feedback)` calls; the author says this was checked and that the only row in `context-router-online.json` came from a manual HTTP test. It contrasts that with 125 earlier controller-shadow feedback rows (109 natural and 16 controlled, per the note), generated with a feedback nudge.

This is a dated observation, not a current count. The note's options—one-shot nudge, conservative observable-outcome labels, and sparse LLM self-evaluation—were proposals; its recommended combination was not a record of approval or implementation. Answer overlap alone was explicitly considered insufficient to manufacture a usefulness label.

## Current owners

- [Retrieval confidence controller](../../design/retrieval-confidence-controller.md)
- [Feedback-loop design](../../design/feedback-loop-design.md)
- [Current retrieval and gate implementation](../../../src/core/gate.ts)
- [Controller and feedback implementation](../../../src/lab/)

Consult these owners and current tests for present behavior. The original external-research summary and milestone plan are not repeated here: they were time-bound exploration, not NMG implementation evidence.