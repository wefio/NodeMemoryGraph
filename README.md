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
- Pi uses three execution layers: a small query-independent resident kernel,
  dynamic automatic recall for explicit memory questions, and compressed recall
  cues that let the agent decide whether to call `nmg_search`.
- Ordinary prompts load no dynamic long-term memory. Automatic retrieval
  overfetches and type-reranks candidates before applying the final record budget.
- Stable `stateKey` values identify replaceable state across sessions and
  automatically supersede the prior active value in the same scope.
- Typed node relations and multi-evidence derived memories support graph-aware
  retrieval instead of treating every memory as an isolated chunk.
- Duplicate nodes can be merged and over-broad nodes split without deleting
  memories or evidence; source-to-target redirects preserve old addresses.
- `nmg_search` returns compact result headers; `nmg_get` expands only selected
  memory IDs into exact statements and source evidence.
- Node-local access counts are accumulated and periodically rebuilt into
  Huffman-derived block tiers, keeping likely memories shallow without deleting
  cold history.
- New or moved memories enter a persistent SQLite Delta and remain searchable
  before leaf compaction. Dirty nodes rebuild locally; unchanged content-derived
  leaf IDs retain their existing external embeddings.
- Scope, validity intervals, conflicts, and superseded states remain
  traceable instead of deleting earlier evidence.
- Cloud sync, external embedding models, and sandbox execution are deferred.

## Architecture

```text
Pi agent harness
      │
      │ before_agent_start + tools
      ▼
NMG Pi extension
      │
      ▼
NMG core ── MemoryNode graph ── tiered MemoryRecord
      │          │                    │
      │     online router       vector embedding
      │          └──────┬─────────────┘
      └────────────── SQLite ──────────┘
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
pi install <path-to-node-memory-graph>
pi
```

By default, the extension stores data in `.nmg/nmg.sqlite` under the current project. Set `NMG_DATA_DIR` to use another directory.

By default, the model receives three tools and a typed write/use policy:

- `nmg_remember`: save a typed long-term memory with scope, truth status,
  event time, stable state identity, evidence role, and provenance.
- `nmg_search`: retrieve compact headers and stable IDs from matching and
  graph-adjacent nodes, with tier, scope, conflict, and historical-state controls.
- `nmg_get`: expand selected IDs into exact memory statements and bounded source
  evidence.

Set `NMG_ENABLE_LAB_TOOLS=1` before starting Pi to expose the experimental
maintenance surface:

- `nmg_derive`: form a new conclusion from at least two existing memories while
  retaining every transitive evidence reference.
- `nmg_link`: add a typed semantic relation between two memory nodes.
- `nmg_organize`: merge duplicate nodes or split an over-broad node using an
  explicit, complete memory partition.
- `nmg_feedback`: train the local online node router from useful-query feedback.
- `nmg_rebalance`: batch-rebuild node-local block tiers from accumulated access
  probability statistics.

For one-off development inside this repository, run
`pi -e ./.pi/extensions/nmg/index.ts`; Pi deduplicates this project-local entry.

The built-in `HashingVectorEmbedder` is deterministic, offline, and intended as
the zero-configuration baseline. `NmgStore` accepts any synchronous
`VectorEmbedder`, so a semantic embedding provider can replace it; call
`rebuildVectorIndex()` after changing models.

The automatic-write rule is intentionally narrow:

- Save clear, stable user-stated facts, preferences, constraints, and states
  that are likely to help in a later session.
- Ask before saving ambiguous, inferred, uncertain, or current-task-only
  information.
- Never save casual chatter, duplicates, unverified model claims, credentials,
  secrets, or sensitive personal data as semantic memory.
- Give replaceable states a stable `stateKey`; a new value in the same canonical
  scope automatically supersedes the old state without deleting its evidence.
- Preserve separately countable actions as separate memories and retain an exact
  source excerpt: the statement is a retrieval summary, not the evidence itself.
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

The local three-layer regression currently passes 6/6 cases. Dynamic-context
measurement reports approximately 74% fewer characters for recall cues than a
full eight-memory block; the resident kernel remains a separate fixed budget.

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

### Scale and cache breakthrough

`npm run eval:scale` runs the same queries at 100, 1K, 10K, and 100K memories,
placing the answers before newer distractors so cold evidence falls outside the
legacy 500-row working set. It reports accuracy, returned-token estimate,
P50/P95 latency, tier hit rate, ingestion throughput, and index maintenance
cost. See [evals/scale/README.md](evals/scale/README.md).

The local retrieval controls are SQLite FTS5, deterministic hashing vectors,
Qwen3 vectors served through an OpenAI-compatible endpoint, and their hybrid.
Qwen3 uses a resumable batch indexer; USearch provides the persistent HNSW ANN
index only after the scale test demonstrates scan cost. Setup is documented in
[docs/qwen3-vllm.md](docs/qwen3-vllm.md).

Example request to the agent:

```text
Remember that NMG uses Pi as its agent harness and SQLite as its local source of truth.
```

## Security boundary

NMG is a memory component, not a sandbox. Pi extensions run with the permissions of the Pi process. The MVP does not execute arbitrary code and does not require Docker. If untrusted execution is added later, it belongs behind a separate `ExecutionBackend`; Docker is the initial candidate, not a core dependency.
