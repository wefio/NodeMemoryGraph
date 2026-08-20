# Node Memory Graph (NMG)

NMG is a local-first long-term memory layer with modular harness adapters. The
first adapter targets the [Pi agent harness](https://github.com/earendil-works/pi),
while Agent-independent integration modules own evidence admission, retrieval,
and configuration. NMG stores mutable semantic memory over immutable evidence
and retrieves a small, progressively deeper subset instead of flattening all
history into one global prompt.

The current prototype focuses on the semantic memory contract before storage
optimization:

- SQLite is the local source of truth.
- Facts, preferences, constraints, states, events, strategies, and
  conversational evidence have distinct types and usage rules.
- Memory type, scope, and influence permission are orthogonal: presentation
  preferences cannot change facts, behavioural signals remain non-binding, and
  constraints apply only inside their active scope.
- Repeated outcome-linked episodes may consolidate into transferable
  experience. NMG returns its situation, outcome, applicability, limitations,
  counterexamples, and evidence, but never creates or silently updates a Skill,
  prompt, runbook, script, or other behavioural artifact.
- Stable user-stated facts, preferences, constraints, and states are written
  automatically; explicit writes remain available.
- Governed memory writes retain the supporting Pi message or a bounded exact
  excerpt by stable source identity; ordinary conversation, cumulative
  transcripts, and transient tool output are not copied into NMG.
- Pi uses three execution layers: a small query-independent resident kernel,
  dynamic automatic recall for explicit memory questions, and compressed recall
  cues that let the agent decide whether to call `nmg_search`.
- Ordinary prompts load no dynamic long-term memory. Automatic retrieval
  overfetches and type-reranks candidates before applying the final record budget.
- Stable `stateKey` values identify one replaceable property—not a topic or
  grouping tag—and automatically supersede the prior active value in the same
  scope.
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
- Persisted vectors use Float32 BLOBs and are loaded into disposable contiguous
  in-memory caches with geometric append capacity; SQLite remains authoritative.
- Retrieval traces accumulate ambiguity, fallback, conflict, and co-retrieval
  signals. Lab maintenance can propose evidence-backed links or node splits;
  proposals require repeated observations and explicit acceptance before the
  semantic graph changes.
- Scope, validity intervals, conflicts, and superseded states remain
  traceable instead of deleting earlier evidence.
- Cloud sync is deferred. External embeddings are optional and served through
  an OpenAI-compatible endpoint; execution isolation remains a Pi plugin concern.
- An experimental framework-free differentiable controller uses a small lazy
  UOp graph for node, edge, STOP/EXPAND, and Active Graph budget learning. It is
  a Lab primitive and does not replace deterministic routing by default.

## Architecture

```text
Pi agent harness
      │
      │ before_agent_start + tools
      ▼
NMG Pi extension
      │
      │ persistent local HTTP client
      ▼
NMG daemon ── NMG core ── MemoryNode graph ── tiered MemoryRecord
      │          │                    │
      │     online router       vector embedding
      │          └──────┬─────────────┘
      └────────────── SQLite ──────────┘
                    │
             immutable HistoryRecord
```

See [docs/design/design.md](docs/design/design.md) for the decisions and roadmap.

## Claude Code plugin

A local MCP plugin ships with the repository for zero-config Claude Code use:

```
claude-plugins/nmg-memory/
├── .claude-plugin/plugin.json   # Plugin metadata
└── agents/memory-copilot.ts     # MCP server (< 130 lines)
```

**How it works**

The root `.mcp.json` registers `nmg` as a local MCP server. Claude Code
auto-discovers it at session start and exposes three tools:

| Tool | Purpose |
|------|---------|
| `nmg_search` | Return compact memory headers (mid/node/type/tier/preview) |
| `nmg_get` | Load exact memory statements and source evidence |
| `nmg_remember` | Save durable facts/preferences/states/constraints/events |

Daemon lifecycle is automatic: the MCP server starts the NMG daemon when it
launches and safely stops it on exit. If a daemon was already running (e.g.,
from another Agent), it is reused and left untouched.

**Output is purposefully compact** — tab-separated single-line result headers
and excerpt-only evidence — to constrain token consumption.

**Quick start**

```powershell
npm install
npx claude   # .mcp.json is auto-discovered inside the project
```

No explicit plugin install is required. After the first connection approval,
NMG memory is available in every session under this project.

## Try it

Requirements: Node.js 22.19 or newer and Pi.

```powershell
npm install
npm test
npm run check
pi install <path-to-node-memory-graph>
pi
```

By default, the extension stores shared LTG and Task Board data in
`~/.nmg/nmg.sqlite`. Set `NMG_DATA_DIR` to use another directory. Project-local
`.nmg/` data is reserved for isolated STG sessions and controlled/headless runs.

The Pi adapter is deliberately thin. It lazily starts the local daemon over
JSON-RPC/HTTP, reuses one connection for automatic recall and four stable
tools, and stops the daemon at session shutdown only when that adapter
invocation started it.
An already-running shared daemon is left untouched.
To avoid repeatedly injecting the same memory, the adapter keeps a
session-local in-memory window for the last 12 turns (at most 128 memory
references). Repeated unchanged content is folded to its stable ID; deeper
disclosure, changed evidence, window expiry, or a different session permits
reinjection. This cache is discarded at session shutdown and is never stored
as LTG.

The Pi extension keeps authoritative LTG in `NMG_DATA_DIR` or
`~/.nmg/nmg.sqlite` and uses `<project>/.nmg/sessions/<session-hash>/stg.sqlite` for the current
working directory's isolated STG. Set `NMG_PROJECT_DIR` only when the project
root differs from Pi's working directory.

By default, the model receives four tools and a typed write/use policy:

- `nmg_remember`: save a typed long-term memory with scope, truth status,
  event time, stable state identity, evidence role, and provenance.
- `nmg_search`: retrieve compact headers and stable IDs from matching and
  graph-adjacent nodes, with tier, scope, conflict, historical-state controls,
  and the session-owned `activeGraphId` for follow-up attribution.
- `nmg_get`: expand selected IDs into exact memory statements and bounded source
  evidence. Passing the `activeGraphId` returned by `nmg_search` records those
  selected IDs as actually used; another session cannot read or update that AG.
- `nmg_board`: exchange temporary, task-scoped notes between agents through
  attributed entries, TTL expiry, incremental cursors, and explicit resolution.
  Board entries are not LTG memories and never enter semantic retrieval.

Graph maintenance, QPP, indexing, and experimental reasoning components remain
core/CLI concerns rather than Pi tools. The adapter never opens SQLite or
imports those implementations directly.

For one-off development inside this repository, disable automatic extension
discovery and load NMG exactly once:

```powershell
pi --no-extensions --extension ./.pi/extensions/nmg/index.ts
```

Loading the package manifest, project-local extension, and an explicit
`--extension` together can register duplicate tools and stall tool loops.

## Agent-independent CLI

The package includes a TypeScript `nmg` executable.
The CLI is the agent-neutral fallback and administrative surface, especially
for harnesses with no plugin or an incomplete adapter. Internal retrieval
mechanisms do not each receive a dedicated command; they compose behind the
stable `search/get/remember` surface unless explicit administration is needed.

During repository development, use the equivalent npm command:

```powershell
npm run cli -- status
npm run cli -- remember "User prefers concise answers" --node "Response preferences" --type preference
npm run cli -- search "How should answers be written?"
npm run cli -- get <memory-id>
npm run cli -- retention candidates
npm run cli -- retention archive <memory-id>
npm run cli -- retention quarantine <memory-id> --recovery-days 30
npm run cli -- retention restore <memory-id>
npm run cli -- memory delete <memory-id>
npm run cli -- topology proposals
npm run cli -- topology assess <proposal-id>
npm run cli -- topology review <proposal-id> --decision accept
npm run cli -- topology actuate <proposal-id>
npm run cli -- graph --out memory-graph.html
npm run cli -- stg sync --project-dir . --scope project=nmg --limit 50
npm run cli -- daemon start
npm run cli -- daemon status
npm run cli -- daemon stop
```

Installed packages expose the same commands directly as `nmg`; the published
CLI runs precompiled JavaScript and does not type-strip files from
`node_modules`. Use `--json`
for the complete structured result, `--data-dir` to select an NMG data
directory, or `--db` to select one SQLite file. `remember` requires a stable
`--node` name; `--scope key=value` is repeatable. Pass `--project-dir` to
`remember`, `search`, and `get` when they may touch isolated STG. `stg sync`
copies a usage-ranked scoped LTG working set into that STG idempotently; LTG
remains authoritative.

CLI `remember` writes are attributed to submission channel `user` by default;
adapter/RPC callers default to `agent` and should set `writeSource` explicitly
when forwarding another channel. This is independent from `sourceActor`, which
states who authored the evidence content. `nmg claim outcome` can retain an exact
user/tool excerpt with `--evidence`, `--session-id`, and `--source-lineage`; its
event then remains auditable even if the original harness transcript disappears.

Project STG is also session-private. Pi supplies its session ID automatically;
CLI callers may add `--session-id ID`. Without it, CLI uses a separate `cli`
administrative session rather than reading any Pi session's STG.

`nmg graph` exports the node/relation projection as a single self-contained
HTML file (default `nmg-graph.html`, override with `--out FILE`). It reads the
database read-only — safe against a live daemon — and the page needs no server:
force-directed canvas layout, drag/zoom, per-relation-type legend toggles,
isolated-node highlighting, and a detail panel with each node's top statements.
The view assets under `src/cli/graph/assets/` are plain templates
(`template.html`, `graph.css`, `graph.js` exposing `NmgGraph.mount`) so the
renderer can be reused with any `{nodes, edges}` payload.

External evidence is opt-in and visibly marked:

```text
nmg remember "The upstream docs list version 2" --node "Upstream version" \
  --external-source web:https://example.com/docs --content-hash sha256:... --json
```

External writes default to `truth=unverified`; Pi renders `[external]` and the
source so the Agent can decide whether the current task requires re-checking.

Use `--tiered-disclosure` to search L0 first and open deeper tiers only while
QPP reports insufficient evidence. Pi automatic recall enables this gate by
default. The AG result reports `tiersOpened`, `deepestTier`, and `deepEvidence`.

`nmg daemon start` launches the language-neutral JSON-RPC-over-HTTP boundary
on an OS-assigned loopback port. Requests and responses are JSON-RPC 2.0 over
Node's built-in `http`/`fetch` (no third-party transport dependencies); the
endpoint and a random local bearer token are recorded beside the selected
SQLite database. The same implementation runs on Windows, macOS, and Linux.

The service also carries administrative retention, deletion, merge, and split
RPCs, plus reviewable topology-proposal list/assessment/review/actuation, so a
running daemon remains the only database writer. These are CLI/admin
capabilities, not extra model-facing Pi tools. Retention candidate selection is
a dry run; moving a memory to L4/L5 or deleting its semantic interpretation
requires an explicit command. `memory delete` retains immutable source history.

The service rejects a second daemon for the same database, opens SQLite lazily,
and removes stale process leases. Use the same `--data-dir` or `--db` for daemon
and client commands.

Node identity maintenance starts automatically on write: exact canonical names
and case/spacing/punctuation-only variants of the same node kind reuse the
existing node. Broader semantic merges are not performed from embedding
similarity alone. They require accumulated evidence and use reversible
transform/redirect records; the low-level merge/split RPCs remain an
administrative recovery surface rather than routine user work.

Pi bounds agent-directed recall per user turn independently of the AG content
budget: three searches, five total search/get calls, no more than two searches
without exact-evidence progression, and termination after two consecutive
searches add no candidate IDs. A new user turn resets the guard. These limits
prevent a compact AG from being built through an unbounded tool loop.

## Agent Skill

[`skills/nmg-memory/SKILL.md`](skills/nmg-memory/SKILL.md) lets other
tool-capable Agents use the same lifecycle and progressive recall workflow.
It is a small first-use card with on-demand reference pages: detailed write,
recall, and operations guidance is read only after an Agent forgets an operation
or encounters a special case. The normal path remains
`status → start if needed → search → selected get → ownership-safe stop`.

SQLite FTS5 is the zero-configuration Pi retrieval path. Set
`NMG_EMBED_BASE_URL` and `NMG_EMBED_MODEL` to add the external node/leaf semantic
signal to the same budgeted Active Graph pipeline. If the endpoint fails or
times out, Pi reports a degraded retrieval and continues with FTS5; hashing is
kept only as an evaluation baseline. `NMG_EMBED_TIMEOUT_MS` controls the request
timeout (10 seconds by default). The resumable `npm run index:embeddings`
command builds that model's index.

Set `NMG_EMBED_PROFILE` explicitly to `qwen3`, `bge-en`, or `plain`. The profile
defines independent query and document templates, so NMG never infers an
encoding contract from the model name. Custom providers can instead set
`NMG_EMBED_QUERY_TEMPLATE` and `NMG_EMBED_DOCUMENT_TEMPLATE`; each template must
contain `{text}`.

The preprocessing contract is part of the persisted embedding index identity.
Changing the profile, templates, dimensions, or relevant query instruction
creates a new index instead of silently reusing incompatible vectors. The batch
indexer uses SQLite missing/stale rows as a durable queue and reports pending
node/leaf/record counts, dirty nodes, last success, and retryable failures.
Run `npm run index:status` with the same embedding environment variables to
inspect that state without contacting the provider.
Pi activates a new semantic index only after its first successful complete
build. Until then it remains on FTS5 and reports
`reason=embedding_index_not_ready`, preventing partial profile/model switches.

The automatic-write rule is intentionally narrow:

- Save clear, stable user-stated facts, preferences, constraints, and states
  that are likely to help in a later session.
- Ask before saving ambiguous, inferred, uncertain, or current-task-only
  information.
- Never save casual chatter, duplicates, unverified model claims, credentials,
  secrets, or sensitive personal data as semantic memory.
- Give each replaceable property a stable `stateKey`; a new value in the same
  canonical scope automatically supersedes the old state without deleting its
  evidence. Use `nodeName` for a semantic group and `scope` for applicability;
  do not reuse one broad state key for several related facts.
- Preserve separately countable actions as separate memories and retain an exact
  source excerpt: the statement is a retrieval summary, not the evidence itself.
- Treat assistant-authored conversational evidence as unverified unless a user
  or tool confirms it.
- Obey constraints, adapt to preferences, use only the newest active state,
  preserve event time, and describe conversational evidence as something that
  was said rather than as independently verified truth.

The prompt guides semantic selection, while the extension independently blocks
high-confidence credential patterns, explicit do-not-retain requests, and
current-turn-only instructions. This boundary does not depend on model quality.

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

For bounded same-session lifecycle tests, call the helper directly with repeated
`--turn` flags (one Pi child and one owned daemon for the whole dialogue):

```powershell
node --experimental-strip-types scripts/pi-control.ts prompt `
  --turn "Recall one durable decision and load its exact evidence." `
  --turn "Review the preceding retrieval if all feedback labels are observable."
```

Each invocation uses a new Pi session but shares the project's
`.nmg/nmg.sqlite`, which makes cross-session memory tests straightforward.
The headless helper also isolates Pi settings under `.nmg/pi-agent`, loads only
the allow-listed benchmark credentials from the ignored repository `.env`, and
defaults to a 90-second prompt timeout plus 12 tool calls. Override these with
`NMG_PI_AGENT_DIR`, `NMG_PI_TIMEOUT_MS`, and `NMG_PI_MAX_TOOL_CALLS`. These are
test-runner safety limits, not NMG retrieval limits.
The controller defaults to `deepseek/deepseek-v4-flash` with thinking disabled,
uses `--no-extensions`, and explicitly loads only the NMG extension and its
four stable tools. This prevents unrelated global permission extensions from
blocking non-interactive RPC tool calls. Set `NMG_PI_MODEL` to override the
test model when needed.

QPP actuation is split into three independent controls:

- `NMG_QPP1_MODE=off|shadow|active` controls the learned first candidate-pool
  allocation. It defaults to `shadow`; `active` may widen only an explicit
  `nmg_search` that has no caller-specified limit. It is fail-safe before the
  controller has attributable training: the planning probe is non-persistent
  and an untrained 0.5 prior cannot change retrieval.
- `NMG_QPP2_MODE=off|shadow|active` controls Fibonacci progressive inspection
  and learned listwise folding within that candidate pool. It defaults to
  `off`; `shadow` retains QPP telemetry without changing the visible result,
  while `active` may continue to deeper evidence tiers and dynamically exposes
  enough learned necessary headers to retain the configured listwise
  probability mass. `NMG_QPP2_RETAINED_MASS` defaults to `0.98`. A flat score
  distribution therefore stays wide; a steep distribution folds more.
  Lower-necessity candidates are grouped as a folded directory, not deleted,
  and an explicit caller `limit` disables learned folding. The full candidate
  set remains in the Active Graph for exact `nmg_get`; top-1 is the only fixed
  safety anchor. Learned folding is inert until attributable controller
  training exists.
- `NMG_SEARCH_RECOMMENDATION=off|advisory|guardrail` controls whether an
  inadequate automatic recall recommends one deliberate `nmg_search` call to
  the model. It defaults to `off`; `guardrail` emits a recommendation only
  for hard failures such as empty, fallback-only, or very weak recall.

NMG reports each module's scores, quality, and cost but does not choose an
operator's policy or search for a preferred combination. Enabling QPP1, QPP2,
or recommendations—and composing them—is an explicit user/operator decision.

The normal QPP1 tier is capped at 20 records / 6,000 estimated tokens; a
learned `expand` decision can promote the Active Graph to 50 records / 10,000
estimated tokens for aggregation or multi-hop work. Automatic recall keeps its
small fixed budget. The committed search remains the sole retrieval trace and
may still be read with `nmg_get`. The legacy `NMG_CONTROLLER_SEARCH=1|0`
continues to map to QPP1 `active|shadow` when `NMG_QPP1_MODE` is unset.
Shadow events are written locally to
`.nmg/evaluation/controller-shadow.jsonl` (or under `NMG_DATA_DIR`) with bounded
size and rotation. They record deterministic and learned node order, candidate
exposure, explicit `nmg_get` use, retrieval/controller latency, estimated
context tokens, and completed-run token usage. These runtime files are ignored
by Git.

Optional human-labelled feedback can be attached to the latest retrieval:

```text
/nmg-shadow-feedback last success uncorrected
```

Use `failure`, `corrected`, or `unknown` as appropriate. NMG does not infer
correctness from fluent model output.

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
`evals/longmemeval/data/`. The adapter supports deterministic development runs
and a matched full-haystack comparison:

```powershell
npm run eval:longmem -- no-memory 1
npm run eval:longmem -- oracle 1
npm run eval:longmem -- nmg-oracle 1
npm run eval:longmem -- matched 1
```

See [evals/longmemeval/README.md](evals/longmemeval/README.md) for methodology,
limitations, and the initial seven-question smoke-test results.

### Complementary memory benchmarks

LoCoMo, PersonaMem, and BEAM use one shared runner and the same matched modes as
the LongMemEval development comparison:

```powershell
npm run eval:locomo -- validate 1
npm run eval:personamem -- validate 1
npm run eval:beam -- validate 1

npm run eval:locomo -- matched 1
npm run eval:personamem -- matched 1
npm run eval:beam -- matched 1
```

`validate` parses official local data and reports stratified samples without a
model call. Dataset placement and overrides are documented in each adapter's
README. The common experiment contract, metrics, and ablations are documented
in [evals/README.md](evals/README.md).

Older LongMemEval diagnostic ablations compared raw-session, flat-hybrid, Lite,
and Graph variants. They predate the strict three-arm protocol and remain
documented only as historical mechanism evidence, not as current matched-gate
or benchmark claims.

Run deterministic P1 memory invariants and P2 topology ablation with:

```powershell
npm run eval:quality
npm run eval:adaptive
```

### Scale and cache breakthrough

`npm run eval:scale` runs the same queries at 100, 1K, 10K, and 100K memories,
placing the answers before newer distractors so cold evidence falls outside the
legacy 500-row working set. It reports accuracy, returned-token estimate,
P50/P95 latency, tier hit rate, ingestion throughput, and index maintenance
cost. See [evals/scale/README.md](evals/scale/README.md).

The local retrieval controls are SQLite FTS5, deterministic hashing vectors,
external vectors served through an OpenAI-compatible endpoint, and their hybrid.
The external provider uses a resumable batch indexer; USearch provides the persistent HNSW ANN
index only after the scale test demonstrates scan cost. Setup is documented in
[docs/design/online-embeddings.md](docs/design/online-embeddings.md).

Example request to the agent:

```text
Remember that NMG uses Pi as its agent harness and SQLite as its local source of truth.
```

## Security boundary

NMG is a memory component, not a sandbox. It does not execute arbitrary code or
provide an execution backend. When isolation is needed, install and configure a
Pi sandbox plugin independently; NMG only records provenance and results that Pi
chooses to submit as memory evidence.
