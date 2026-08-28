# Optional capability manual

Use this reference when a feature is implemented but not part of the default Lite
path. Environment variables are read when Pi or the daemon starts; restart the
owning process after changing them. A switch makes a mechanism available. It does
not turn benchmark evidence into production authorization.

## Retrieval controls

| Capability | Default | Enable | Boundary |
| --- | --- | --- | --- |
| QPP1 allocation | `shadow` | `NMG_QPP1_MODE=active` | Pi explicit searches only; a caller-supplied `limit` wins. |
| QPP2 progressive fold | `off` | `NMG_QPP2_MODE=active` | Keeps top-1 and folded IDs in AG; `NMG_QPP2_RETAINED_MASS` defaults to `0.98`. |
| Search recommendation | `off` | `NMG_SEARCH_RECOMMENDATION=advisory` or `guardrail` | `guardrail` recommends search only for hard recall failures. |
| Deterministic Fibonacci pass | explicit | `nmg search "..." --second-pass` | Re-selects one over-sampled pool; no second vector search. |
| Sequential storage tiers | explicit | `nmg search "..." --tiered-disclosure` | Opens L0 first, then deeper tiers while deterministic QPP says insufficient. |
| Full warm window | folded | `nmg search "..." --full-warm` | Diagnostic override; normally load deferred IDs with `nmg get`. |

Observe QPP before active use:

```powershell
$env:NMG_QPP1_MODE = "shadow"
$env:NMG_QPP2_MODE = "shadow"
$env:NMG_SEARCH_RECOMMENDATION = "off"
pi
```

## Learned controller

`NMG_CONTROLLER_RUNTIME_MODE=off|shadow|controlled|active` defaults to `shadow`.

- `off`: no learned scoring.
- `shadow`: score and record only; cannot rerank, allocate, or fold.
- `controlled`: requires a trained `NMG_CONTROLLER_RUNTIME_STATE` and
  `NMG_SHADOW_COLLECTION_ORIGIN=controlled`.
- `active`: additionally requires `NMG_CONTROLLER_ACTIVATION_RECEIPT`. The receipt
  must bind the candidate hash and feature protocol to passing retrieval,
  controller, and product gate artifacts and a distinct loadable rollback state.
  Missing or changed artifacts fail closed.

`NMG_CONTROLLER_RERANK=active` only declares that reranking may be used. It does
not bypass the runtime channel above.

## STG and topology maintenance

Automatic STG-to-LTG consolidation is default-off:

```powershell
$env:NMG_STG_AUTO_CONSOLIDATE = "1"
$env:NMG_STG_CONSOLIDATE_MIN_VOTES = "3"
$env:NMG_STG_CONSOLIDATE_MIN_MEAN = "0.75"
$env:NMG_STG_CONSOLIDATE_MIN_LOWER_BOUND = "0.5"
```

Automatic project working-set caching from LTG into STG is also default-off:

```powershell
$env:NMG_STG_AUTO_SYNC = "1"
$env:NMG_STG_AUTO_SYNC_LIMIT = "20"
$env:NMG_STG_AUTO_SYNC_INTERVAL_SECONDS = "300"
```

It runs only for project searches carrying a non-empty `scope`. Cached rows are
sessionless hints marked `cached_from_ltg`; LTG remains authoritative.

Automatic identity merge is default-off and hard-bounded:

```powershell
$env:NMG_TOPOLOGY_AUTO_MERGE = "1"
$env:NMG_TOPOLOGY_AUTO_MERGE_LIMIT = "1" # hard maximum: 4
```

Prefer the reviewable path until natural false-merge evidence is adequate:

```text
nmg topology proposals
nmg topology assess <PROPOSAL_ID>
nmg topology review <PROPOSAL_ID> --decision accept
nmg topology actuate <PROPOSAL_ID>
```

Edge consolidation itself runs in bounded semantic maintenance with conservative
stability, cooldown, and demotion thresholds. There is no separate activation
flag; retrieval alone cannot promote an edge.

Maintenance-policy candidates use a review-only CLI channel. They are not enabled
automatically and acceptance never mutates memory:

```text
nmg maintenance propose --defect retrieval --maintenance-action observe \
  --target-memory <MEMORY_ID> --policy-id <ID> --policy-revision <REV> \
  --policy-hash <HASH> --policy-min-score 0.7 --score 0.8 \
  --evaluation-kind matched_replay --evaluation-ref <RUN_ID>
nmg maintenance proposals --status pending
nmg maintenance review <PROPOSAL_ID> --decision accept --reason "<review evidence>"
```

For `rewrite`, also pass `--proposed-statement`. For `rescope`, pass one or
more `--scope KEY=VALUE`. Content and scope proposals must later be applied with
the existing explicit maintenance command; retrieval defects may only use
`observe` and belong to retrieval-policy calibration.

## Session Lab capabilities

Lab uses the existing daemon. Discover before enabling:

```text
nmg lab list --json
nmg lab enable <CAPABILITY> --session-id <SESSION> \
  --requester agent:<NAME> --reason "<why ordinary NMG is insufficient>" --json
nmg lab status <CAPABILITY> --session-id <SESSION> --json
nmg lab invoke <CAPABILITY> --session-id <SESSION> \
  --operation <OP> --input-json '<JSON>' --json
nmg lab disable <CAPABILITY> --session-id <SESSION> --json
```

`nmg lab list` is the authoritative contract source: it returns each capability's
`id`, `summary`, `agentMayEnable`, `supportedScopes`, and `operations`. Always
read it before calling `invoke`; do not guess an operation name.

