# Architecture boundary baseline — 2026-10-27

[中文](architecture-baseline-2026-10-27.zh-CN.md) · [Terms used](architecture-baseline-2026-10-27.terms.yaml)

This scoped review gives a starting point for comparing four architecture boundaries. It examines repository revision `f8e2995eaa658d3f6806f7430d6989cade392a24`, selected source, design and test descriptions, and selected Git history. It does not execute tests, measure runtime behavior, or establish a historical trend. `Watch` means a question merits investigation, not that a defect is proven. `Unknown` means the review did not establish the answer.

| Boundary | Status and evidence | Question for the next review |
| --- | --- | --- |
| Store / Task Board | **Watch.** [`NmgStoreBase`](../../src/core/store/base.ts) owns write transaction coordination and Task Board operations. The source rejects a second transaction and asynchronous transaction callbacks. This shared boundary constrains any split. | For a representative Board change, which files and tests change? Can ownership be separated while preserving the same connection and transaction semantics? |
| Lite / Lab | **Watch.** The [design](../design/design.md) distinguishes default Lite from opt-in Lab. [`NmgService`](../../src/cli/service.ts) statically imports several Lab modules; the import alone does not establish a default-path failure or policy violation. | What Lab code loads on the default path, and do a missing dependency or a Lab initialization failure affect Lite? |
| Local / cloud | **Watch.** [Onlion](../../onlion/README.md) imports the shared implementation and documents different SQLite and object-storage environments. It describes Miniflare with simulated R2 and separate real-bucket checks; this review did not run them. | Which common cases prove scope isolation, concurrent writes, retries and recovery on each adapter, and which environments remain untested? |
| Adapter / core | **Watch.** The [shared-session decision](../decisions/implemented/2026-10-16-shared-session-flows.md) describes extracting shared flows from Pi; other adapters continue to have their own entrypoints. This review did not compare their full call paths. | For one representative session flow, what must a new adapter implement or change in core, and where do adapter behaviors diverge? |

## Comparison and limits

At the reviewed revision, PowerShell `Measure-Object -Line` counted 4,125 nonblank lines in `src/cli/service.ts` and 2,999 in `src/core/store/base.ts`. This is a navigation signal, not a coupling or quality score. Reuse the same command and revision scope for a later comparison; do not treat fewer lines as proof of improvement.

The inspected history includes shared-session extraction (`4800da7a`) and information-view unification (`c7306caf`), alongside the EdgeOne adapter (`890de371`). These show both consolidation and scope growth. They do not prove that overall architecture improved or deteriorated. The next useful comparison is a named change scenario with affected files, contracts, tests, verification time and unresolved failure cases, measured with the same boundaries before and after a change.

This record is observation, not a standing rule or a proposal to split modules. The [system design](../design/design.md) owns contracts; the [completion audit](../design/completion-audit.md) owns implementation evidence. Any current claims must be checked again against the selected revision.
