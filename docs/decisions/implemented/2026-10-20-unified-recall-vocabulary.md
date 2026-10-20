# Recall vocabulary as data with one rotating pool

[中文](2026-10-20-unified-recall-vocabulary.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Session-only recall cue trial](2026-10-15-session-recall-cues.md)

## Problem

Recall entry was split into two owners with different lifetimes. Intent triggers
lived in nineteen regular expressions that were permanent, exempt from capacity
and unchanged by any observed use, so a wrong or dead trigger could only be fixed
by editing code. Phrases learned during a session lived in a separate
eight-entry cache with no relationship to those triggers. Adding a word required
writing a pattern, and nothing ever retired a stale one.

## Decision

The vocabulary is data. `src/core/recall-vocabulary.ts` lists terms, and each
term carries its phrase, whether it selects `retrieve` or `cue`, and optional
intent bounds: words before or after inside a gap, sentence scope, query start,
or a following name. Adding, changing or retiring a trigger edits that list;
no new regular expression is required. `src/core/recall-matcher.ts` applies those
bounds and `src/core/recall-pool.ts` owns retention.

One rotating pool holds both origins. A session pool is seeded from that
vocabulary and admits learned phrases into the same capacity, so there is no
separate cache and no seed immunity. Retention is a segmented LRU driven only by
original user input: a match in a distinct user turn is a use, the second
distinct turn promotes the entry into the protected segment, and repeated matches
inside one turn are not further uses. Protected overflow demotes the least
recently used protected entry; capacity pressure evicts the least recently used
unprotected entry. Automatic recall, injected context, answers and tool output
never update recency, so the system cannot keep a term alive by talking about it.

Outside the `recall_gate` lease, classification stays stateless against the seed
vocabulary, preserving existing entry decisions. Inside the lease the session
pool is authoritative, including the decision `none`: a term that was evicted or
removed cannot be resurrected by lookup, and the pool is not refilled from disk.
When several entries match, a `retrieve` entry wins, so a learned phrase cannot
downgrade an explicit recollection question.

## Alternatives considered

- Keep permanent trigger patterns and add learned phrases beside them: two
  lifetimes for one behavior, so the pool never reflects which triggers actually
  work.
- Derive retention from the collected recall corpus first: the user rejected
  further collection and strict derivation as a precondition for a usable rule.
- Weight entries by how often they matched: a term that keeps matching its own
  injected context would protect itself without any independent evidence.
- Drop the intent bounds along with the regular expressions: bare `what`, `用` or
  `remember` would fire on ordinary requests, and `你记得把测试跑完` would be read as
  a recollection question.
- Add per-entry clocks or turn-count expiry in the same change: that tightens
  retention at the same time as it changes eviction order, so a later result
  could not be attributed to either.

## Consequences

A trigger that stops being used loses its slot to one that is used, including a
built-in one, and the vocabulary is edited as a list rather than as code. The
intent bounds remain a lexical proxy: they cannot tell a genuine recollection
request from a quoted one, and a term removed for one session stays removed only
for that session. Capacity is 128 entries per session with at most 64 protected;
both are constants in the vocabulary module, not measured optima. The pool is
session-scoped, so no cross-session promotion is defined, and matching still does
not certify intent, search success, necessity or benefit.

## Deferred

Parameter calibration from natural use (capacity, protected share, promotion
threshold), turn-count expiry, and any cross-session promotion remain separate
work. No deployment, default activation or natural quality/cost claim is part of
this change.
