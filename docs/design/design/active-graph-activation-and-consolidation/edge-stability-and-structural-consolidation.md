# Edge stability and structural consolidation

[中文](edge-stability-and-structural-consolidation.zh-CN.md) · [Terms used](edge-stability-and-structural-consolidation.terms.yaml)

**Authority:** [Parent scope](../active-graph-activation-and-consolidation.md).

### Edge stability and structural consolidation

Edge stability changes more slowly than activation and estimates whether a
relation has repeatedly helped across independent contexts:

```text
S_e(t+1) = decay * S_e(t)
         + alpha * cross_task_usefulness
         + beta  * independent_recurrence
         + gamma * user_or_tool_verification
         - delta * contradiction_or_failure
```

Repeated retrieval alone must not increase stability. Otherwise an accidental
retrieval edge creates a feedback loop: it causes co-retrieval, which strengthens
the same edge, which causes more co-retrieval. Useful observations should be
deduplicated by session/task/source lineage and discounted when they are caused
only by the candidate edge being evaluated.

Temporary and inferred edges follow an explicit lifecycle:

```text
ephemeral -> observed -> candidate -> consolidated
                         |             |
                         `-> rejected  `-> LTG typed relation
```

A local subgraph is eligible for LTG materialization only when it satisfies
minimum independent evidence, usefulness, scope consistency, provenance
coverage, conflict, and stability thresholds:

```text
consolidate(G') iff
  stability(G')       >= high_threshold
  independent_tasks   >= min_tasks
  evidence_coverage   >= min_coverage
  observed_utility    >= min_utility
  unresolved_conflict <= max_conflict
```

Consolidation uses hysteresis: demotion or reopening requires a lower threshold
than promotion, preventing repeated promote/demote oscillation. The operation is
versioned and auditable, preserves evidence, and must be reversible by rebuilding
the semantic projection from history. Stable co-activation supports a relation;
it does not by itself prove a factual claim.

Atomic-memory promotion and structural consolidation remain separate. A clear
fact, preference, constraint, state, or explicit remember request may enter LTG
immediately. New relations, derived concepts, aggregated strategies, and node
merges/splits require the stronger stability process above.

Because Pi session STG and shared LTG are physically separate SQLite stores,
changing a row's `residence` flag is not cross-store consolidation. The runtime
therefore treats consolidation as an explicit materialization step:

```text
independently attributable claim outcomes
  -> per-claim posterior eligibility
  -> STG consolidation candidate (shadow by default)
  -> exact evidence + semantic record copied into LTG
  -> LTG remember/dedup transaction
```

Retrieval frequency, repeated rendering, and silence never qualify a memory.
For this posterior-based consolidation path, each atomic claim must pass
minimum independent-vote, posterior-mean, and conservative-lower-bound gates. The copied LTG record carries a
`consolidated_from_stg` marker pointing to its source memory; LTG's exact
same-scope deduplication makes retry after interruption idempotent. Automatic
actuation is deliberately disabled by default and requires
`NMG_STG_AUTO_CONSOLIDATE=1`; candidate reporting remains available in shadow
so natural-use precision and reversibility can be measured first.

Claim outcomes enter through an explicit, attributable boundary rather than
ordinary retrieval feedback. Pi exposes `nmg_remember action=claim_outcome`,
and the agent-neutral CLI exposes `nmg claim outcome`; both require a semantic
task ID, `supported|contradicted`, source class, and stable source lineage. An
optional session-owned Active Graph restricts votes to records actually exposed
by that retrieval. Retrieval, exact `get`, answer reuse, silence, and generic
task success never create positive claim votes. This wiring makes posterior
collection possible in ordinary use without weakening the promotion gate.
When Pi admits a user/tool outcome, it validates an exact current-session excerpt
and stores that excerpt as a deduplicated `HistoryRecord`; the outcome event keeps
its `evidenceId`. Removing or compacting the Pi transcript therefore does not
leave a posterior vote backed only by a dangling message ID. Task and benchmark
votes may retain lineage without copying arbitrary generated text.

Physical separation also means a new STG state cannot transactionally mark an
older consolidated LTG state superseded. The runtime STG/LTG projection
therefore reconciles active records with the same canonical `stateKey + scope`
and exposes only the newest event/valid/creation-time version; LTG wins an exact
tie. Time filters are applied before reconciliation, preserving the older state
for historical queries. This deterministic current-state invariant is separate
from posterior consolidation retraction: a single authoritative update must not
wait for several contradictory outcome votes before stale state disappears.

The atomic lifecycle also has an explicit reverse path. Promotion uses the
strict vote/mean/conservative-bound gate; an already materialized copy remains
active while it satisfies lower retained-mean and retained-lower-bound
thresholds. Once it falls below that hysteresis gate, NMG logically withdraws
only the active LTG row whose `consolidated_from_stg.sourceMemoryId` matches the
STG source. Manual or pre-existing LTG duplicates carry no such ownership marker
and cannot be retracted by STG feedback. Requalification creates a new LTG
version rather than reviving the withdrawn interpretation. The current cold
start thresholds and the LoCoMo official-evidence coverage/reversal audit are
recorded in `consolidation-evaluation-2026-08-09.md`; automatic actuation remains
off because that dataset has no authoritative false-promotion labels.

