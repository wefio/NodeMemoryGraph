# Keep Cordis behind a test-runtime wrapper

[中文](2026-08-25-cordis-test-runtime.zh-CN.md)

**Status:** implemented

## Problem

Integration tests repeatedly assemble temporary workspaces, SQLite stores, and HTTP daemons. Ad hoc setup and teardown obscures dependency order and can leak locked files or processes, especially on Windows. Reusing an application framework directly in product code would solve a test problem by increasing the runtime architecture.

## Decision

Use the exact development dependency `@deepseek-ai/cordis@4.0.1` only inside `tests/support/test-runtime.ts`. A narrow `TestRuntime` wrapper composes workspace, database, and in-process daemon plugins and disposes their Cordis fibers in reverse order. Product modules, published packages, and adapters do not import Cordis.

## Alternatives considered

- Continue bespoke `try/finally` setup in each test. This has fewer dependencies but repeats cleanup and hides composition mistakes.
- Adopt Cordis as the NMG application container. NMG does not need its loader, HMR, or configuration system, so this would expand the product boundary without evidence.
- Build a general internal lifecycle framework. That duplicates mature effect ownership for a test-only need.

## Consequences

Lifecycle tests get explicit dependencies and deterministic cleanup while the production architecture stays unchanged. The wrapper is the replacement seam: Cordis can be removed later without changing NMG Core. The exact version prevents unreviewed release-candidate behavior changes in test infrastructure.
