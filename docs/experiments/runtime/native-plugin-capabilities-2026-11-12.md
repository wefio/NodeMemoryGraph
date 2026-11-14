# Native DSH and OpenCode plugin capability audit

[中文](native-plugin-capabilities-2026-11-12.zh-CN.md) · [Terms](native-plugin-capabilities-2026-11-12.terms.yaml)

## Question and conclusion

Which NMG gaps can DSH and OpenCode fill natively? Both expose useful native context, tools and lifecycle interfaces. Complete maintained-state carriage is wired in both adapters. DSH also wires final tool-result observations, weak commit nudges and diagnostic attribution from committed completed turns. OpenCode resolves the session directory before first-turn recall and registers explicit `nmg_` tool names.

Magpie remains a complete independent plugin target. These native paths do not require its deployment. The [existing capability matrix](../../design/harness-capability-matrix.md) owns source coverage; the [OpenCode decision](../../decisions/implemented/2026-10-17-opencode-adapter.md) preserves the original integration evidence.

## Targets and evidence strength

| Target | Evidence | Limit |
| --- | --- | --- |
| NMG adapters | 28 passing focused fixture tests, plus shared tool-contract and transport tests | Fixtures simulate host callbacks; they do not establish all native lifecycle ordering |
| DSH source | Public revision `687f282e8625c6b8d11ff58211a90524be2e4317`, checkout manifest `0.2.1-rc.2` | Source and installed versions are distinct |
| Installed DSH core | Prompt/tools/Agent packages `0.2.1-rc.5`, with module SHA-256 in the artifact | Real Cordis, prompt and tool services, with synthetic Agent/session events; no full Agent loop, desktop or external model |
| Installed OpenCode | CLI `2.0.32`, binary SHA-256 recorded; private HTTP host with the actual NMG plugin, private NMG service and loopback model | Three admitted prompts, native manual compaction and a deterministic tool cycle; no external provider, GUI or live idle wake |

The [artifact](artifacts/native-plugin-capabilities-2026-11-12/native-plugin-probe.json) records source hashes, package versions, tested checks and unverified boundaries. Source review is not runtime evidence. Loopback model receipt is scoped to that run and does not authorize a production disclosure receipt.

## DSH native execution

The fixed source supplies [context assembly](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts), [request admission and refresh](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts), [final tool notifications](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts) and [committed session events](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts).

Installed-service checks pass dynamic context refresh, identity-based assembly selection, contribution disposal and frozen final success/error tool notifications. The NMG exercise additionally runs real native tools to enable/replace state, admit a request, assemble complete state plus recall, search/get exact evidence, and flush completed-turn diagnostic attribution. This checks service contracts with synthetic Agent events, not a full native execution loop.

The adapter starts recall at inbox arrival and awaits bounded preparation at request admission. The loop refreshes the synchronous `systemPrompt.context` contribution before committing model-visible content. Shared `contextStateViews` and InformationView preserve complete state independently of recall. Final `tools/result` uses shared observation selection and commit-nudge logic. Committed `assistant/message` text is attributed only on completed `turn/end`; cancellation, foreign sessions and duplicate closers produce no attribution. This diagnostic overlap is not correctness or training feedback.

## OpenCode activation and hook exercise

API-only session/config queries initially produced no setup receipt and exited 2. A CLI exploration with a nonexistent provider timed out. Neither attempt established plugin support or inability. The successful exercise uses a fresh private HTTP host, which activates the plugin when the session runs.

The installed SDK exposes `session.get`, `wait`, `context`, `prompt` and the `prompt`/`context`/`compaction` hooks. Actual prompt, context and `execute.after` callbacks were recorded. A loopback model invoked `tools.nmg_search`, `tools.nmg_get` and `tools.nmg_state` through Code Mode. The next admitted prompt carried the complete maintained state to a subsequent model request. The host lowers injected system blocks to escaped `system-update` content, which the receipt check explicitly recognizes.

The SDK does not apply `options.namespace` to added tool names. NMG therefore registers explicit `nmg_search`, `nmg_get`, `nmg_remember` and `nmg_state` names. Native `session.get` supplies first-turn scope before recall, with plugin location as fallback and explicit project configuration as override. A deadline test prevents a late lookup from modifying current scope. Complete admitted state survives an optional recall timeout.

The installed run exercises prompt, context, tool completion and manual compaction hooks. After native compaction, the next prompt carries the current complete working state to the loopback receiver. Cancellation and stale-work rejection also have fixture coverage. Interrupted/automatic compaction, fork and reconnect sequences remain unverified.

## Capability assembly recheck, 2026-11-13

The declaration-driven assembly change was rerun with the same installed host
versions and private loopback exercise. The
[retained receipt](artifacts/native-plugin-capabilities-2026-11-12/capability-assembly-2026-11-13.json)
adds hashes of the assembly, catalog and shared nudge modules. DSH native tools,
context/state and completed-turn attribution pass. OpenCode tools, exact reads,
state carriage and manual-compaction recovery reach the loopback receiver.

The first attempt exposed a registration-order defect: OpenCode stores its tool
transform callback and invokes it per request, so waiting for that callback during
setup prevented lifecycle assembly. Assembly now completes before registering
the transformer; the transformer only publishes already-selected native tool
definitions. A deferred-transform regression test fails before this fix and
passes after it. This recheck retains the scope limits below and adds no live
provider, idle-wake, fork or reconnect evidence.

## Restrictions and remaining gates

| Boundary | Confirmed restriction or remaining question |
| --- | --- |
| DSH synchronous context callback | Cannot await daemon I/O there; prepare at asynchronous admission and expose the bounded snapshot |
| DSH `agent/request` | Replaces call configuration, not messages; content uses the logged context channel |
| DSH `tools/result` | Observes final results; it is not an authorization veto |
| OpenCode execution completion | Does not establish true idleness; prior evidence did not observe `session.created` or `session.idle` |
| Claim outcomes | Native tool identity alone does not establish admissible lineage or correctness witnesses |
| Native lifecycle | Fork/reset/reconnect generations, live idle wake and desktop loading need separate execution evidence |
| Final delivery | Context preparation stays unconfirmed; the loopback receiver is an experiment witness, not a general final-send API |

No absent NMG handler is treated as proof that a host cannot implement a feature. Magpie/native composition still needs authenticated session handoffs, shared budgets and one selected effect owner.

## Reproduction

Run the retained [probe](native-plugin-probe.mjs) with explicit installed host paths:

```text
node docs/experiments/runtime/native-plugin-probe.mjs --dsh-package <dsh/package.json> --opencode-bin <opencode-cli.exe> --output <evidence-directory> --exercise-hooks
```

The command owns private host profiles, loopback listeners and private NMG stores and closes them on completion. It does not restart shared hosts, alter production configuration or use external model/embedding credentials. Without `--exercise-hooks`, API-only evidence can remain partial and exit 2. The complete exercise exits 0 only after assertions succeed; failures are nonzero. It retains metadata and synthetic-marker summaries, not provider credentials or full model requests.

Focused contract tests:

```text
node --experimental-strip-types --test tests/integration/automatic-recall-opencode.test.ts tests/integration/coordination-opencode.test.ts tests/integration/opencode-board-args.test.ts tests/extensions/dsh-state.test.ts
```

The [selected API schema](artifacts/native-plugin-capabilities-2026-11-12/opencode-contract.json) deliberately omits unrelated definitions and does not replace the SDK. The [Magpie design](../../design/unified-architecture/magpie-integration.md) consumes these native findings while retaining full standalone-plugin and composed-session validation.
