# Recall context and display profiles

[简体中文](recall-context-and-display.zh-CN.md) · [Terms](recall-context-and-display.terms.yaml)

**Status:** current
**Related:** [InformationView](state-spaces.md), [automatic recall budget](session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.md)

## Candidate ordering

The shared daemon search path reorders session-bound results after retrieval and
before feedback staging. Automatic and explicit search share the same ordering,
independent of display mode. The candidate page, canonical IDs, scores, retrieval
options and graph references remain intact. This pass does not remove candidates,
increase the retrieval limit or perform another provider call. Preserving a page
preserves recall at its full size; it does not guarantee recall at a smaller cutoff.

Native turn admission supplies only the user prompt and project identity. The
daemon retains a bounded recent-prompt window per session. Assistant replies, tool
results and board state are not inputs to this window. Project changes discard
the previous project's prompts. Session release, cache eviction and daemon restart
discard context; display settings have a separate daemon-local lifetime.

The latest request supplies the primary lexical signal. Recent substantive user
context supplements terse continuations or requests overlapping that topic. A new
unrelated topic does not inherit the previous topic's overlap signal. The bounded
word segmentation ignores numeric-only terms and long hexadecimal identifiers.
Original rank provides a stable prior and tie break. Lexical overlap is a weak
ordering signal, not a relevance label or evidence of truth. Semantic matches
without word overlap stay available through the retained page and exact get.

## Presentation and disclosure

Automatic recall uses a session-local `compact` or `full` display profile. Compact
limits candidate count and statement length; full retains all retrieved statement
bodies subject to the combined output budget. Full does not include raw evidence
or remove context limits. Forgotten records remain redacted in both modes.

The compact projection carries the selected profile. Shared candidate preparation
applies Unicode code-point truncation before producing InformationView rows;
reference IDs, graph scope, temporal labels and preview status are preserved.
InformationView preparation admits whole rows and includes wrappers in its budget.
Both profiles remain candidate previews, even when an entire statement fits.
Exact record/evidence disclosure requires the existing get path and its receipts.

Pi uses the same candidate views inside its combined context output. OpenCode,
DSH and WorkBuddy use the shared automatic recall preparation. Adapters do not
clip the final prepared fragment or treat omitted candidates as delivered.
Historical UI recall is separate from the current turn's injectable generation;
a missing fresh result does not authorize reinjecting an old snapshot.

## Session controls and limits

`sessionActiveGraph action=recallDisplay` reads the profile, or sets it with
`mode=compact|full`. Settings affect the named session only. Restart and explicit
session release restore the compact default; evicting the recent-context cache
does not reset an explicitly selected mode. Ordinary explicit search retains its
existing presentation, and get continues to load exact selected records.

CLI usage is owned by the [memory operating reference](../../skills/nmg-memory/references/recall.md).
Initial values and tradeoffs are recorded in the [decision](../decisions/implemented/2026-10-07-shared-information-output.md#contextual-recall-and-display-profiles).
Tests establish page preservation, topic isolation, mode separation, redaction and
shared service wiring. They do not establish natural-conversation relevance gains
or downstream answer quality. Those require held-out conversation evaluation.
