# Temporal and logical memory chains: design history

[English](temporal-logical-chains-design-2026-08-13.md) | [简体中文](temporal-logical-chains-design-2026-08-13.zh-CN.md) · [Terms](temporal-logical-chains-design-2026-08-13.terms.yaml)

Historical design record dated 2026-08-13, not the current implementation contract. Current source and the linked design owners take precedence. Numeric BEAM observations and external comparisons recorded in the original note are not linked here to a reproducible run artifact and are not treated as current reproduced evidence.

This record traces the work from cross-session temporal questions to typed memory-chain structures and an optional reasoning-workspace path. The initial hypothesis that `eventTime`, `supersedes_id`, and related memories were enough was later revised: they do not express explicit ordered membership, branching, or shared membership across multiple paths. Current `MemoryChain` source defines temporal/logical chains, explicit members and DAG edges; see [`MemoryChain` types](../../src/core/types.ts), [store methods](../../src/core/store/base.ts), and the [chain retrieval path](../../src/core/store/retrieval.ts).

## Design decision snapshots

- Chain membership and edges are written explicitly; the chain structures do not infer semantic order or perform reasoning. The current store checks the DAG boundary on edge writes.
- Chain expansion is a caller-selected recall supplement (`expandChains`), not a global rerank and not an unconditional search behavior. Current options, caps, and selection code are owned by `src/core/types.ts` and `src/core/store/retrieval.ts`; detailed historical choices are in [Design convergence](temporal-logical-chains-design-2026-08-13/converged-design.md).
- Cross-domain structural analogy is a distinct advisory operation. Current source abstracts five structural patterns and ranks candidates by pattern-type Jaccard overlap; it does not update retrieval ranking or write memories/relations/chains. The implementation is in [`analogy.ts`](../../src/core/store/analogy.ts), with focused examples in [`analogy.test.ts`](../../tests/core/analogy.test.ts). A fixture score is not a general quality result; see [Cross-domain analogies](temporal-logical-chains-design-2026-08-13/cross-domain-analogies.md).
- `MemoryGraphReasoner` remains in `src/lab` and has an optional Lab invocation path. The Pi Lab tools are gated by `NMG_ENABLE_LAB_TOOLS=1`; the reasoner is not part of the default `searchContext` retrieval pipeline. Do not restate the earlier unqualified “never wired into runtime” label as current behavior.
- `ReasoningWorkspace` is a separate, session-keyed scratch workspace persisted by the daemon under its Lab data directory. It is not an LTG memory chain. Board channels are not private: `taskId` is the shared channel boundary. A name such as `scratch:<agentId>` does not add an access-control boundary; use the session-scoped workspace for non-shared scratch (it is not an OS-level access-control boundary) and explicitly publish only content intended for a shared board.

## Historical evidence and research boundary

The original note reported specific BEAM weaknesses and used them to motivate improvements; the underlying run artifact is not linked from this retained record. Treat those values as dated reported observations, not a reproduced baseline or evidence that chain design improves quality. The original literature/platform comparisons are retained as design context in [Design convergence](temporal-logical-chains-design-2026-08-13/converged-design.md) and [Cross-domain analogies](temporal-logical-chains-design-2026-08-13/cross-domain-analogies.md); they are citations and analogies, not NMG implementation proof.

The record also contains historical notes about the user assessment of the reasoning workspace and proposed ways to share scratch material. Those notes are not current user feedback or an authorization for new board privacy behavior. Current runtime and addressing rules are defined by the code and the [Task Board contract](../../skills/nmg-memory/references/board.md).

## Current source entry points

- Chain types and contracts: [`src/core/types.ts`](../../src/core/types.ts).
- Persistence, membership, edges, and cycle checks: [`src/core/store/base.ts`](../../src/core/store/base.ts).
- Optional chain expansion and its current bounds: [`src/core/store/retrieval.ts`](../../src/core/store/retrieval.ts).
- Session reasoning workspace: [`src/integration/reasoning-workspaces.ts`](../../src/integration/reasoning-workspaces.ts), [`src/lab/reasoning-workspace.ts`](../../src/lab/reasoning-workspace.ts), and [`src/cli/service.ts`](../../src/cli/service.ts).
- Reasoner implementation and optional Lab invocation: [`src/lab/memory-graph-reasoner.ts`](../../src/lab/memory-graph-reasoner.ts), [`src/cli/service.ts`](../../src/cli/service.ts), and the Pi tool gate in [`.pi/extensions/nmg/index.ts`](../../.pi/extensions/nmg/index.ts).

See also the [implementation lineage](implementation-lineage.md) and the current [active-graph design](design/active-graph-activation-and-consolidation.md).