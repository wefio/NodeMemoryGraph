# SkillOpt policy optimization boundary

NMG integrates Microsoft SkillOpt as an **offline Lab policy optimizer**. It is
not a memory editor and it is not part of ordinary Pi inference.

## Trainable and immutable state

The implemented adapter trains a **controller-only decision policy**. It is
initialized from `src/prompts/nmg-prompts.yaml:memory_policy`, but its evaluator
asks for a strict machine-readable `recall_action`/`fold_noise` decision. That
artifact is not interchangeable with the global natural-language policy seen by
the answering Agent. The first matched promotion run demonstrated this boundary
by catching controller JSON leaking into user answers.

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

The candidate is adopted only after its controller contract has a dedicated
runtime boundary and the matched gate passes. A reviewed YAML edit remains the
only production adoption path; NMG does not load `best_skill.md` in production,
so there is no second mutable prompt source. Until the dedicated controller
boundary exists, the candidate-policy hook is a deliberately adversarial Lab
promotion test, not a deployment mechanism.

## Data readiness

Formal readiness accepts only feedback emitted by ordinary Pi use with
`collectionOrigin=natural`. The bounded headless `pi-control` helper always
marks its runs `controlled`; legacy events without an origin are `unknown` and
are excluded. Controlled and legacy rows may exercise parsing and adapter
plumbing, but cannot satisfy training or promotion thresholds.

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

Each exported row currently requires a retrieval plus natural feedback with a
stable `semanticTaskId` and all four retrieval labels (`evidenceSufficient`,
`expansionUseful`, `excessiveNoise`, and `noMemoryNeeded`). `use` and `outcome`
events enrich a row but are not mandatory in the current recall-policy exporter.
A future maintenance-policy dataset may additionally require long-horizon
outcomes; that is a separate, not-yet-implemented readiness contract.

The extension and exporter previously used different default shadow paths. This
was fixed on 2026-08-11 by a shared resolver: ordinary use defaults to `~/.nmg`,
while controlled helpers explicitly select project-local `.nmg`. Historical
counts from either file are snapshots and must be re-exported before making a
readiness claim. The 2026-08-20 formal export is ready with 24 independent tasks:
12 train, 6 chronological validation, and 6 untouched test, with both required
action classes and both noise-label values.

## First official optimization and promotion result

The first official SkillOpt run used DeepSeek V4 Flash through an
OpenAI-compatible endpoint, seed 42, three epochs, batch size 8, four rollout and
analyst workers, and a 4096-token target completion budget. On the fixed split:

- validation hard accuracy improved from 1/6 to 4/6 at step 9;
- untouched test hard accuracy improved from 1/6 to 2/6 (soft accuracy 3/6);
- the run made 258 model calls and used 1,254,494 tokens (775,127 prompt and
  479,367 completion tokens).

The offline gain did not pass the matched Agent gate. With the same Pi model and
six integration cases, the canonical policy passed 6/6 while candidate SHA-256
`8133cc870189c451dac4548fe68d49388d7fb4353b17b1ad89cfbeb16f5618b1`
passed 4/6. The candidate replaced two user answers with controller JSON and
prefixed other answers with the same internal protocol. It was rejected and the
canonical YAML was left unchanged. This result validates the two-stage gate and
invalidates the assumption that a controller-optimized text can be installed
verbatim as the Agent's global memory policy.

## Proposed maintenance-policy extension

**Status: designed, not implemented.** A future `memory_maintenance_policy` may
use the same offline optimization and two-stage promotion protocol to propose
content rewrites, scope corrections, supersession, splits, or merges. It must
separate content, scope, and retrieval defects; retrieval defects must not mutate
memory. Existing explicit feedback, collection provenance, and journaled node
merge rollback are reusable infrastructure, not evidence that this maintenance
decision layer already exists. The normative boundary is recorded in
`design.md` under “Offline text-space policy optimization”.

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
NMG SQLite database. On Windows, set `PYTHONUTF8=1` for the official Python
process so UTF-8 JSON is not decoded through the legacy system code page. Load
the chosen provider credentials into the process environment; do not store them
in SkillOpt output or committed configuration.

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
