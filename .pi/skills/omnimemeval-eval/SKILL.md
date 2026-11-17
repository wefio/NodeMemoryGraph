---
name: omnimemeval-eval
description: Run or continue OmniMemEval user-memory evaluations through the NMG HTTP adapter. Use for upstream benchmark setup, Add/Search runs, or result continuation.
---

# OmniMemEval evaluation

Use the [NMG HTTP guide](../../../evals/omnimemeval/README.md) for installation,
required environment variables, and the official LongMemEval example. Use the
pinned upstream suite's help and checkpoint options for dataset-specific runs.

## Resume

Record the endpoint, experiment namespace, suite version, and dataset settings
before a run. Reuse those values when continuing that exact result directory.
Use a fresh namespace for an independent run.

## Boundaries

Keep answer generation, judging, checkpoints, and reports in OmniMemEval.
The NMG HTTP service provides Add and Search. Keep clearing and streaming
disabled. Run NMG evidence audits separately on completed artifacts.
