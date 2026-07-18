# Node Memory Graph (NMG)

NMG is a local-first long-term memory layer for the [Pi agent harness](https://github.com/earendil-works/pi). It stores mutable semantic memory over immutable evidence and retrieves a small, progressively deeper subset instead of flattening all history into one global prompt.

The first prototype intentionally has a narrow scope:

- SQLite is the local source of truth.
- Memories are written explicitly through `nmg_remember`.
- Pi automatically injects a few L0/L1 memories before each agent run.
- `nmg_search` can search deeper tiers and returns evidence references.
- Cloud sync, embeddings, automatic extraction, learned routing, and sandbox execution are deferred.

## Architecture

```text
Pi agent harness
      │
      │ before_agent_start + tools
      ▼
NMG Pi extension
      │
      ▼
NMG core ── MemoryNode ── tiered MemoryRecord
      │                         │
      └──────── SQLite ─────────┘
                    │
             immutable HistoryRecord
```

See [docs/design.md](docs/design.md) for the decisions and roadmap.

## Try it

Requirements: Node.js 22.19 or newer and Pi.

```powershell
npm install
npm test
npm run check
pi -e ./.pi/extensions/nmg/index.ts
```

By default, the extension stores data in `.nmg/nmg.sqlite` under the current project. Set `NMG_DATA_DIR` to use another directory.

In Pi, the model receives two tools:

- `nmg_remember`: save a confirmed long-term memory with its evidence.
- `nmg_search`: retrieve memories with a tier and result budget.

## Headless Pi control

NMG uses Pi's native RPC mode for automated Agent-to-Agent-style tests. This
keeps the controller local and avoids adding an A2A server before cross-machine
interoperability is needed.

Inspect the configured model without making a model request:

```powershell
npm run pi:state
```

Send one prompt through a fresh headless Pi session:

```powershell
npm run pi:prompt -- "Remember that the RPC controller is used for NMG tests."
```

Each invocation uses a new Pi session but shares the project's
`.nmg/nmg.sqlite`, which makes cross-session memory tests straightforward.

## Agent evaluation

The first Agent-to-Agent-style regression suite runs independent cases in
parallel. Within each case, a Writer Pi process stores a memory and a fresh
Reader Pi process attempts to recall it from the same isolated NMG database.

```powershell
npm run eval:agents
```

The suite pins `deepseek/deepseek-v4-flash`, uses low thinking, verifies actual
tool completion and SQLite evidence, and writes ignored reports under
`evals/results/`.

Example request to the agent:

```text
Remember that NMG uses Pi as its agent harness and SQLite as its local source of truth.
```

## Security boundary

NMG is a memory component, not a sandbox. Pi extensions run with the permissions of the Pi process. The MVP does not execute arbitrary code and does not require Docker. If untrusted execution is added later, it belongs behind a separate `ExecutionBackend`; Docker is the initial candidate, not a core dependency.
