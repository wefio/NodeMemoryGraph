# A counterexample needs a reproducer

[中文](2026-09-09-counterexample-needs-a-reproducer.zh-CN.md)

**Status:** implemented  
**Approved:** explicit  
**Relates to:** 2026-09-09-assertion-domain-and-strength

## Problem

Two ways of challenging a claim are treated the same today: an opinion that something
looks wrong, and an input that shows the claim is false. Only the second is a
counterexample, but neither has a channel, and no artifact records one that is raised
and not yet settled.

The missing artifact shows up in the stop condition — all proof obligations closed,
all valid counterexamples resolved, remaining assumptions and uncovered scope stated.
The first clause has the RTM ledger, the third has the assumption register and the PR's
`## 未验证项`. **The second has no home**, so a challenge that is raised, argued about,
and left unfinished disappears when the conversation ends.

Measured 2026-09-09: every verification failure this repository has observed is of the
opposite kind — a broken oracle, a directory glob raising `MODULE_NOT_FOUND`, a false
green from an inherited `NODE_TEST_CONTEXT`, documentation claiming unimplemented
work. No run of this project has recorded a pile of spurious Agent criticisms. This
rule is therefore aimed at a problem that has not been observed here, and it says so
below.

## Decision

A ledger at `.rcp/counterexamples.yaml`, one entry per challenge:

```yaml
- id: ce-2026-09-09-001
  claim: apply-requires-harness-boundary
  status: open # open | resolved | unsubstantiated
  reproducer: | # required while status is open
    node --experimental-strip-types tools/agent-verify.ts -- .rcp/contracts
  observed: apply proceeded with no harness boundary
  resolution: # required once resolved
    revised the domain statement; the case was outside it
```

Rules:

- an `open` entry **must** carry a `reproducer` — a command, an input, or a case that
  someone else can run;
- `claim` names what was challenged — an assertion id, a check name, or a document. It
  does not have to resolve: a challenge against something not yet in the ledger is
  often the valuable one;
- `unsubstantiated` exists so an unfalsifiable concern can be written down without
  blocking anything, and without being dressed up as evidence;
- a resolution names what changed: the product, the evidence, or a `domain`
  statement.

A malformed entry, or an `open` entry without a reproducer, fails `docs:check`.

## Alternatives considered

- **Say it in the PR or the conversation.** Rejected: the conversation ends, and the
  PR is not what the next Agent reads when looking for open challenges.
- **Use GitHub issues.** The right long-term home for external reports, but they live
  outside the repository and are invisible to `docs:check`; an in-repo ledger can be
  read without network access.
- **Let the model grade its own findings** — severity, or whether a concern is real.
  Rejected: that makes the model the oracle for its own output. The point of requiring
  a reproducer is that someone **other than the reporter** decides.
- **Require a reproducer for every concern, with no `unsubstantiated` state.**
  Rejected: some concerns genuinely are not falsifiable ("this API may be confusing").
  Refusing to record them loses information; recording them as open blocks forever.
- **Require `claim` to name a registered assertion.** Rejected: the most valuable
  challenge is usually raised against something that is _not_ in the ledger yet, and
  forcing resolution would suppress exactly those. The check requires `claim` to be
  named, not to resolve.

**What now has to hold:**

- a malformed entry fails `docs:check`;
- an `open` entry without a `reproducer` fails `docs:check`;
- an empty ledger passes;
- `skills/verification-traceability/SKILL.md` states the rule once and links to this
  decision instead of restating it.

## Consequences

- `.rcp/counterexamples.yaml` exists, with one resolved entry: `ce-2026-09-09-001`, a
  route-level `node-test:<route>` check that resolved even when the route's globs
  matched no file. `createResolver` now requires the route to resolve to at least one
  file before either form binds, and a regression test covers it.
- `docs:check` fails on a malformed entry, on an `open` entry without a reproducer, and
  on an `unsubstantiated` entry that carries one.
- The stop condition's second clause has a home.
- Cost: one more ledger to maintain, and a reproducer that is recorded but never run is
  not detected by anything.

## Risks

- **This rule may answer a problem this repository has not observed.** Every measured
  failure here is a false green, not over-reporting. **Repeal condition: if no entry
  is created within three months, delete the ledger and this rule.** The wording change
  and the domain column stand on their own without it.
- **A reproducer can be recorded without ever being run by the reporter.** The ledger
  cannot verify execution; it records an obligation, not a proof.
- **One more ledger to maintain.** Accepted: it is small, and it is the only home for
  the stop condition's second clause.
