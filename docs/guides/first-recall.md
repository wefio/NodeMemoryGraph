# First-recall tutorial

[中文](first-recall.zh-CN.md) · [Concept map](concept-map.md)

This executable walkthrough teaches NMG's smallest complete memory loop:

```text
remember -> compact search headers -> exact get
```

It creates a private temporary SQLite store and one in-process resident daemon,
does not call an LLM or embedding provider, and shuts down the daemon and removes
the store on exit. The resident process is required because the session Active
Graph is intentionally memory-only across search and exact disclosure. The
tutorial never reads or writes the user's normal `~/.nmg` memory.

## Run it

From the repository root, with Node.js 22.19 or newer and dependencies installed:

```powershell
npm run tutorial:first-recall
```

In an interactive terminal the script pauses between four steps. In CI or another
non-interactive environment it runs straight through. The tested non-interactive
form is:

```powershell
npm run tutorial:first-recall -- --non-interactive
```

## What the four steps prove

1. **Status** points at an empty temporary store without creating it.
2. **Remember** saves one scoped preference under a stable semantic node.
3. **Search** returns only a compact candidate header plus an `activeGraphId`.
4. **Get** passes that graph ID back and loads the exact saved statement.

The important boundary is between steps 3 and 4. A header is cheap and may be
lossy; it helps the Agent decide what to recall. Exact `get` is the evidence
disclosure step and records which retrieval projection exposed that evidence.

The commands printed by the tutorial are ordinary CLI commands. For the current
option contract, use:

```powershell
npm run cli -- remember --help
npm run cli -- search --help
npm run cli -- get --help
```

## Why this tutorial should not silently age

The walkthrough calls the same `runCli` entry used by the product and is covered
by `tests/scripts/tutorial-first-recall.test.ts`. The test checks the public npm
command, Active Graph handoff, exact evidence, and cleanup. A breaking CLI change
therefore fails product tests instead of leaving a plausible but stale example.

This page intentionally avoids copying the full CLI schema or design status.
The CLI help owns syntax; the [concept map](concept-map.md) owns navigation; the
[normative design](../design/design.md) owns architecture.
