# Shared task blackboard

Read this for temporary cross-Agent coordination or a repository in-flight
registry. Ordinary single-Agent memory use does not require the board.

## Availability and identity

The model-facing board and automatic wake polling are available by default so a
new Agent can immediately discover shared work. Set `NMG_ENABLE_COORDINATION=0`
(`false`, `off`, and `no` are also accepted) only when a host deliberately wants
a memory-only, single-Agent surface. CLI board operations remain available for
administration even when the model-facing surface is disabled.

Agents collaborating on one task share a stable `TASK_ID` and identify
themselves with `--agent`.

## In-flight registry

For repository development, an open `goal` entry may serve as an in-flight
work registry. Create it once immediately before the first substantive write:

```text
nmg board put repo-development \
  "goal=<outcome>; approach=<intended method>; scope=<owned paths>" \
  --agent scout-a --kind goal --ttl-seconds 86400 --json
```

The entry answers only what is being attempted, how, and where. Do not post
per-step progress, completed-item lists, tool traces, or repeated entries for
the same coherent task. Writer attribution identifies the initial worker; it
does not need to claim its own new entry. A replacement Agent claims the still
open entry, inspects Git and verification evidence for actual progress, then
continues. Resolve the entry when the task finishes or is abandoned.

## Read and close

Use additional entries only for coordination that genuinely needs a separate
goal, blocker, question, result, handoff, or decision. Publish concise state.
Read incrementally and retain the returned task-local cursor:

```text
nmg board read TASK_ID --agent scout-b --after-cursor 12 --json
```

Resolve completed or obsolete entries explicitly:

```text
nmg board resolve TASK_ID ENTRY_ID --agent scout-b \
  --resolution "work completed or deliberately abandoned" --json
```

## Memory boundary

The board is a task-scoped coordination store. It is not semantic search, STG,
LTG, or a shared AG. Each Agent reads relevant entries into its own private AG.
Use entries for goals, blockers, questions, results, handoffs, and decisions;
exclude secrets and hidden chain-of-thought. Entries expire; promote a durable
conclusion only through a separate, evidence-backed `nmg remember` call.
