# Reuse import extraction for architecture measurements

[中文](2026-11-14-measure-architecture-dependencies.zh-CN.md) · [Terms used](2026-11-14-measure-architecture-dependencies.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [architecture direction](2026-11-05-unified-architecture-direction.md)

## Problem

An import matrix needs a reproducible definition of source references. The existing verification-impact probe already extracts TypeScript import declarations and literal call expressions, but did not expose its extractor to a separate measurement.

## Decision

Export the existing `moduleSpecifiers` function for the dated [architecture measurement](../../experiments/architecture-dependency-and-memory-2026-11-14.md). Its caller adds type-query references and groups cross-module paths. The measurement records its scope and limitations; the extractor's existing impact-planning behavior and verification gate remain unchanged.

## Alternatives considered

- Copy the extractor into a new script: creates two definitions that can drift.
- Establish a standing dependency ban from this snapshot: treats a source count as an approved architecture contract before the runtime paths and exceptions are resolved.

## Consequences

The two probes share their extraction behavior; changes to that function can change later measurements. The retained fixture checks declarations, literal dynamic imports, type queries and refusal of a dirty source snapshot. The record remains evidence, not a new boundary rule.
