# Native DSH and OpenCode plugin capability audit

[中文](native-plugin-capabilities-2026-11-12.zh-CN.md) · [Terms](native-plugin-capabilities-2026-11-12.terms.yaml)

## Question and result

Which NMG gaps can DSH and OpenCode fill natively, and which actually require a
gateway? The existing [adapter matrix](../../design/harness-capability-matrix.md)
and [OpenCode decision](../../decisions/implemented/2026-10-17-opencode-adapter.md)
are the starting evidence, not a missing specification to recreate.

Both hosts expose native paths for core NMG integration. This audit found no
evidence that either fundamentally needs Magpie for working-state carriage,
memory tools, tool-result observation, diagnostic attribution or board access.
That finding does not mean those NMG paths are implemented or verified end to
end. Remaining questions concern integration, timing and evidence semantics.

## Targets and evidence strength

| Target | Evidence | Limit |
| --- | --- | --- |
| NMG | Source at `970e70ee` plus 20 passing adapter fixture tests | The fixtures execute NMG adapters against fake host entry points and private HTTP services, not live desktop hosts |
| DSH source | Public commit `687f282e8625c6b8d11ff58211a90524be2e4317`, checkout manifest `0.2.1-rc.2` | Source review is separate from the installed package probe |
| DSH installed core packages | `dsh-system-prompt`, `dsh-tools`, `dsh-agent` `0.2.1-rc.5`, module SHA-256 recorded in the artifact | Only prompt/tool services ran; the desktop bundle and full Agent loop did not |
| OpenCode | Installed CLI version file `2.0.32`; binary SHA-256 recorded; private `api --standalone` calls | A CLI binary's API describes server operations, not the complete in-process plugin SDK |
| Historical OpenCode runtime | The October 17 decision records real 2.0.32 recall injection, Code Mode tools and execution-completion attribution | This audit did not repeat those provider-backed runs |

The exact OpenCode 2.0.32 source/SDK could not be fetched through the attempted
GitHub paths. No current or v1 SDK was substituted. DSH's installed declarations
also confirm the inspected native event names, but versions are not assumed
identical merely because the names match.

## DSH native contracts

The fixed source supplies these concrete paths:

| NMG behavior | Native path | Classification |
| --- | --- | --- |
| Maintained working state in model context | [`SystemPrompt.context`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/system-prompt/src/index.ts), refreshed at request admission by the [Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts) | Native path available; NMG's dedicated state preparation/carriage still needs wiring and tests |
| Tool results into AG and completion nudges | [`tools/result`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts) emits final results, including errors, with execution identity; pre/post-execute waterfalls are separate | Native result path available; NMG observation filtering and lineage mapping are implementation work |
| Diagnostic answer attribution | [`agent/turn-stopping`, `agent/status`, `agent/assistant-stream`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts) plus [`session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts) | Native boundaries exist; select committed answer events and test canceled/continued turns before flushing |
| Busy/idle and directed wake | Agent status, `send`, `followup`, `steer`, disposal and native session identity | NMG already wires portions of this; no need to infer idleness from gateway silence |
| Clear/compact/resume fencing | Agent creation source includes startup/resume/clear/compact; session log and lifecycle events are available | Mapping those boundaries to NMG generation/fences needs end-to-end validation |

The installed prompt/tool probe passed four checks: dynamic context refresh,
selection using the supplied assembly identity, contribution disposal, and
frozen final success/error tool notifications. The identity check is not an
authentication or tenant-isolation test. It does not prove NMG state was sent to
a real model. Agent lifecycle events above were reviewed, not exercised by that
service-level probe.

## OpenCode native contracts and observed API

The existing NMG binding uses `ctx.session.hook("prompt"|"context"|"compaction")`,
`ctx.tool.transform`, `ctx.tool.hook("execute.after")`, event subscription and
`ctx.session.prompt`. The October 17 record supplies historical runtime evidence.
Calling this a `llm` context hook is incorrect for this adapter.

The private CLI server additionally returned these actual APIs:

- `session.get` returns `Session.Info`, including required `location` and
  optional parent/fork/outcome fields.
- `session.context`, `session.prompt`, `session.compact`, `session.fork` and
  `event.subscribe` exist. The session log endpoint is experimental.
- A synthetic session was created and then read through `session.get` before
  any prompt. Its directory was available. Therefore late event mapping is an
  NMG lookup limitation, not proof that OpenCode cannot supply first-turn scope.
  The plugin SDK mapping and its deadline behavior still need testing.

The private config API confirmed the synthetic plugin configuration. However,
API-only session/config queries produced no plugin setup receipt and plugin
listing was empty. This does not reproduce plugin activation during inference.
The retained probe exits **2**, preserving that incomplete result; it is not a
fully passing plugin smoke test. An exploratory CLI run with a nonexistent
provider timed out and supplied no additional evidence. No successful inference
or hook invocation is claimed from that attempt.

## Actual restrictions and unresolved questions

| Observation | What it rules out | What remains possible |
| --- | --- | --- |
| DSH context text callbacks return strings synchronously | Awaiting daemon I/O inside that callback itself | Prepare asynchronously at an admitted native boundary, then provide the bounded snapshot; test refresh and cancellation ordering |
| DSH `agent/request` replaces frozen call configuration and cannot mutate messages | Using that hook as an arbitrary unlogged message rewrite | Use the logged `SystemPrompt.context` channel for content |
| DSH final result notifications are observations with contained listener failures | Treating `tools/result` as an authorization veto | Use pre-execute policy for a gate, with its own supported semantics |
| The prior OpenCode 2.0.32 smoke observed no `session.created`/`session.idle` notifications | Depending on those exact event names for initialization/completion | Query session information and use execution events; exact queue/idle/reconnect semantics remain unverified |
| Prepared context and execution success provide no correctness witness | Treating these as proof of final provider delivery, memory correctness or positive feedback | Keep delivery evidence, diagnostic overlap and explicit supported feedback separate |

No core-feature impossibility is inferred from an absent NMG handler. Claim
outcome lineage, fork/reset/reconnect generations, real idle wake, cancellation
and final-input receipts retain integration gates. An HTTP API alone does not
prove an equivalent plugin method or callback order.

## Reproduce and consume

Run the retained [probe](native-plugin-probe.mjs) with explicit installation paths:

```text
node docs/experiments/runtime/native-plugin-probe.mjs --dsh-package <dsh/package.json> --opencode-bin <opencode-cli.exe> --output <evidence-directory>
```

It uses real installed DSH services and private OpenCode profiles, captures
metadata/synthetic markers, and removes its disposable profiles. It does not
restart the shared daemon, change live profiles or invoke real providers.
Exit 0 requires a synthetic plugin registration receipt; exit 2 preserves
partial evidence; other failures remain nonzero.

The [result](artifacts/native-plugin-capabilities-2026-11-12/native-plugin-probe.json)
records versions, module/binary digests and tested/unverified surfaces. The
[selected API fragments](artifacts/native-plugin-capabilities-2026-11-12/opencode-contract.json)
record the schema digest and intentionally omit unrelated schemas; they are not
an SDK replacement.

The fixture run was:

```text
node --experimental-strip-types --test tests/integration/automatic-recall-opencode.test.ts tests/integration/coordination-opencode.test.ts tests/integration/opencode-board-args.test.ts tests/extensions/dsh-state.test.ts
```

All 20 passed. This supports existing NMG wiring and regression coverage only.
The [owning matrix](../../design/harness-capability-matrix.md#native-host-capability-findings)
classifies the gaps; the Magpie design consumes those classifications while
keeping a complete independently usable plugin target.
