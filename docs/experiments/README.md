# Experiments

[中文](README.zh-CN.md)

Measured evidence. A record here reports what was observed; it becomes normative
only when a decision or design owner accepts the result
([doc-maintenance](../../skills/doc-maintenance/SKILL.md)).

## Topics

A run lives in the topic directory that names the line of inquiry it answers.
Reports are named `<slug>-<YYYY-MM-DD>.md`, and the slug drops the topic prefix
when that prefix repeats the directory name. A rolling summary or note uses
`-results.md` or `-notes.md` instead of a date.

| Directory | Scope |
| --- | --- |
| `retrieval-quality/` | end-to-end retrieval-quality series, with its resume status |
| `retrieval/` | retrieval mechanisms: HyDE, node-summary acceleration, progressive disclosure |
| `context/` | context assembly, routing, and intervention |
| `topology/` | graph topology and namesake effects |
| `qpp/` | query-performance prediction |
| `benchmarks/` | dataset runs: LongMemEval, LoCoMo, BEAM, and HaluMem |
| `store/` | storage: consolidation, scale, and the write path |
| `runtime/` | embedding backends, autodiff operators, and the controller shadow |
| `execution/` | restricted out-of-order execution for agents: what the wait is worth, and which measured failure modes the machinery addresses (the earlier admission run stays at the top level) |

`benchmark-results.md` stays at the top level because it spans topics.
