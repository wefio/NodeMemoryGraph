# Historical D7 conversion findings

[中文](d7-findings.zh-CN.md) · [Terms used](d7-findings.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## Historical D7 conversion findings

This record concerns an attempted conversion of the retired round runner. It is not evidence about the current daemon `taskRun` path; the round subject was removed on 2026-09-18 ([decision](../../decisions/implemented/2026-09-18-retire-the-round-instrument.md)).

1. The round passed the Store an object whose `specs` map it continued to fill task by task. A host-owned Store could not observe those mutations, so the first conversion produced 33 failures with `patch task has no host spec`. The attempted fix added an explicit owner operation, `installPatchTask(id, spec)`, and routed the round through it rather than mutating a shared record.
2. `evals/ooo-execution/round-runner.ts` had a local `openRoundStore` that validated an existing Store rather than creating it. Moving Store creation to the host required distinguishing the imported Store factory from the local validator at the call site.

The recorded attempt went from 33 failures to 4 after those changes; the remaining failures were the `round-runner` name collision. The conversion was reverted, so these results are historical evidence about that attempt, not a verdict on the later daemon run-record path. For changes under `evals/**`, the [repository-development workflow](../../../skills/repo-development/SKILL.md) runs the relevant eval suites as the first verification step.
