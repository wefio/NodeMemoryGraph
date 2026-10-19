# What the system already has

[简体中文](existing-runtime-components.zh-CN.md) · [Terms used](existing-runtime-components.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../agent-convergence-feedback-design.md).

## What the system already has

### NMG memory (STG/LTG, Task Board)

Role in the model: **state persistence**, the precondition that errors are not
absorbing — a failed session can be resumed from remembered state, and evidence
survives session boundaries. Also the natural carrier for **cross-session goal
continuity**: a goal that outlives one session is the difference between
"re-derive intent from the next prompt" and "continue a direction".

Existing: LTG/STG separation, supersession, truth-status governance, Task Board
coordination with claims and TTL.

Gap: externally approved long-term quests are **not first-class memory
citizens**. Board entries are temporary coordination (TTL, expire), not a
persistent quest store.

### RCP (Repository Control Plane)

Role in the model: the **external verifier** — expensive, sparse, unbiased
correction. Contract declares intent; observe measures reality; reconcile
detects drift (changed paths, contract-vs-reality diagnostics); receipts are
immutable checkpoints; authority (plan/apply) sizes the step.

Existing: contract/observe/reconcile, idempotent re-observation, changedPaths,
fail-closed termination, receipts.

Partial wiring: explicit CLI opt-in sends a newly recorded receipt into a named
session AG as bounded feedback (see the implementation boundary above). General
drift/lifecycle streaming, retry replay and cross-session memory admission remain
open. Continuous observation is deferred until its need is measured.

### AG (session Active Graph runtime)

Role in the model: the **in-session closed loop** — the working-memory layer
where correction happens without touching durable truth.

Existing: task frames with a bounded cooling set (state survives a task switch
and a return does not rebuild from the transcript — the recoverable-eviction
property), immutable projection revisions with parent chains (checkpoint
sequence + attribution), and `observe()` admission for tool observations, board
projections, and explicitly supplied reasoning artifacts (temporary, deduped,
budgeted). Typed edge layers stop activation/reasoning from silently reinforcing
semantic truth. Item kinds are `semantic_memory | tool_observation |
board_projection | reasoning_artifact | working_state`; semantic memories and
maintained working state enter through their own paths. Automatic MGR admission
remains deferred.

Partial wiring: RCP receipts can reach `observe()` through the explicit optional
client bridge. External file fragments are not a first-class AG content kind:
`observe()` also accepts explicitly supplied `reasoning_artifact` items, but a
bookmark ([Bookmarks (tesserae)](#bookmarks-tesserae))—an external snippet plus
path—cannot itself be added as content. Automatic MGR admission is deferred.
When a memory enters the AG as a `semantic_memory` item, only its `statement`
travels (its bookmarks do not ride along). The combined budget (§4.3 of the AG
blueprint) is partial. Adding external file content to the AG is an AG
capability; nothing else needs a new concept for it.

### Bookmarks (tesserae)

Role in the model: the component that points memory at a source-file position
and attempts to resolve a stored content snippet. With a project root, current
relocation first looks for the snippet at the stored path, then uses a file
fingerprint to bound a fallback scan; it can return the first matching line,
but repeated snippets do not establish a unique location. A bounded resolution
miss may mark the bookmark stale within the accessible view and procedure; it
does not prove that the text is absent everywhere. Without a project root, the
service does not perform this read check, so a missing stale flag is not
freshness evidence. A write-time file fingerprint anchors a file baseline when
the file is readable; if absent, a later backfill from current bytes is not
proof of the original write-time content.

A bookmark is also **content the AG should be able to ingest**: it carries an
external fragment (snippet text + path) into session working memory. AG is the
container; the bookmark is the ingestible content. This ingestion does not
happen today: memory items enter the AG without their bookmarks.

Existing: records `{path, snippet, label}` written at remember time; two-stage
relocation (exact match first, fingerprint-bounded recovery second). Drift
recovery uses an optional 64-bit SimHash fingerprint (`file_simhash`) of the
target file. The related [tessera design](../memory-tesserae-design.md#33-tesserae-are-content-anchored-not-line-anchored)
reports Hamming ≤ 6 from an earlier 5–60 KB repo-file sample, with reported
100% recall and 0.24% false positives; the underlying sample and rates were not
revalidated there, and they are not universal guarantees or measurements of
snippet fingerprints. **SimHash is the drift-detection technique inside the
bookmark component, not a separate system component.**

Gap: bookmarks are not yet ingestible into the AG as external file content.
The current fingerprint is file-based, not a fingerprint of an arbitrary
snippet. Applying the baseline-and-drift idea to other ingested content (a
contract or expected final shape) is a design proposal for reusing the bookmark
approach, not an existing capability.
