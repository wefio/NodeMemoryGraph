# Board governance and capability addressing (proposal)

[中文](2026-09-06-board-governance-addressing.zh-CN.md)

**Status:** proposed
**Relates to:** [board-find-serial-a2a-compat-2026-08-13](../../design/board-find-serial-a2a-compat-2026-08-13.md),
[agent-convergence-feedback-design](../../design/agent-convergence-feedback-design.md)

## Problem

The NMG task board is a stigmergic coordination medium: autonomous agents
coordinate by reading and writing a shared set of typed, attributable entries,
not by point-to-point control. This is the right base model, and it already
provides addressing (`to=`), claim/release/resolve ownership, acknowledgement,
serial single-owner promotion, wake, and `memory=<id>` pointers.

Real multi-agent use (this batch of coordinated reviews, three agents) exposed
friction, and an independent analysis of OpenAI's Hugging Face incident
provides grounded "pit from real use" evidence for which semantics matter. The
friction and the incident point to the same two gaps:

1. **Format / read cost.** `read` returns whole long entries concatenated; a
   re-sync burns context even when the state has not changed. Memory pointers
   save *content* cost but not *state-sync* cost. Discoverability is weak:
   to find work you must read every channel; there is no "what should I handle"
   view.
2. **Protocol / correctness.** A task is finalized (`resolve`) by its claimer
   alone; nothing lets an independent reviewer block a premature completion.
   In the HF incident the shared board let agents spread "how to pass the
   grader", corrupting the measurement itself, and a hard-deadline "GO" from a
   peer overrode a hesitant agent. Those are the same failure the design doc
   calls "board resolve is a biased self-report signal" (§3.8 of
   agent-convergence-feedback-design).

First-principles, a good board must satisfy six roles: shared artifact medium
(external memory), capability addressing, single ownership with timeout/
takeover, trusted identity and content authenticity, **termination integrity**
(a task is done only via a reviewable finalize), and **scope isolation** (not
every agent sees one board). The board also feeds the global calibrator in the
agent-convergence design, so its termination integrity is what turns `resolve`
into a usable (de-biased) training signal.

## Proposal

Two axes. Borrow the *semantics* the incident validates; keep NMG's traits
(memory pointers, A2A, single owner, waker, context frugality). Do **not**
adopt the incident's freeform shared-storage model.

### Format axis (reduce read cost, keep entries typed and pointer-first)

- **F1 Compact read model.** `read` returns short structured summaries by
  default (id, kind, state, one-line body or `memory=<id>`, whether it is
  addressed to me, whether it is un-acknowledged), not concatenated full text.
  Full text is an explicit `detail`/`nmg_get` expansion. This bounds per-sync
  context regardless of channel size.
- **F2 Inbox / pending view.** A single "what should I handle" read over my
  subscribed channels: actionable and not yet handled entries addressed to me
  (directed or un-directed that I may claim). Replaces channel-by-channel
  polling.
- **F3 Pointer-first bodies (formalize).** Keep bodies allowed to be only a
  `memory=<id>` pointer expanded on demand; the board is *external memory*, the
  truth lives in durable memory. This is the legitimate version of the HF
  incident's "shared storage as external memory".

### Protocol axis (correctness; borrow the incident's lessons)

- **P1 Reviewable finalize (VETO).** `resolve` is not the claimer's unilateral
  self-report. An independent review role on the entry can block a premature
  finalize; finalize carries an auditable trail. Keeps serial single-owner
  execution; adds an explicit veto path only where an independent reviewer is
  present. This is the mechanism behind "de-bias board resolve".
- **P2 Content authenticity.** Every entry carries a lightweight content hash
  (tamper-evidence, audit) by default; full Ed25519 signing is opt-in and only
  when entries cross a trust boundary. Writer attribution + `agent_id` remains
  the base.
- **P3 Scope isolation.** Entries may target a visible-agent subset / group,
  so a runaway population is contained and boards are not all-to-all by
  default.
- **P4 Capability addressing.** A work item carries a `need`/capability field
  so it can be matched to a capable agent without a manual
  `discover`-then-name step (a zzINFO-like "work finds the agent"). Reuses the
  existing roster/identity; it is an addressing convenience, not a new
  scheduling layer.

### Non-goals (deliberately not adopted)

- Freeform shared-file storage (HF-style): keep typed entries + attribution +
  scoping.
- Contract-Net multi-bid task allocation: the incident's internal
  competition/interference and our single-owner safety argue against it.
- Coercion primitives ("GO" + hard deadline): keep per-agent independent
  judgement.
- The board as the source of truth: it stays a temporary coordination medium;
  durable memory is the truth store.

## Alternatives considered

- **Adopt a full Linda tuple-space / ZooKeeper / Contract-Net stack.** Rejected:
  high surface and context cost; multi-owner bidding reintroduces duplicate
  doing and interference that serial single-owner deliberately prevents.
- **Keep the board and only improve docs/conventions.** Rejected: the friction
  is structural (read model, discoverability, no reviewable finalize), not a
  documentation gap.
- **Freeform shared-board files (HF style).** Rejected: untyped writes and no
  per-entry scope/authenticity are exactly the properties that let an incident
  board become a blind spot.

## Acceptance criteria

- `read` returns compact summaries by default; full text requires an explicit
  expansion, and a channel with many unchanged entries does not grow per-sync
  context.
- An inbox/pending view lists actionable, not-yet-handled entries addressed to
  me.
- An independent reviewer can block a premature `resolve`; the finalize keeps
  an auditable record (who claimed, who verified, who finalized).
- A work item with a `need` field surfaces to a capable agent without a manual
  discover-then-name step.
- Entries carry a content hash by default; signing is available for
  cross-trust entries.
- Scope restricts an entry's visibility to its authorized agent subset.
- Single-owner execution and wake frugality are preserved (no regression to
  all-to-all broadcast or duplicated work).

## Risks

- **Added semantic surface** contradicts "reduce complexity". Mitigate: make
  F1–F4 and P1–P4 additive and opt-in; keep one default path simple.
- **VETO stalls progress.** Mitigate: veto applies only where an independent
  review role exists, carries an audit record, and cannot be used by a claimer
  to block its own already-finished work.
- **Signature cost / performance.** Mitigate: default is a lightweight hash;
  signing is off unless a trust boundary is crossed.
- **Scope mistakes hide work.** Mitigate: the inbox view is the fallback that
  shows pending actionable work even under tight scope.

## Follow-up relation

The board is the event stream feeding the agent-convergence calibrator
(§3.7/§3.8). Protocol changes here (P1 termination integrity, P2 authenticity,
P3 scope) are the mechanism base for "reconcile de-biases board resolve and
measure the false-complete rate"; the format changes (F1–F3) make the board
affordable as a high-frequency surface. This proposal records the semantics and
priorities; concrete field/verb design is a subsequent implementation slice.
