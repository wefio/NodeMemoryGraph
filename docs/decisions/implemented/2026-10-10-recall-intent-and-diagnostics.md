# Recall intent and bounded degraded diagnostics

[中文](2026-10-10-recall-intent-and-diagnostics.zh-CN.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [Shared information output](2026-10-07-shared-information-output.md)

## Problem

A fresh-session comparison changed two variables: extension loading and the
question. The normal run used `先前`, absent from the explicit-recall lexicon;
the explicit-extension run used the recognized `之前`. That comparison cannot
attribute the missing recall to extension discovery.

Degraded search also rendered a complete embedding-provider error body, including
quota details, in model-facing candidates. Separately, a successful shutdown
archive retained its five-second deadline and kept Node alive after the write
had completed.

## Decision

Repair the synonym in the shared memory gate, not a Pi-only special case. Keep
memory-free turns and existing retrieval limits unchanged.

The 2026-10-14 bounded diagnosis extends the same decision to Chinese
recollection questions without a temporal prefix: `你记得` / `您记得` with an
interrogative marker, and `来着？`. Use question forms, not a bare `记得` or
`来着` substring, so reminders and colorization instructions stay outside these
additional cues. The [matched lexical replay](../../experiments/retrieval-quality/shared-recall-entry-diagnosis-2026-10-14.md)
locates the omission before search; it does not justify changing rankings or
retrieval budgets.

Normalize degraded reasons at the compact projection and rendering boundaries.
Preserve a known embedding/index code or an HTTP status code; use `unknown` for
unrecognized diagnostics. Keep the original structured result and daemon health
intact. Empty degraded results retain the fallback signal too.

Release the archive deadline in `finally`, including successful completion.
Keep stalled-write staging, the existing wait bound, and daemon ownership rules.

The normative owners are [Agent Surface and progressive retrieval](../../design/design.md)
and [session shutdown](../../design/session-memory-lifecycle-hooks-2026-08-10.md#3-不变的钩子).

## Alternatives considered

- Change extension discovery based on the two historical runs: rejected because
  the questions did not exercise the same gate decision.
- Delete the provider diagnostic or omit the fallback notice: rejected because
  operators and readers need distinct diagnostic and retrieval-health signals.
- Truncate arbitrary provider prose: rejected because truncation still admits
  unapproved content and loses the stable cause identifier.
- Extend the smoke-test deadline and leave the archive timer alive: rejected;
  completed work has no reason to retain its deadline.
- Modify Pi or install a transport observer: unnecessary for these fixes.

## Consequences

Shared Core and presentation changes apply to ordinary tools and RPC consumers;
Pi keeps its existing public hooks. No new executor, schema, state store,
environment flag, provider request policy, or disclosure confirmation is added.

Deterministic regressions distinguish the recall synonyms, preserve full source
diagnostics without copying provider bodies into display, retain empty-result
health, and verify deadline cleanup and stalled-write staging. These checks do
not prove the cause of every historical startup or process timeout.

## Deferred

The old 97–152-second pre-model intervals lack phase instrumentation. The
archive-timer regression accounts for a bounded post-write delay, not those
intervals or a complete Pi-process teardown guarantee. Native SDK preparation
and a complete CLI/model/exit run remain separate evidence boundaries.
