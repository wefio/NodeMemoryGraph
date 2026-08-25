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
nmg lab disable <CAPABILITY> --session-id <SESSION> --json
```

Agent-self-service capabilities are:

- `reasoning_workspace`: explicit session scratchpad/checkpoints;
- `memory_graph_reasoner`: read-only differentiable traversal, fuzzy logic, and
  what-if analysis;
- `controller_shadow`: controller observations without actuation.

MGR graph nodes accept `outgoing: string[]`. When any node declares it, the first
node is selected globally and every later step must follow the preceding node's
directed outgoing edges. An empty list terminates that path.

`controller_controlled` and `controller_active` cannot be self-authorized by an
Agent. Lab leases are session-scoped and expire; Lab output is not durable truth
until separately admitted through governed `remember`.

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
