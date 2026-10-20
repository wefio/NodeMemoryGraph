# Offline text-space policy optimization

**Authority:** [Parent scope](../evaluation-and-falsifiable-claims.md).

## Offline text-space policy optimization

Training provenance is part of the gate, not a prose convention. Normal Pi
feedback is recorded as `collectionOrigin=natural`; the reproducible headless
probe is fixed to `controlled`, and pre-field legacy events remain `unknown`.
Only fully labelled natural outcomes may enter controller calibration or the
formal SkillOpt split. Controlled outcomes remain valid engineering smoke data.

NMG Lab may use SkillOpt to optimize a controller-only recall decision policy,
but never mutable memory contents. The current adapter seeds that artifact from
the `memory_policy` field in `nmg-prompts.yaml`, then evaluates a strict
machine-readable decision contract. That controller artifact is not the same as
the global natural-language policy used by the answering Agent. History,
evidence, facts, STG/LTG/AG state, node identity, and edge identity remain
immutable evaluation inputs.

The first adapter learns only the next progressive-recall decision (`answer`,
`expand`, or `stop`) and whether noise should be folded from explicit shadow
labels. It uses chronological whole-task train/validation/test splits. A
SkillOpt validation win creates a candidate only: matched Pi+NMG answer,
evidence, pollution, token, tool-call, and latency gates must also pass, after
which adoption also requires a dedicated controller invocation/policy boundary
that cannot leak protocol into the user answer. Adoption remains a reviewed edit
back into the YAML source of truth. Runtime NMG never loads `best_skill.md`
automatically. The first official run improved offline validation and test
scores, but the matched Pi gate regressed from canonical 6/6 to candidate 4/6
because `recall_action` JSON appeared in user answers; the candidate was rejected
and canonical YAML was unchanged. See the [SkillOpt policy optimization boundary](../../skillopt-policy-optimization.md) for the protocol and current readiness.

A second, separate candidate artifact is
`memory_maintenance_policy`. It translates already observed controller and
feedback signals into reviewed maintenance proposals, not mutate memory during
inference. Its attribution must distinguish:

- **content defect**: a statement is wrong, obsolete, or ambiguous;
- **scope defect**: a valid statement is attached too broadly or narrowly;
- **retrieval defect**: content is valid but selection or timing was wrong.

Only the first two categories may propose content/scope maintenance. Retrieval
defects remain selection-policy evidence. Candidate maintenance policies require
their own long-horizon outcome definition, held-out gate, and matched Pi+NMG
promotion test. Every proposal binds a reviewed policy ID, revision and source
hash to its minimum accepted long-horizon score and held-out or matched-replay
evaluation reference. Any accepted policy remains a reviewed YAML edit; individual
rewrite, supersede, split, or merge proposals must retain evidence and use the
existing journal where supported.

Proposal review is deliberately separate from actuation. Accepting a maintenance
proposal records a human/Agent decision but never edits memory. The reviewer must
then invoke the existing explicit rewrite/supersede/split/merge operation, retaining
that operation's own validation and rollback boundary. This prevents an offline
policy from acquiring an implicit write capability.

**Implementation status:** explicit feedback collection, natural/controlled
provenance, journaled node-merge rollback, the recall-policy SkillOpt adapter,
formal data gate, first official optimization, and matched rejection gate are
implemented. The dedicated controller runtime policy channel is implemented and
defaults to shadow-only operation; controlled evaluation requires controlled
provenance, while production actuation requires a hash-bound three-gate approval
receipt and rollback artifact. Promotion of any candidate into active/default
operation still requires real matched evidence. The maintenance-policy identity,
three-way attribution, long-horizon gate, durable proposal store and explicit review
channel are implemented through Core, daemon RPC and CLI. Automatic proposal
generation, SkillOpt optimization and actuation remain disabled until natural labels
pass their promotion gates. STG/LTG context composition is implemented, but it is
not a reversible persistent STG merge.

The current Pi regression, seven-category invariant suite, controlled topology
ablation, and strict seven-question LongMemEval matched sample prove integration
and mechanism behaviour. The full matched BEAM 100K run additionally demonstrates
a substantial gain over empty retrieved context for one fixed dataset/model/judge
configuration. It does not yet prove cross-suite, cross-model, or repeated-run
general capability improvement. The LongMemEval sample did ingest every haystack
session for each selected question, but its zero-configuration FTS/hashing path
missed five of seven required evidence sets. Cross-suite matched external-
embedding runs and repeated model runs remain required for a broader claim.

The public evaluation portfolio is deliberately complementary rather than a
single composite leaderboard:

- LongMemEval remains the main development gate for extraction, multi-session
  reasoning, updates, temporal reasoning, and abstention;
- PersonaMem evaluates automatic fact/preference/constraint writes, evolving
  user profiles, scope, and current-state selection;
- LoCoMo evaluates temporal/causal relations, multi-hop evidence, and expansion
  from semantic nodes to leaf evidence;
- BEAM is the late-stage scale and cache-pressure test, beginning at 128K and
  500K before any 1M or 10M run.
- OmniMemEval is the preferred external user-memory evaluation harness because
  it unifies those suites (plus HaluMem) behind one `add`/`search` client
  contract. NMG maintains one thin OmniMemEval adapter. OmniMemEval measures the
  backend under forced search; the local matched Pi runner remains necessary to
  measure recall triggering and actual evidence use. Only duplicated
  public-dataset parsing, replay, and scoring should be retired after parity.
