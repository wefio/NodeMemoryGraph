# Hierarchical Activation: Experimental Route and Design Boundary

[English](hierarchical-activation.md) | [简体中文](hierarchical-activation.zh-CN.md) · [Terms](hierarchical-activation.terms.yaml)

An experimental engine and an explicit scoring mode exist. The default vector route remains cosine. Session Active Graph admission, branch-scoped state, persisted training of session state, and quality-based activation gates are not established by the current path described below.

## Current source behavior

- `HierarchicalActivation` is implemented in [`src/core/hierarchical-activation.ts`](../../src/core/hierarchical-activation.ts), with focused tests in [`tests/core/hierarchical-activation.test.ts`](../../tests/core/hierarchical-activation.test.ts).
- `NmgStore.routeNodesByVector()` defaults `activationMode` to `"cosine"`. A caller may explicitly pass `"hierarchical-activation"`; the ordinary retrieval path does not select that mode by default. See [`src/core/store/graph.ts`](../../src/core/store/graph.ts) and the corresponding declaration in [`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts).
- The explicit store route passes candidate vectors to `propagate()` but does not pass neighborhood or `GraphStateSnapshot`. In that path, `g₂` falls back to `g₁`, `h₂` and `h₃` are zero-valued, and `h₁` is an EMA state. The general `propagate()` API can accept neighborhood and medium-/long-term vectors, but that capability is not wired into this store call.
- `Router.ensureHA()` keeps session-specific instances in an in-memory map keyed by `sessionId`. It does not key them by branch. `Router.toJSON()` serializes only the non-session instance; it does not serialize the session map. This is not evidence of durable or Active-Graph-owned session state.
- The store comment says a trained state should pass rollout gates before replacing deterministic retrieval. The explicit mode branch itself does not enforce a training-state or benchmark gate. Treat the comment as intent, not an enforced admission check.
- The routing method returns scored nodes; this source review did not find it performing Session Active Graph admission or updating a `ProjectionRevision`.

`HierarchicalActivation.train()` and `Router.trainHierarchical()` exist as explicit APIs. Their existence does not establish a routine product training loop, persisted session state, or quality benefit. This document asserts no test or benchmark result; consult current verification artifacts.

## Historical design intent

The earlier Chinese design proposed three spatial summaries (`g₁`, `g₂`, `g₃`), temporal state (`h₁`, `h₂`, `h₃`), and a multi-signal score to combine query similarity, graph context, and temporal context. It also proposed session/branch-isolated `h₁`, projections from STG/LTG, joint training with a differentiable controller, and eventual Session Active Graph admission. Those are design hypotheses, not the current `routeNodesByVector()` contract.

The original proposed interfaces, parameter tables, training losses, and phased roadmap have been condensed here to prevent them from being mistaken for implemented runtime behavior. Current source and tests own the implementation facts; the dated proposal remains historical context.

## Source references

- [Hierarchical activation engine](../../src/core/hierarchical-activation.ts)
- [Router and session-instance lifecycle](../../src/core/router.ts)
- [Explicit vector route and default mode](../../src/core/store/graph.ts)
- [Retrieval mixin declaration](../../src/core/store/retrieval.ts)
- [Hierarchical activation tests](../../tests/core/hierarchical-activation.test.ts)
- [Current implementation lineage](implementation-lineage.md)