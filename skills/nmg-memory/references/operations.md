# Daemon operations

## Development CLI path

The examples in this skill assume `nmg` is on `PATH` (global install). In a
development checkout use one of:

```text
npm run cli -- <command>
node bin/nmg.mjs <command>
```

## Ownership-safe lifecycle

Run `nmg daemon status --json` before starting. If already running, reuse it and
leave it running. If this invocation starts it, stop it during cleanup.

```text
nmg daemon start --json
nmg daemon status --json
nmg daemon stop --json
```

The Pi adapter performs this ownership tracking automatically.

## Storage selection

Default storage is `NMG_DATA_DIR` or `.nmg`. For an explicit store, pass the same
option to every lifecycle and memory command:

```text
--data-dir <DIRECTORY>
--db <SQLITE_FILE>
```

Do not mix stores accidentally.

## Failure handling

1. Check daemon status.
2. Retry one start if it is stopped.
3. Confirm the selected data directory/database is consistent.
4. Use `nmg status --json` to inspect storage and embedding health.
5. If retrieval embedding is degraded, lexical recall may still work.

Do not repeatedly start daemons or delete daemon state by hand. Do not stop a
shared daemon merely because one Agent has finished.

## Retention lifecycle (L4 / L5)

Memories age through tiers. Two retention states sit below the normal indexed
tiers: **L4 dormant** (candidate for removal) and **L5 quarantine**
(recovery window before permanent loss). The lifecycle is explicit, never
automatic deletion:

```text
# Dry-run: list what would be retained, with current vs recommended state
nmg retention candidates \
  --dormant-after-days 90 \
  --quarantine-after-days 30 \
  --maximum-importance 0.3 \
  --maximum-access-count 5 \
  --json

# Act on a candidate
nmg retention archive <MEMORY_ID>        # -> L4 dormant
nmg retention quarantine <MEMORY_ID> \   # -> L5 quarantine
  --recovery-days 30
nmg retention restore <MEMORY_ID>        # -> indexed (recovery)
```

Retention changes visibility, never the underlying history evidence. Restore
is always possible while the memory is in quarantine.

## Node maintenance

Semantic nodes can be merged or split when the graph structure is wrong.
Merges are reversible via redirects; splits reassign every memory exactly once.

```text
# Merge several nodes into one (identity/alias consolidation)
nmg node merge <NODE_ID> <NODE_ID> \
  --target-name "merged node name" \
  --target-kind concept \
  --json

# Split one node into several, partitioning every memory
nmg node split <NODE_ID> \
  --partition "new node A=<MEMORY_ID1>,<MEMORY_ID2>" \
  --partition "new node B=<MEMORY_ID3>" \
  --json
```

Run `nmg status --json` before a merge to check store health. Node IDs come
from `nmg search --json` results or `nmg get` output.

