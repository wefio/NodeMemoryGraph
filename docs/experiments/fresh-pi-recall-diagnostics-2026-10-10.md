# Fresh Pi recall: matched questions and preparation timing

## Scope

This experiment diagnoses the 2026-10-09 fresh-Pi smoke comparison and checks the
[recall fixes](../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.md).
It does not measure final provider transmission, model cost, or task continuity.

## Historical comparison

The ordinary-discovery prompt used `先前提出过哪些实现约束`; the explicit-NMG
prompt used `之前提出过哪些实现约束`. At base revision
`e1a3e20681f77adf07965db3d5b518e36ffd0a2e`, the shared gate chose `none` for the
first and `retrieve` for the second. The 0-versus-5 candidate result was therefore
not a controlled extension-discovery comparison. The regression in
`tests/core/gate.test.ts` uses the same question with only that synonym changed.

Both historical models completed and settled, but the tool reported a timeout.
The logs place approximately 152 and 97 seconds before the first model message;
these are not measured shutdown durations. Their internal phases were not
recorded, so their causes remain unknown.

## Controlled native SDK preparation

Environment: Windows, Node v24.19.0, installed Pi 1.1.0. The checkout used the
base revision plus the scoped repair recorded in verification run
`0d293ecc-8ed8-4434-9377-b2c570130603`. The existing shared daemon and database were
reused; no Pi installation file was modified.

Both discovery modes used this exact question:

> 用户对 NodeMemoryGraph 的 AG 状态与可见内容改进，先前提出过哪些实现约束？请仅报告本轮自动召回的候选，不把候选当已核实事实。

The public SDK sequence was `DefaultResourceLoader.reload` with an approving
trust-resolution callback, `createAgentSession` with an in-memory session and
`noTools: "all"`, `bindExtensions`, then `emitBeforeAgentStart`. Theme initialization
used no watcher. Preparation received valid system-prompt options including
`cwd`; results were read from `messages` and `systemPromptOptions`.

| Observation         | Ordinary discovery | Explicit NMG only |
| ------------------- | -----------------: | ----------------: |
| Resource loading    |        1779.846 ms |        218.233 ms |
| Session creation    |          47.320 ms |         42.245 ms |
| Extension binding   |        1070.608 ms |         22.312 ms |
| Recall preparation  |         853.368 ms |        647.928 ms |
| Candidate rows      |                  5 |                 5 |
| Load/handler errors |                  0 |                 0 |
| NMG policy present  |                yes |               yes |
| Model calls         |                  0 |                 0 |

Candidate counts include only candidate rows, not the `fields: memory=id` format
legend. Both surfaces exposed lexical degradation with reason
`embedding_unavailable`, without provider quota/response bodies. Each probe
released its own runtime session through ordinary RPC, disposed its SDK session,
left the shared daemon running, and avoided the shutdown archive hook. No test
memory or session archive was inserted.

These samples prove preparation through the installed native hooks. They do not
prove that a later real model request includes the message, that ranking is
stable across time, or that every host extension is harmless in every turn. The
previous explicit-NMG model read-back remains separate evidence.

## Deterministic lifecycle and rendering checks

The archive regression found a live `Timeout` after the write had already
resolved; the red run retained the five-second deadline. The repaired helper
releases that resource, while a stalled write still stages its archive. Existing
owned-daemon shutdown integration tests cover successful, failed, and dead-daemon
archive paths. This is not a complete Pi-process exit guarantee.

The rendering regressions keep the original frozen provider diagnostic intact,
map 429/503 to bounded cause codes, protect older raw compact DTOs, and retain
health on empty results. Existing code/index reason codes remain stable; unknown
provider prose is not admitted to model-facing text.

The first direct product invocation emitted 1681 passing tests but its outer
tool timed out. A subsequent canonical `agent:verify` recorded all blocking
commands, including `test:product`, with exit code 0. A test summary alone and an
observed process/check exit are deliberately reported separately.

## Evidence and limitations

The local JSON/log artifacts live under `.nmg/verification/`; they are optional
accelerators, not a second contract. The shared gate, renderer, archive code,
regressions, and the linked decision preserve the recoverable findings.

No new live LLM response or benchmark was requested. Automatic preparation used
the daemon's configured retrieval path; this is not an embedding-budget study.
The historical long startup and the full CLI/model/exit boundary remain
unverified. A future real-turn reproduction can use the existing opt-in
`/nmg-latency on` observer rather than modifying Pi or replacing its transport.
