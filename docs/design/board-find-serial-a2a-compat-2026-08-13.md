# Board Discovery, Direct Delivery, and Serial Handoff (2026-08-13)

[English](board-find-serial-a2a-compat-2026-08-13.md) | [简体中文](board-find-serial-a2a-compat-2026-08-13.zh-CN.md) · [Terms](board-find-serial-a2a-compat-2026-08-13.terms.yaml)

Historical design record. This note captures the collaboration boundaries proposed while adding local agent discovery and handoff. It is not the current RPC/schema reference and does not establish full A2A protocol compatibility. Use the current owners below for behavior and interfaces.

## Design distinctions

The 2026-08 proposal separated four operations that must not be conflated:

1. **Discover** identifies available agents/capabilities without treating a broadcast as an instruction for every agent's LLM to start work.
2. **Direct delivery** uses an explicit stable agent name (`to=<agent>`); it is distinct from session identity and from a broadcast visible to subscribers.
3. **Delivery/acknowledgement** records arrival or reading; neither means the recipient accepted responsibility.
4. **Claim, resolve, and expiry** represent ownership and lifecycle transitions. A serial handoff may gate later work on these transitions; direct assignment is a separate case.

The proposal borrowed discovery vocabulary from A2A but explicitly kept the local Task Board's coordination model. It did not propose replacing the board with A2A Task/Message structures or requiring a network server per local agent.

## Evidence and compatibility boundary

This is a dated design summary, not proof of the current schema or runtime guarantees. In particular, the original field-by-field Agent Card mapping and “future gateway needs only format conversion” claim are not treated as established contracts here. A local `agent_name`, capability registry, or JSON-RPC transport does not by itself establish A2A conformance.

## Current owners

- [Shared Task Board boundaries](memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board.md)
- [Task-unit collaboration and product entry](task-unit-semantics-obligations/collaboration-product-entry.md)
- [NMG memory skill: Board operations](../../skills/nmg-memory/references/board.md)
- Current store/integration sources under [`src/core/store/`](../../src/core/store/) and [`src/integration/`](../../src/integration/)

Use those owners for the current API, persistent state, and product-versus-research boundary. This historical note does not duplicate their detailed state machine.