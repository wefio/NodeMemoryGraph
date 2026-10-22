# onlion AML cloud service in one canonical source tree

[简体中文](2026-10-22-onlion-aml-cloud-service.zh-CN.md) · [Terms](2026-10-22-onlion-aml-cloud-service.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Shared temporal evidence at protocol boundaries](2026-10-22-shared-temporal-evidence.md)

## Problem

The supplied AML cloud application carried a second vendored NMG source tree
(`vendor/nmg`) and lived in an untracked scratch directory, so product fixes
and the deployed application drifted apart. AML's ordered image/text contract
had no working implementation, and the first draft wired an image-description
model into the write path even though the protocol delivers a caption with
every image.

## Decision

`onlion/` is the single Git-managed source of the cloud memory application. It
imports the canonical root `src/` (`CORE_SOURCE = "workspace:src"`); no second
NMG source tree, temporal policy or prompt set is copied. Root query-term
preparation centralizes the vendored core's only effective delta with
score-equivalence tests.

Ordered `text`/`image_url` parts are validated against bounded budgets (Base64
JPEG/PNG/WebP/GIF data URLs only; per-image, per-content and per-request
limits). The retrieval view is the supplied caption text plus an opaque
per-image SHA-256 reference; no image-description model is required and none
is invoked. Original ordered parts live in native history and are returned on
Search; `raw_content` is the original evidence JSON, while `content` adds only
the shared conditional temporal prefix. Records attribute the supplied message
role (`user`/`assistant`, `asserted`); the content hash moves to marker
attributes and stays out of the retrieval statement.

Retrieval-index summaries run through the existing provider mechanism with a
deterministic extractive writer (no model): leaf digests index into the leaf
FTS routing surface, the node tier refreshes only through its multi-block
gate, and node entity terms land on the non-identity `nodeSummary` face. Node
identity names stay the stable session key because `canonical_name` is the
identity key; entity-derived names would split one session into degenerate
single-block nodes as term frequency drifts. The shared temporal lexicon
expands to word-bounded core units, derivatives, calendar names, frequency and
order words (English and Chinese) as presentation data under the existing
policy.

Repository text files normalize to LF in the repository and working copy;
Windows scripts keep CRLF and `.wasm` stays binary. `onlion/.runtime/` holds
datasets, checkpoints and history and remains untracked. The build accepts
`NMG_WORKER_NAME` and `NMG_R2_BUCKET` overrides instead of inheriting one
hosting configuration.

## Alternatives considered

- Keep the vendored tree: preserves deployment drift and a second policy and
  prompt source.
- Require a vision model on every image Add: blocks the supplied-caption
  contract and spends tokens the input already covers.
- Entity-derived node identity names: drifts with term frequency and splits
  one session into degenerate single-block nodes.
- Durable Objects SQLite storage: no `BEGIN`/`SAVEPOINT` statements and a 2 MB
  row limit; the core needs file-style SQLite transactions and FTS5.
- Compile callback stubs at request time: Workers disallow runtime Wasm code
  generation (`Wasm code generation disallowed by embedder`), so pre-compiled
  static modules are mandatory and the generator stays part of the toolchain.
  Matched-pair testing also confirmed SQLite initialization alone exercises 24
  callback adaptations, so ordinary SQL suites partially cover the machinery.
- Attribute structured content as `assistant`/`inferred`: misattributes
  user-supplied captions that never involved a model.

## Consequences

One NMG implementation serves the CLI/daemon and the cloud application;
`onlion/` cannot build without the workspace checkout, and `dist/` output is
the deployable artifact. The vendor transform is auditable end to end: the
pre-merge stub tree, its byte manifest and the loader remain in Git history,
an independently derived signature manifest of all 382 stubs matched the
merged module's type entries 1:1, and every merged export was forward-checked
at runtime (the original generation script is lost, so the generator script
plus that history is the provenance). Contract tests run in Miniflare with
simulated R2 and no external model. A real image-description path is deliberately absent, and a
real provider, production deployment, official evaluation, and a full
benchmark score remain unexercised. Service responses include fields beyond
the AML required minimum (`task_id`, `status`, `added`, `stored_at`,
`event_time`, `raw_content`), and multimodal `content` carries the temporal
prefix — a deliberate presentation deviation recorded here and bounded by the
withdrawal-safe projection.
