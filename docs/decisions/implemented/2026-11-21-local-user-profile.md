# Project the local user profile from current memories

[简体中文](2026-11-21-local-user-profile.zh-CN.md) · [Terms used](2026-11-21-local-user-profile.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Stable personal preferences can help on a matching turn. Including a whole
profile on every turn spends context on details unrelated to the current request.

## Decision

The local profile derives from user-attributed preferences and constraints
in an explicit scope. The existing records own attribution, evidence, validity,
replacement and withdrawal. A profile entry joins automatic recall through a
matching trigger and shares its candidate and context budgets.

## Alternatives considered

A separately maintained summary would need to track every correction and
withdrawal. A projection keeps the lifecycle with the evidence. Unconditional
injection would spend context on every turn.

## Consequences

Profile selection runs locally without a separate embedding request.
The explicit scope lets callers inspect the complete profile and update its
source records. Shared evidence IDs support navigation in both directions.

The [recall contract](../../design/recall-context-and-display.md#user-profile)
owns admission, rendering and maintenance links.