- OmniMemEval's AgentBench/OpenClaw agent-memory track is not adopted for Pi at
  this stage. Pi runtime behaviour remains covered by local extension and RPC
  tests, avoiding a second agent harness unless comparative evidence justifies
  it.

These suites must be reported separately. Matched arms share the same reader,
prompt, question IDs, source history, evidence-token budget, and judge. Answer
quality is reported together with evidence recall, injected tokens, backend
records read, graph/tier depth, end-to-end latency, and index/maintenance work.
The complete adapter contract and rollout order live in `evals/README.md`.

The 2026-08-11 strict LongMemEval matched regression used one fixed question
from each of seven categories. The separate protocol scorer gave no memory
`2/7`, deterministic NMG `4/7`, and NMG with non-ranking shadow telemetry
`4/7`; the generic diagnostic scorer gave `1/7`, `4/7`, and `4/7`. Both NMG
arms passed the same four categories and failed the same three, so the telemetry
path showed no answer-quality regression in this bounded gate. Exact official
evidence `recallAll` was `3/7` versus `2/7`, however, because the stochastic
Agent chose different search/get sequences despite identical ranking policy.
Consequently a one-repeat answer tie is a regression check, not proof of
retrieval or cost equivalence. Full parameters, latency, context, and token
accounting are recorded in `evals/longmemeval/README.md`.

This 2026-08-11 report's seven-question results differ from the separate strict
three-arm snapshot in [the evaluation overview](../evaluation-and-falsifiable-claims.md)
(1/7, 2/7, 3/7). The available records do not establish whether the samples,
model/judge runs, or scoring procedures differ; keep these as separate
historical reports and do not attribute the score differences to shadow telemetry.

The complete Namesakes topology audit also includes a read-only streaming
counterfactual. At hashing threshold 0.5, 94.74% of incoming non-anchor mentions
would emit a proposal and false proposals would co-locate 6,450 foreign records
across 2,307 of 3,975 entities. Threshold 0.7 still affects 1,479 entities and
3,003 foreign records while positive recall falls to 30.39%. This quantifies
online proposal prevalence and structural contamination, but not correction
events or downstream answer damage; automatic identity mutation remains off.

The first pinned OmniMemEval LongMemEval search-only smoke used the same seven
fixed questions as the Pi run. Forced NMG search initially made five cases
plausibly answerable. The failure trace showed two simple ranking faults:
unverified assistant replies competed with user facts, and English
question/function words inflated irrelevant lexical scores. An optional
source-actor filter plus stop-word-aware lexical terms recovered both temporal
records, preserved the update, preference, and assistant evidence, and changed
the count result from duplicate boot mentions to complementary boot and blazer
evidence. The count case remains 2/3 against the official evidence list.
Search stayed around 126–166 ms; ordinary contexts were 2.8–4.1k characters,
with one long assistant schedule at 7.5k.

Enabling hybrid FTS on the two deficient cases recovered no additional
required evidence, expanded context to 7.2–7.9k characters, and raised one
temporal search to 2.04 s, so that change was rejected. This supports targeted
source/provenance filtering and aggregation rather than broader candidate
expansion.

The first pinned OmniMemEval LoCoMo smoke exposed an upstream integration
detail: LoCoMo maintains a benchmark-local search dispatch table instead of
using the shared dispatcher. The idempotent adapter installer now patches both.
After that fix, the official ingestion and search stages completed all 272
sessions and 1,540 category 1--4 questions without failure. Ten-worker search
took 54 seconds; individual backend latency was 329 ms mean and 619 ms P95,
with 4.15k returned characters on average. Exact normalized evidence text was
present for at least one official evidence ID in 61.8% of questions and for all
IDs in 49.6%. These are search diagnostics, not answer-quality claims; the
official answer/scorer stages and a matched no-NMG baseline remain required.
The 1,540 question count reported for ingestion is not reconciled with the
1,532 scored-question denominator in the [retrieval-quality baseline](../../../experiments/retrieval-quality/baseline-2026-08-16.md); the two counts should not be treated as interchangeable.

A fresh-namespace LoCoMo budget ablation found 32.7%, 39.0%, 45.0%, and 46.6%
exact labelled-evidence recall at K=5, 10, 20, and 40 respectively. Mean context
grew from 1.0k to 2.1k, 4.2k, and 4.9k characters. K=20 is therefore retained
as the default knee point: K=40 adds only 1.6 recall points, while multi-hop and
open-domain recall remain low even at the larger budget. This rejects broader
default context expansion and points subsequent work toward evidence
composition and query-aware ranking.

The same smoke exposed a representation loss at the adapter boundary: NMG
stored each LoCoMo turn's event time, but the text returned to the reader
discarded it. Temporal evidence containing relative expressions was therefore
not sufficient to derive dated answers. The Omni bridge now includes event time
only for temporally signalled queries. In a fresh K=20 run, every one of the 450
retrieved labelled evidence turns in that subset had a date anchor; evidence
ranking was unchanged. The added cost was 691 characters for the 663 affected
questions and zero for the other 877. This is retained as lossless
query-dependent rendering, not a larger retrieval budget.
