# Daemon operations

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