### Enablement rules

- Agent-self-service capabilities (`agentMayEnable=true`) are:
  - `reasoning_workspace`: session-private scratch graph and checkpoints;
  - `memory_graph_reasoner`: read-only differentiable traversal, fuzzy logic,
    and what-if analysis;
  - `controller_shadow`: controller observations without actuation.
- `controller_controlled` and `controller_active` have `agentMayEnable=false` and
  **cannot** be self-authorized by an Agent; they require independent
  harness/operator authorization and the existing activation gates. Never try
  to bypass a denial.
- Leases are session-scoped (`--session-id`) and expire after the enable TTL.
  Lab output is scratch/experimental and is **not** durable truth until
  separately admitted through a governed `remember` call.

### `reasoning_workspace` operations

Session-private auditable scratch graph for multi-step reasoning and compaction
recovery. Every node carries one `kind`. Confirmed `kind` values:
`goal`, `observation`, `hypothesis`, `evidence`, `conclusion`, `decision`,
`open_question`, `next_action`.

| Operation | Required input keys | Returns | Status |
| --- | --- | --- | --- |
| `add` | `id`, `kind`, `content` | node `{id, kind, content, status, importance, evidenceRefs, createdAt, updatedAt}` | verified live |
| `link` | `sourceId`, `targetId`, `type` | `{sourceId, targetId, type, createdAt}` | verified live |
| `checkpoint` | `label` (optional) | snapshot `{sessionId, nodes, edges, omittedNodes, text}` | verified live |
| `update` | node id + fields | node | not re-verified |
| `mark_compacted` | session | compaction marker | not re-verified |
| `consume_checkpoint` | session | checkpoint consumption | not re-verified |
| `clear` | session | cleared workspace | not re-verified |

`link` uses `sourceId`/`targetId`/`type` — not `from`/`to`/`relation`.
`checkpoint` output includes a ready-to-inject `text` projection; treat it as an
auditable scratchpad, not verified fact.

```text
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation add --input-json '{"id":"n1","kind":"hypothesis","content":"..."}' --json
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation link --input-json '{"sourceId":"<id>","targetId":"<id>","type":"supports"}' --json
nmg lab invoke reasoning_workspace --session-id <SESSION> \
  --operation checkpoint --input-json '{"label":"step-1"}' --json
```

### `memory_graph_reasoner` operations

Read-only differentiable reasoning over **supplied** memory vectors. It does not
query the LTG store; you pass the graph in every call. A graph node is
`{id, vector, requires?, outgoing?}` where `vector` is an **L2-normalized number
array** (not a query string). The daemon converts a JSON array of nodes into the
internal `Map<id, node>`.

| Operation | Required input keys | Returns | Status |
| --- | --- | --- | --- |
| `traverse` | `queryVector`, `graph`, `maxSteps` | `{path:[{nodeId,score,queryBefore,queryAfter,gate}], finalQuery, pathScore}` | verified live |
| `logic_search` | `expr`, `graph`, `topK` | `[{nodeId, membership, atomScores}]` (ranked by `membership`) | from source (`logicSearch`) |
| `what_if` | `queryVector`, `graph`, `hypotheticalNode`, `maxSteps` (+`impactThreshold`) | `{baseline, withNode, impacted:[{nodeId, scoreBefore, scoreAfter, delta, pathChange}]}` | from source (`whatIf`) |

- `queryVector` must be a non-empty finite number array (sends `queryVector is
  required` otherwise); it is the traversal anchor.
- `graph` is a JSON array of node objects (`graph must contain between 1 and
  10000 nodes`).
- `traverse` greedily advances from the globally best start node; each step's
  `queryAfter` becomes the next step's `queryBefore`.
- When any node declares `outgoing: string[]`, traversal is topology-constrained
  after the global start: every later step must follow the preceding node's
  directed outgoing edges. An empty list terminates that path. Omit `outgoing`
  for global (legacy) traversal.
- `logic_search` takes a fuzzy `expr`: `{kind:"atom", queryVector}` or
  `{kind:"and"|"or", children:[...]}` / `{kind:"not", child}` (composable
  `nand`/`xor` helpers exist). Each result carries `membership` (combined
  membership in (0,1)) and `atomScores` (per-atom memberships for explanation).
- `what_if` injects a `hypotheticalNode` and compares traversal before/after
  (`impacted` lists nodes whose score changed beyond `impactThreshold`, default
  `0.05`).

```text
nmg lab invoke memory_graph_reasoner --session-id <SESSION> \
  --operation traverse --input-json '{"queryVector":[0.8,0.2],"maxSteps":3,"graph":[{"id":"a","vector":[1,0],"outgoing":["b"]},{"id":"b","vector":[0,1]}]}' --json
```

### `controller_shadow`

Single `observe` operation: records controller decisions without changing product
retrieval. Read-only diagnostics; does not actuate.

## ANN index

ANN remains optional because exact scan is the product baseline. With the
optional `usearch` dependency and an embedding provider configured:

```powershell
$env:NMG_DB_PATH = ".nmg/nmg.sqlite"
$env:NMG_ANN_PATH = ".nmg/indexes/qwen3.usearch"
$env:NMG_ANN_TARGET = "leaves" # leaves | nodes | records
$env:NMG_ANN_BATCH_SIZE = "512"
npm run index:ann
```

Building an index does not automatically replace exact retrieval. Promote an ANN
path only after its recall/latency crossover is measured on the target store.