Identity maintenance uses an even stricter boundary. Repeated `same_as`
judgments accumulate observations and provenance on one pending proposal. A
read-only automation assessment requires a pending identity proposal, at least
five observations, mean confidence of at least 0.98, at least four active
evidence memories in total with at least one represented on each node, identical
evidence scope, and no
pending `distinct_from` or `contradicts` proposal. Identity evidence must come
from user or tool sources, and the two nodes must share at least one source-actor
class; Assistant/system-authored identity guesses and disjoint provenance classes
cannot drive an automatic merge. The scope must expose exactly
one non-empty identity value, and its normalized canonical name must not already
belong to an active node. Passing this assessment is only eligibility by default:
automatic actuation is fail-closed unless `NMG_TOPOLOGY_AUTO_MERGE=1` is set.
When explicitly enabled, semantic maintenance actuates at most one eligible
`same_as` proposal per pass by default (configurable with
`NMG_TOPOLOGY_AUTO_MERGE_LIMIT`, hard-capped at four), records the transform ID
and any actuation error on the proposal, and uses the existing reversible merge
journal. Uncertain split and merge proposals remain pending for explicit review.

The first natural-conversation gate audit is recorded in
`topology-gate-evaluation-2026-08-09.md`. On LoCoMo speaker identities, 20/20
injected same-person early/late candidates passed, 10/10 injected cross-person
candidates were rejected by scope, all 20 eligible candidates lost eligibility
after a competing `distinct_from` proposal, and assessment caused zero topology
mutations. This validates the gate and its reversible proposal state, not
automatic candidate generation, alias resolution, or end-to-end false-merge
cost. The opt-in actuator and physical rollback now have deterministic coverage;
natural false-merge and reversal evidence remain prerequisites for enabling it
by default.

The matched product probe in `matched-evaluation-2026-08-09.md` also found no
answer-quality advantage for graph adaptation over NMG Lite (both 5/7) while
Graph performed additional retrieval work. This small result is a product gate,
not a universal benchmark claim: graph adaptation remains Lab-only and
unattended topology mutation stays disabled unless a larger matched evaluation
shows a reproducible benefit.

#### Edge strength is not one scalar

NMG must not use one “thickness” value for truth, habitual access, and current
attention. Existing theories support three orthogonal quantities:

1. **Confidence** is an evidence-backed belief that the typed relation is valid
   in its time and scope. Supporting and contradicting independent source
   lineages update a Beta posterior `(confidence_alpha, confidence_beta)`.
   Factual edges use a conservative posterior lower bound as a gate.
2. **Usefulness/stability** estimates whether traversing the edge has repeatedly
   helped across independent semantic tasks. A separate Beta posterior records
   useful versus expanded-but-unused outcomes; an ACT-R-style recency/frequency
   base level may summarize repeated successful observations.
3. **Activation** is private to one AG and decays rapidly:

   ```text
   activation_e(t) =
     previous * exp(-lambda * delta_t)
     + eta * activation_source * activation_target
     + zeta * successful_current_path
   ```

   Outgoing activation is normalized and budget-clipped, following the
   stabilization lesson of Oja/BCM rather than unbounded Hebbian growth.

Co-activation or co-retrieval may create only a candidate associative
`related_to` edge. It cannot establish `causes`, `depends_on`, `constraint`,
supersession, or another strong directed relation without explicit evidence.
Every persistent confidence update must retain W3C PROV-style source/activity
provenance and deduplicate copied or repeatedly quoted evidence by source
lineage.

The runtime may combine these values without overwriting them:

```text
route_score =
  type_match
  * query_relevance
  * usefulness_lower_bound
  * factual_confidence_gate
  * (1 + mu * private_AG_activation)
```

Rare pinned or safety-critical constraints are exempt from access-frequency
demotion. In a UI, route score may temporarily control rendered line width, but
the storage model preserves confidence, usefulness/stability, and activation as
separate axes.

The model draws on
[ACT-R base-level and spreading activation](https://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/39jra_cds_2000_a.pdf),
[Collins–Loftus spreading activation](https://doi.org/10.1037/0033-295X.82.6.407),
[Oja-style normalized Hebbian learning](https://users.ics.aalto.fi/oja/papers.html),
[temporal tie decay](https://arxiv.org/abs/1906.09394),
[uncertain knowledge-graph confidence](https://doi.org/10.1609/aaai.v33i01.33013363),
and [W3C PROV-O](https://www.w3.org/TR/prov-o/). These are design sources, not
evidence that the proposed combination already improves NMG retrieval.
