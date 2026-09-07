# Register every hidden (env-gated / non-default) feature

**Status:** implemented
Date: 2026-09-07
Branch: feat/meta-rule-governance

Governing meta-rule: [self-governance meta-rule](../implemented/2026-09-07-self-governance-meta-rule.md) — this rule change is itself recorded as a governed decision (decision + registry + alternatives) under it.

中文版: [2026-09-07-register-hidden-features.zh-CN.md](2026-09-07-register-hidden-features.zh-CN.md)

## Problem

NMG ships many capabilities that are not active by default and are switched
through environment variables or mode flags: controller shadow evaluation,
learned fold (QPP1/QPP2), controller rerank, search-recommendation nudge, lab
tools, and the online context-use learner. There is no single place that says
what these features are, which gate turns them on, what their default is, who
owns them, and whether they are live, shadow, experimental, dormant, or merely
planned.

That opacity caused a real defect (2026-09-07): the online context-use feedback
loop exists (the daemon stages every auto-recall graph) yet never produced a
single real feedback row in production. The only feedback prompt that exists
(`shadow_feedback_nudge`) is wired to the old controller-shadow feature and
gated behind `NMG_CONTROLLER_SHADOW`; the online path has no prompt of its own.
Because hidden features are scattered across adapters and sources and are not
registered, this dead link was invisible until the user traced it by hand.

The failure mode is general: an agent cannot audit, enable, or hand off a
feature it cannot enumerate, and a feature nobody can enumerate drifts until it
breaks silently.

## Decision

**Every hidden feature must be registered.** A hidden feature is any capability
that is not active by default in the running system, in particular anything
gated by an environment variable or a mode flag (`off`/`shadow`/`active`,
opt-in `=1`, or opt-out `!=0`).

Rules:

1. **Central register.** All such features are listed in
   `docs/design/hidden-features-registry.md`, the single inventory of record.
   It covers every known entry regardless of ownership and regardless of status
   (default-on, opt-in, shadow, experimental, dormant/superseded, in progress,
   or planned-but-not-built).
2. **Registration is unconditional.** A feature must be registered whether it
   is owned by the core team, an adapter (pi / DSH / other), a previous agent,
   or is still being built. "I did not build it" and "it is not finished" are
   not reasons to skip the entry.
3. **Add on creation.** Any change that adds a new env gate or mode flag must
   add (or update) the registry entry in the same change. No hidden feature is
   introduced without an inventory row.
4. **Update on change.** Changing a gate name, default, owner, or status updates
   the entry; moving a feature between default-on and opt-in updates its status.
5. **Register gaps too.** An intended capability that exists only as a dead link
   or missing wiring is registered as a planned/open entry so it cannot silently
   disappear again (this is how the missing online feedback prompt is tracked).
6. **Registry is the seam.** `docs/design/hidden-features-registry.md` is a
   living ledger, not a dated decision. This note records the rule; the ledger
   records the facts.

## Alternatives considered

- **Keep features documented inside their own module only.** Rejected: module
 -local notes are exactly the scattered state that hid the feedback dead link;
  an auditor needs one enumeration point.
- **Automate discovery (scan env vars) instead of a hand registry.** Partially
  useful but insufficient: an env scan cannot express status, ownership, or
  intent, and it misses constructed gate names (e.g. mode flags read through an
  `environment` parameter, not a literal `process.env.X`). The registry is the
  source of truth; an automated scan may later cross-check it.
- **Gate the rule on agent:verify.** Deferred: wiring enforcement into the
  verify pipeline is a separate, larger change. The registry contract plus the
  AGENTS.md pointer is the standing rule for now.

## Consequences

- One place answers "what hidden features exist, how is each enabled, who owns
  it, what state is it in".
- New env-gated work carries a registry row as part of its normal change.
- The online-feedback dead link is now visible as a registered planned entry
  rather than an invisible assumption.
- A future automated scan can validate the registry against the code, turning
  the hand rule into a machine check.

Related: [hidden-features-registry](../../design/hidden-features-registry.md).
