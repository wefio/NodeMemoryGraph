# One state entry for AG and board spaces

[中文](2026-10-12-state-space-entry.zh-CN.md) · [Terms used](2026-10-12-state-space-entry.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Shared information output](2026-10-07-shared-information-output.md), [AG working state](2026-10-08-ag-working-state.md), [Board governance](2026-09-06-board-governance-addressing.md)

## Problem

Daily AG state maintenance is reached through a Lab capability while shared
coordination uses a separate board tool. Both expose state, but require callers
to switch entry points and conventions. A second state store or a separate view
layer would duplicate owners instead of simplifying this interface.

## Decision

The user accepts one state entry with `read/write`, an `ag/board` state-space
selector, and space-specific operations. AG and board are readable/writable
state spaces, not separate model-facing state tools. Their domain owners,
authority and lifetimes remain distinct.

State directly uses the existing typed information views and output preparation;
it does not parse rendered tool text or introduce another state-view protocol.
The canonical interface contract is [state spaces](../../design/state-spaces.md).
That topic owns syntax, dispatch, direct-view integration and migration boundaries.

The additive `state` RPC and CLI commands implement this entry. Pi, MCP and DSH
register `nmg_state` instead of `nmg_board`; model-facing Lab rejects daily
working-state operations. Legacy RPC/CLI paths remain compatible. Normal AG
writers explicitly lease the existing authority and capture the existing AG fence;
unifying the entry does not bypass enablement or create a second authorization store.

## Alternatives considered

- Keep separate AG/Lab and board model entry points: rejected for the target
  interface; callers still need multiple state-operation conventions.
- Merge AG and board into one shared store: rejected; namespace unification does
  not merge private working state with collaboration authority and lifetime.
- Add a new state view or parse existing text outputs: rejected; admitted typed
  views and source-bound output preparation already supply the common boundary.
- Require a pipeline or general-purpose scripting engine first: rejected; the
  accepted command structure provides the integration point without that machinery.

## Consequences

The state-space topic is the interface owner; existing AG and board contracts
remain the owners of mutation semantics. Implementation can reuse their methods
and projections rather than maintaining parallel behavior. Independent state
registrations converge on state, while Lab retains other experimental capabilities.

This choice adds no persistence layer and establishes no token or model-continuity
benefit. An operation acknowledgement is not collaboration acceptance, factual
support or proof of final model input. Documentation checks establish document
structure and links; contract and isolated host integration tests establish runtime
behavior only in their measured environments.

Migrating inline named tool registrations exposed a complexity-baseline identity
collision. The gate identifies these methods by the literal registration name and
callee, rather than collapsing every `execute` into one owner. Regression tests
protect independent baselines; the complexity limit of 15 is unchanged.

## Deferred

- Final provider-input confirmation remains unsupported in Pi.
- DSH's real host contribution is tested with simulated Cordis services and an
  isolated real HTTP owner; a production DSH GUI session is not established by that test.
- Natural-use continuity and token savings are not established by tool convergence.
- Legacy administrative RPC/CLI withdrawal requires a separate compatibility decision.
