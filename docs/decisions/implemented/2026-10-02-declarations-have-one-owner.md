# Declarations have one owner

[中文](2026-10-02-declarations-have-one-owner.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Mechanism, not policy](2026-09-21-mechanism-not-policy.md), [The frame and its storage](../proposed/2026-09-21-the-frame-and-its-storage.md)

## Problem

An opaque dispatch ticket does not make persistence opaque. The store parsed patch fields, while the frame proposal retained typed Task-Unit declarations. Treating these as competing formats would duplicate the task body. Also, frozen path lists cannot restore the bytes a worker actually received: rebuilding a delivered attempt from today's workspace changes its declaration.

## Decision

The protocol owns declaration meaning and encoding; its adopter owns execution freezing and restoration. The store supplies the database connection and transaction, and the board owns coordination state. The normative storage contract is in [task-unit semantics](../../design/task-unit-semantics.md#声明存储与恢复).

The default protocol retains `task_run_tasks`. Its schema, normalized types, serialization and complete-definition retry comparison have one owner, `task-unit-declaration-store.ts`. Store methods are compatibility forwards to this default adapter, not evidence that every peer protocol uses its fields. The same SQLite connection remains available for atomic board and run writes.

A patch claim records immutable attempt inputs and explicit normalization parameters in the existing fact log. Instruction and permission lists remain authoritative in the typed task row; they are not repeated in a payload. The input receipt binds the reconstructed execution declaration's digest. Claim, receipt and claim fact commit together or roll back together.

Restoration consumes the original bytes and parameters, not the current workspace. Unknown receipt versions, malformed records and digest mismatches are refused. An old delivered attempt without a receipt is refused explicitly rather than silently rebuilt. Plan digest, execution declaration digest and artifact digest remain distinct identities.

Both storage adapters remain classified policy on the maintained scan surface. Moving parsing and DDL does not establish a policy-free store.

## Alternatives considered

- **Duplicate the task definition in board JSON.** Rejected: two independently mutable definitions compete for authority.
- **Migrate all protocols to one JSON format.** Not required to establish ownership; it adds a migration without fixing who interprets the document.
- **Put protocol tables in another database.** Rejected for this slice: it loses the existing single-transaction boundary without providing logical separation.
- **Re-read the workspace when judging.** Rejected: paths alone do not recover the original execution inputs.

## Consequences

Input receipts increase stored bytes, bounded by the existing frozen-work size limits. Legacy attempts without receipts remain readable but cannot be judged by rebuilding live inputs. Declaration retry equality covers the whole normalized definition, including permissions, effect and revision. [Restoration regressions](../../../tests/integration/ooo-declaration-restoration.test.ts) exercise reopening the database, read-only reconstruction, rollback and corrupt receipts.

## Deferred

Acceptance remains a host-supplied callback; its serializable recovery configuration is not implemented by this receipt. The four-role peer interface, protocol selectors, board payload columns and production peer installation remain outside this slice. The frame proposal stays proposed.
