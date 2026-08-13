# Durable writes

## Fact, preference, constraint, and strategy

```text
nmg remember "<statement>" \
  --node "<stable semantic node>" \
  --type fact \
  --actor user \
  --evidence "<short exact source excerpt>" \
  --write-reason "<why it remains useful>" \
  --json
```

Choose `preference`, `constraint`, or `strategy` instead of `fact` when that is
how the Agent should use the memory.

## Changeable state

Use `--type state` and a stable `--state-key`. The key identifies the property,
not its current value, date, topic, node, project, or group. Two writes with the
same canonical scope and state key mean “these are successive values of the
same single-valued property”; the newer write automatically supersedes the old
one.

Keep these three identifiers separate:

| Field | Meaning | Example |
| --- | --- | --- |
| `--node` | Semantic cluster that may contain several related memories | `pi-lsp environment` |
| `--scope` | Where the memory applies | `project=pi-lsp` |
| `--state-key` | Exactly one replaceable property inside that scope | `pi-lsp.installation.path` |

Do **not** use a broad key such as `pi-lsp-env` for installation path, tool
inventory, patch policy, and symbol-provider mechanism. Those facts can share a
node and scope, but only separately changeable properties should be state keys:

```text
pi-lsp.installation.path
pi-lsp.patch.survives_update
pi-lsp.workspace_symbol.provider
```

Use `fact`, `constraint`, or `event` without a state key when the record is not
one replaceable value.

```text
nmg remember "Atlas currently uses SQLite." \
  --node "Atlas storage" \
  --type state \
  --state-key "atlas.storage.engine" \
  --scope project=atlas \
  --evidence "We switched Atlas to SQLite." \
  --write-reason "Current project architecture" \
  --json
```

Writing a new state with the same key and scope automatically supersedes the
previous active state (same `state_key + scope`).

## Event

Use `--type event --event-time <ISO_TIME>` for something that happened. If the
event also changes current state, write both the event and the state.

## Open, resolved, and reopened structures

Use an open record for an attributable unresolved question, blocked decision,
or reusable near-miss that must remain reachable across sessions. It must point
to at least one existing memory in the same store:

```text
nmg remember "Verify Atlas on the remaining target platform." \
  --node "Atlas portability follow-up" \
  --type event \
  --resolution open \
  --related-memory <ATLAS_STORAGE_MEMORY_ID> \
  --write-reason "Unresolved release blocker" \
  --json
```

Open and reopened records remain indexed and are exempt from heat-based
retention and STG expiry. Close or reopen them only on explicit evidence:

```text
nmg resolve <MEMORY_ID> --reason "The target platform test passed" --json
nmg reopen <MEMORY_ID> --related-memory <ANCHOR_ID> \
  --reason "A new target platform was added" --json
```

The transitions are audited. They do not delete or rewrite source history.
Do not use open state for raw chain-of-thought, routine tool errors, or a generic
task list.

## Advanced options

| Option | When to use |
| --- | --- |
| `--event-time "<ISO>"` | Required for `--type event`; the occurrence time |
| `--supersedes "<MEMORY_ID>"` | Explicitly replace an old memory without deleting its evidence |
| `--residence ltg` | Long-term: durable, shared, normal visibility (default) |
| `--residence stg` | Short-term: provisional, task-local, expires by policy |
| `--project-dir <DIR>` | Place/read `stg` records in that project's isolated store |
| `--scope key=value` | Repeatable; couples with search's `--scope` filter |
| `--evidence-role support|contradict|...` | Builds multi-evidence memories: a second memory with `contradict` adds the counter-evidence to the same evidence chain |
| `--truth unverified` | Assistant output not verified by user or tool |
| `--valid-from` / `--valid-until` | Time-window validity for the memory |
| `--expires-at` | Hard expiry (e.g. temporary facts) |
| `--source-ref` | Source reference for tool or file provenance |
| `--external-source web:URL|file:PATH` | Mark external provenance; defaults trust to `unverified` |
| `--retrieved-at` / `--content-hash` | Timestamp and optional digest for an external source |
| `--write-reason` | Why this write stays useful; appears in search results |
| `--resolution open|resolved|reopened` | Lifecycle of an unresolved structure |
| `--opened-at` | Optional explicit open timestamp; defaults to write time |
| `--related-memory ID` | Repeatable anchor; required for open/reopened records |

The full `--actor` set is `user`, `assistant`, `system`, `tool`.

## Claim outcomes and STG consolidation evidence

Record an outcome only when an independently attributable user message, tool
result, completed task, or benchmark explicitly supports or contradicts a saved
claim:

```text
nmg claim outcome <MEMORY_ID> \
  --outcome supported \
  --source tool \
  --source-lineage "tool-result:<stable-id>" \
  --semantic-task-id "task:<stable-id>" \
  --active-graph-id <AG_ID> \
  --json
```

`--claim-index` may be repeated to select atomic claims; omit it to apply the
outcome to all claims in the record. `--active-graph-id` is optional, but when
present it proves that the memory was exposed by that session-owned AG. The Pi
adapter exposes the same operation as `nmg_remember action=claim_outcome`.
For a user/tool outcome, pass the smallest exact supporting or contradicting
excerpt in `evidence`; Pi binds its real message ID and ignores invented lineage.
For a completed-task outcome, pass a stable `claimSourceLineage` task ID.

This is deliberately separate from retrieval feedback. Being retrieved, being
quoted by the Agent, task completion, silence, and lack of correction are not
claim support. Stable `source-lineage` and `semantic-task-id` values prevent one
source or repeated turn from becoming several independent votes.

## Deleting a memory

```text
nmg memory delete <MEMORY_ID> --json
```

`memory delete` removes only the semantic interpretation. The immutable
history evidence is retained.

## Evidence rules

- Prefer a short exact user or tool excerpt.
- `sourceActor` identifies who produced that evidence, not who the Agent wants
  to treat as authoritative. In the Pi adapter, an omitted actor safely defaults
  to `assistant`; claiming `user`, `tool`, or `system` requires a matching exact
  session excerpt or explicit external provenance. Never relabel an Assistant
  inference as a user statement.
- Use `--truth unverified` for remembered assistant output that was not verified.
- Keep separately countable events or obligations as separate memories.
- Ask before storing ambiguous sensitive information. Never store credentials.
