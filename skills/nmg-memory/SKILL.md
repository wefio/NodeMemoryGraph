---
name: nmg-memory
description: Use NMG as durable memory when a task may depend on prior user facts, preferences, constraints, decisions, project state, events, or reusable experience; when the user asks to remember or recall something; or when an Agent must start, query, and safely close the NMG daemon.
---

# NMG Memory

Treat this file as the quick-start card, not a document to reread every turn.
Once the workflow is known, use it directly. Read a reference only after forgetting
an operation or encountering its named special case.

## Normal workflow

1. Check `nmg daemon status --json`.
2. If it is not running, run `nmg daemon start --json` and remember that this
   Agent invocation owns the daemon.
3. Before answering a history-dependent question, run:

   ```text
   nmg search "<focused recall query>" --project-dir . --limit 8 --max-tier 1 --json
   ```

   Narrow the scope when the store is large or the topic is specific:
   `--node "<name>"`, `--scope project=NAME`, `--source-actor user`,
   `--include-historical`, `--max-tier 2`, `--graph-hops 2`.

4. Search results are compact headers. Load only selected exact records:

   ```text
   nmg get <MEMORY_ID...> --project-dir . --json
   ```

5. Save durable information with `nmg remember`. Automatically save stable facts,
   preferences, constraints, current states, significant events, and reusable
   strategies. Do not save secrets, casual chatter, duplicates, or unsupported
   assistant guesses.
6. On exit, run `nmg daemon stop --json` only if this invocation started it.
   Never stop a daemon that was already running.

Use the same `--data-dir` or `--db` option on every command when the caller
selected a non-default LTG store. Use the same `--project-dir` on project STG
searches, exact reads, and provisional writes.

## Progressive recall

Treat automatically injected recall and search results as candidate headers.
Use `nmg get` to load selected exact records and evidence. Decide whether the
question needs one or several records; candidate count does not prove evidence
completeness. Start shallow. If information may still be missing, try one
narrower or complementary query, then increase `--max-tier`, `--limit`, or
`--graph-hops`.
If lexical results are still insufficient and embeddings are configured,
switch to `--retrieval-mode hybrid` (semantic path; see
[embedding](references/embedding.md)). Do not load all candidate evidence into
the model.

## When to read the manual

- For exact write forms, state replacement, scope, or evidence:
  [writes](references/writes.md)
- For incomplete recall, conflicts, deep history, or retrieval tuning:
  [recall](references/recall.md)
- For daemon failures, shared ownership, storage selection, or cleanup:
  [operations](references/operations.md)
- For embedding configuration and semantic search:
  [embedding](references/embedding.md)
