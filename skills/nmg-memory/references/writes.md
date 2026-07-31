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
not its current value or date.

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

## Advanced options

| Option | When to use |
| --- | --- |
| `--event-time "<ISO>"` | Required for `--type event`; the occurrence time |
| `--supersedes "<MEMORY_ID>"` | Explicitly replace an old memory without deleting its evidence |
| `--residence ltg` | Long-term: durable, shared, normal visibility (default) |
| `--residence stg` | Short-term: provisional, task-local, expires by policy |
| `--scope key=value` | Repeatable; couples with search's `--scope` filter |
| `--evidence-role support|contradict|...` | Builds multi-evidence memories: a second memory with `contradict` adds the counter-evidence to the same evidence chain |
| `--truth unverified` | Assistant output not verified by user or tool |
| `--valid-from` / `--valid-until` | Time-window validity for the memory |
| `--expires-at` | Hard expiry (e.g. temporary facts) |
| `--source-ref` | Source reference for tool or file provenance |
| `--write-reason` | Why this write stays useful; appears in search results |

The full `--actor` set is `user`, `assistant`, `system`, `tool`.

## Deleting a memory

```text
nmg memory delete <MEMORY_ID> --json
```

`memory delete` removes only the semantic interpretation. The immutable
history evidence is retained.

## Evidence rules

- Prefer a short exact user or tool excerpt.
- Use `--truth unverified` for remembered assistant output that was not verified.
- Keep separately countable events or obligations as separate memories.
- Ask before storing ambiguous sensitive information. Never store credentials.

