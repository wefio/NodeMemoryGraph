# Shorter shared disclosure copy

[中文](2026-10-10-shared-disclosure-copy.zh-CN.md) · [Terms used](2026-10-10-shared-disclosure-copy.terms.yaml)

**Status:** implemented
**Approved:** auto

## Problem

Search/get messages repeat a row-format legend and field descriptions even though
candidate/evidence lines carry named fields. That wrapping occupies context on
each disclosure. Removing previews or records would confound a presentation
change with an information or retrieval-budget change.

## Decision

Compress the shared YAML disclosure copy, not the underlying surface. Retain
interpretation safeguards and exact-read/withdrawal guidance while removing the
duplicate row template and redundant metadata titles. Generate runtime prompts
through the existing build. No adapter-local replacement policy is added.
Feedback copy names its full graph ID once at the actionable call while retaining
all named feedback labels and omission-on-guessing guidance. A search header can
independently carry the same ID for exact reading; this is not cross-role erasure
or ID shortening.

The normative owner is [Agent Surface](../../design/design.md); the
[fixed comparison](../../experiments/retrieval-quality/shared-output-2026-10-10.md)
records the domain, measurements, and verification limits. The
[UUID repetition comparison](../../experiments/retrieval-quality/uuid-dedup-2026-10-11.md)
separates implemented copy deduplication from unimplemented identifier research.

## Alternatives considered

- Shorter previews, fewer candidates, and short ID aliases: change the available
  information or retrieval contract; excluded from this slice.
- A new compressed row/table format: adds compatibility work while the existing
  named rows already carry the data.
- Removing old messages or adding host compaction hooks: changes history/cache
  behavior instead of reducing the size of each shared disclosure.
- Removing nudges or feedback/claim-outcome duties: distinct responsibilities,
  not necessary to compress search/get wrapping.

## Consequences

Consumers of the shared copy receive shorter future disclosures. Candidate and
exact-evidence bodies, structured RPC/JSON results, IDs, preview limits and
selection remain unchanged. Caller-provided copy and bare rendering are not
rewritten. Literal preamble/postamble prose is presentation, not a wire version.

This change does not establish better relevance, task success, provider-token
savings, cache behavior or compact frequency. Historical messages and active
runtime deployment are outside the slice.
