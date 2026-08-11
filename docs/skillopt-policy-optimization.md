# SkillOpt policy optimization boundary

NMG integrates Microsoft SkillOpt as an **offline Lab policy optimizer**. It is
not a memory editor and it is not part of ordinary Pi inference.

## Trainable and immutable state

The only trainable artifact is the stable natural-language policy that tells an
Agent how to use progressive recall. The initial artifact is copied from
`src/prompts/nmg-prompts.yaml:memory_policy`.

SkillOpt may propose bounded edits concerning:

- whether to answer, expand recall, or stop;
- whether retrieved noise should be folded;
- when exact evidence is required;
- when no useful memory is a valid result;
- how historical memory differs from a live code/file/web source.

It must never edit or learn as prompt text:

- raw history or source evidence;
- user facts, preferences, constraints, or current state;
- STG, LTG, or Active Graph contents;
- node identity, edge identity, or saved memory statements.

Those objects are runtime data and remain attributable to their sources. A
benchmark answer or validation label must not become a durable user memory.

## Two-stage gate

The offline adapter deliberately evaluates a small, stable decision surface:

```text
observable retrieval state + candidate policy
    -> recall_action: answer | expand | stop
    -> fold_noise: true | false
```

Only explicit feedback labels are exported. Silence, normal completion, absence
of correction, candidate exposure, and benchmark gold answers are not converted
to natural-use labels. Whole semantic tasks are split chronologically into
train, validation, and untouched test sets so retries cannot cross a split.

Passing SkillOpt's held-out gate produces a **candidate**, not a production
policy. Promotion additionally requires a matched Pi + NMG run that holds the
model, histories, questions, retrieval configuration, and scorer fixed while
changing only the policy. It must report:

- answer quality and task success;
- exact evidence recall and conflict evidence recall;
- wrong/obsolete memory use and pollution;
- unnecessary search and expansion;
- injected tokens, tool calls, and end-to-end latency.

The candidate is adopted only by manually updating `nmg-prompts.yaml`. NMG does
not load `best_skill.md` in production, so there is no second mutable prompt
source.

## Data readiness

The exporter defaults to conservative engineering minima, not a statistical
power guarantee:

- 24 independent semantic tasks total;
- 12 train tasks;
- 6 held-out validation tasks;
- 6 untouched test tasks.
- at least two observed recall actions and both noise-label values.

Formal export fails closed below those counts. `--allow-insufficient` exists
only to check the adapter and file layout; its output cannot authorize training
or promotion.

The current project shadow log on 2026-08-11 contains three fully labelled
semantic tasks. The generated split has one task in each partition and is not
ready for optimization.

## Commands

The official SkillOpt checkout is kept under the ignored benchmark directory:

```powershell
git clone --depth 1 https://github.com/microsoft/SkillOpt.git `.benchmarks/official/SkillOpt`
npm run eval:skillopt:install
```

Export the current natural-use observations:

```powershell
# Formal path: exits with code 2 while the readiness gate is not met.
npm run eval:skillopt:export

# Engineering smoke only.
npm run eval:skillopt:export -- --allow-insufficient
```

The export writes `train/val/test/items.json`, `initial_skill.md`, and a
manifest with source/policy hashes and immutable boundaries under
`.benchmarks/skillopt/nmg-policy`.

After the dataset is ready, install SkillOpt's Python environment according to
its upstream documentation and run its patched `configs/nmg_policy.yaml`. The
adapter uses SkillOpt's configured target/optimizer backends and never opens the
NMG SQLite database.

An accepted offline candidate can be exercised against NMG's existing Pi cases
without changing the canonical YAML:

```powershell
$env:NMG_SKILLOPT_POLICY_PATH = "C:\path\to\best_skill.md"
npm run eval:agents
Remove-Item Env:NMG_SKILLOPT_POLICY_PATH
```

The runner encodes the candidate into an explicitly marked Lab-only child
environment and records only its SHA-256 in the report. The Pi extension rejects
missing, tiny, oversized, or runtime-tag-injecting candidate policies. Ordinary
Pi processes ignore the candidate mechanism.

## What this experiment can and cannot prove

It can test whether a better written stable policy improves decisions made from
the same observable retrieval state. It cannot optimize embeddings, graph
topology, node merging, evidence ranking, or database behavior. Those remain
separate NMG mechanisms and require their own matched ablations.
