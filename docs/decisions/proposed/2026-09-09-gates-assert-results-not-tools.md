# A gate asserts a property of the result, never the identity of the tool

[中文](2026-09-09-gates-assert-results-not-tools.zh-CN.md)

**Status:** proposed

## Problem

Research on 2026-09-09 asked why Agents keep writing one-off scripts when
standardized, convenient tools already exist. Three findings converge:

- **The preference is model-level.** In a 17,000-run tool-selection study,
  OpenAI GPT-4o/Codex-family Agents favoured writing inline scripts to process
  files over targeted tools, accepting roughly twice the token cost;
  Claude-family Agents favoured `ripgrep` (68% of search tasks) and Cursor
  favoured AST queries.
- **The reward structure rewards it.** *The Tool-Overuse Illusion*
  (arXiv 2604.19749) shows models suffer a knowledge epistemic illusion about
  their own capability boundary, and that outcome-only rewards *increase*
  unnecessary tool calls (up to +65% as training steps grow), while balancing
  rewards cuts them by 66.7%/60.7% without losing accuracy.
- **It is industry-scale.** GitClear's 211M-changed-line study (2020–2024) shows
  refactoring fell from 25% to under 10% of changed lines while copy/pasted
  clones rose from 8.3% to 12.3%, with copy/paste exceeding moved code for the
  first time.

The same pattern holds here. `skills/doc-maintenance/SKILL.md` line 48 already
said status rots in prose, yet 19 of 40 design documents carried free-form
statuses. `AGENTS.md` requires `npm run agent:context` as the first step of any
change; the session that audited script usage never ran it. `nmg-rcp` is invoked
by no npm script and no workflow, while a 538-line tool composes the same library
by hand.

The mitigation literature agrees on the mechanism: *"everything you feed an Agent
through its context window is, in the end, a suggestion"* and *"an Agent that can
validate is good; an Agent that must validate is better"*. A reminder is not a
mechanism.

But the obvious next step — make the verifier require the tool — is wrong three
times over: it cannot be detected (a one-off script and a committed script are
the same bytes), it forbids legitimate variation, and a verifier that gates its
own adoption is self-certifying, which this repository already forbids
(`harness-cannot-self-certify`).

## Proposal

**A gate may assert a property of the result. It may not require a particular
tool, entry point, or file.**

The first such property, and the mechanism that actually changes behaviour:
**no part is implemented twice.** A helper, statistic, parser, or loader defined
in two files is an error, regardless of which file it lives in or how it is
named. An Agent satisfies it by using an existing part, by putting its new part
wherever it likes, or by not needing the part at all. The gate names no location.

Corollaries:

- A verifier may not gate its own adoption. RCP's checks assert properties of the
  repository; they may not require `nmg-rcp`.
- A gate that can be satisfied only one way is a tool requirement in disguise and
  needs its own decision.
- Every gate added under this rule carries its repeal condition in the same
  decision.

## Alternatives considered

**Remind the Agent in a Skill.** Rejected: the repository has run this experiment
twice already — the status rule and the `agent:context` rule — and the mitigation
literature is explicit that context-window instructions are suggestions.

**Require the tool in the verifier.** Rejected: undetectable, forbids variation,
and self-certifying.

**Delete the unused entry points.** Rejected: it removes product surface and does
not change the behaviour that produces one-off scripts.

**Do nothing.** Rejected: GitClear's data shows the trend is industry-wide and
does not self-correct.

**Register every entry point
(`2026-09-09-register-every-entry-point`).** Kept, but demoted. It answers "what
is this for", not "will it be used". It is documentation, not enforcement.

## Acceptance criteria

- The duplication check fails on a part defined twice and passes on the same part
  defined once; `tests/` covers both.
- The failure message names no file, tool, or entry point that the Agent must use.
- No RCP check requires `nmg-rcp`; the checks assert repository properties.
- This research is cited in the decision, so the next reader does not repeat it.

## Risks

- Body comparison is approximate: a renamed copy with a changed line passes.
  Accepted: the gate is a floor, not a proof.
- A gate on results still coerces behaviour. Stated, not hidden: the coercion is
  toward a property the repository already holds (DRY), not toward an
  implementation.
- Deduplication can be satisfied by promoting the worse implementation.
  Accepted: ranking quality is a review matter, and no gate can do it.

## Deferred

- The parts shelf — making reuse cheaper — is a separate change and is not a
  precondition for this one.
