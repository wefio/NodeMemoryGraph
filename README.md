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

Example request to the agent:

```text
Remember that NMG uses Pi as its agent harness and SQLite as its local source of truth.
```

## Security boundary

NMG is a memory component, not a sandbox. Pi extensions run with the permissions of the Pi process. The MVP does not execute arbitrary code and does not require Docker. If untrusted execution is added later, it belongs behind a separate `ExecutionBackend`; Docker is the initial candidate, not a core dependency.

