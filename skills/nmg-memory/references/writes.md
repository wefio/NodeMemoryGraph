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

## Event

Use `--type event --event-time <ISO_TIME>` for something that happened. If the
event also changes current state, write both the event and the state.

## Evidence rules

- Prefer a short exact user or tool excerpt.
- Use `--truth unverified` for remembered assistant output that was not verified.
- Keep separately countable events or obligations as separate memories.
- Ask before storing ambiguous sensitive information. Never store credentials.

