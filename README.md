# Node Memory Graph (NMG)

NMG is a local-first long-term memory layer for the [Pi agent harness](https://github.com/earendil-works/pi). It stores mutable semantic memory over immutable evidence and retrieves a small, progressively deeper subset instead of flattening all history into one global prompt.

The current prototype focuses on the semantic memory contract before storage
optimization:

- SQLite is the local source of truth.
- Facts, preferences, constraints, states, events, strategies, and
  conversational evidence have distinct types and usage rules.
- Stable user-stated facts, preferences, constraints, and states are written
  automatically; explicit writes remain available.
- Completed Pi turns checkpoint the session transcript as cold, immutable
  evidence without turning every message into semantic memory.
- Pi automatically injects a few L0/L1 memories before each agent run.
- Stable `stateKey` values identify replaceable state across sessions and
  automatically supersede the prior active value in the same scope.
- Typed node relations and multi-evidence derived memories support graph-aware
  retrieval instead of treating every memory as an isolated chunk.
- `nmg_search` can expand related nodes and returns the underlying evidence.
- Scope, validity intervals, conflicts, and superseded states remain
  traceable instead of deleting earlier evidence.
- Cloud sync, embeddings, learned routing, and sandbox execution are deferred.

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

In Pi, the model receives four tools and a typed write/use policy:

- `nmg_remember`: save a typed long-term memory with scope, truth status,
  event time, stable state identity, evidence role, and provenance.
- `nmg_search`: retrieve composed context from matching and graph-adjacent
  nodes, with tier, scope, conflict, and historical-state controls.
- `nmg_derive`: form a new conclusion from at least two existing memories while
  retaining every transitive evidence reference.
- `nmg_link`: add a typed semantic relation between two memory nodes.

The automatic-write rule is intentionally narrow:

- Save clear, stable user-stated facts, preferences, constraints, and states
  that are likely to help in a later session.
- Ask before saving ambiguous, inferred, uncertain, or current-task-only
  information.
- Never save casual chatter, duplicates, unverified model claims, credentials,
  secrets, or sensitive personal data as semantic memory.
- Give replaceable states a stable `stateKey`; a new value in the same canonical
  scope automatically supersedes the old state without deleting its evidence.
- Treat assistant-authored conversational evidence as unverified unless a user
  or tool confirms it.
- Obey constraints, adapt to preferences, use only the newest active state,
  preserve event time, and describe conversational evidence as something that
  was said rather than as independently verified truth.

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

The Agent-to-Agent-style regression suite runs independent cases in parallel.
Within each case, a Writer Pi process receives a user turn and a fresh Reader
Pi process attempts recall from the same isolated NMG database.

```powershell
npm run eval:agents
```

The suite pins `deepseek/deepseek-v4-flash`, uses low thinking, verifies actual
tool completion, session archives, SQLite evidence, recall, and negative write
policy behavior. Current cases cover explicit hot/cold memory, automatic stable
preferences, project constraints, transient instructions, and synthetic
secrets. Reports are written under ignored `evals/results/`.

### LongMemEval

The official cleaned LongMemEval-S and oracle datasets can be placed under
`evals/longmemeval/data/`. The adapter supports deterministic, matched
No-Memory, Oracle, and NMG-over-Oracle development runs:

```powershell
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
```

See [evals/longmemeval/README.md](evals/longmemeval/README.md) for methodology,
limitations, and the initial seven-question smoke-test results.

Example request to the agent:

```text
Remember that NMG uses Pi as its agent harness and SQLite as its local source of truth.
```

## Security boundary

NMG is a memory component, not a sandbox. Pi extensions run with the permissions of the Pi process. The MVP does not execute arbitrary code and does not require Docker. If untrusted execution is added later, it belongs behind a separate `ExecutionBackend`; Docker is the initial candidate, not a core dependency.
