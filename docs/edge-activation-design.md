# Edge Activation Design

**Status:** design proposal
**Updated:** 2026-07-31

## 1. Principle

**Edge activation is a function of node activation, not an independent
variable.** The complete state of the graph at one moment is the node
activation vector `a(t)`; edges contribute only their fixed learned strengths
`w` and typed routing rules. Everything else — edge activation, retrieved
context, budgets — is derived.

```
a(t)        node activation (state)
w           edge strength (slow parameter, learned)
A_e(u,v)    edge activation = f(a_u, a_v, w_uv, type)   (derived, stateless)
```

Consequences:

- No per-edge activation state to store; the runtime computes `A_e` on demand.
- Edge strength is the only learned quantity per edge. It changes slowly
  (consolidation), never within one query.
- Type-specific routing rules (direction, gating, inhibition) are part of the
  function family, not special cases.

## 2. The function family

### 2.1 Conductive edges (activation flows)

```
A_e(u,v) = σ( w_uv · φ(a_u, a_v) )
```

with per-type `φ`:

| Type | φ | Semantics |
| --- | --- | --- |
| `related_to`, `supports`, `applies_to` | `a_u · a_v` (normalized) | weak link; both ends must be alive |
| `causes`, `depends_on`, `is_a`, `part_of` | `w · a_u` (directed, from trigger) | bell → salivation; direction is learned, see §3.2 |
| `derived_from` | `w · a_v` (from source) | provenance, always available if source is active |
| `contradicts` | `w · |a_u − a_v|` | contradiction is visible when activation differs |
| `supersedes` | gate: `w · a_new · (1 − a_old)` | mutual exclusion, not summation |
| `exception_to` | `w · a_u · (1 − a_base)` | exception is relevant when base is not active |
| `constraint` | constant (resident) | independent of query, exempt from fan-out dilution |

Note: `σ` may be identity or sigmoid depending on whether the edge competes in
a softmax pool (see §2.3).

### 2.2 Fan-out dilution (verified: ACT-R `S − ln(fan)`, GAT softmax)

A node's activation is a **fixed budget** shared by its outgoing edges. The
more associations a node has, the less each single edge receives:

```
w_uv(effective) = w_uv / (1 + ln(fan_u))        ACT-R style
```

or, when the neighbor set competes,

```
A_e(u,v) = softmax_v( s(u,v) ) · budget_u      GAT style
```

This makes edge activation a **competitive allocation**, not an independent
per-edge value. It also gives a natural cost model: high-fan nodes spread
their signal thin, which is the quantitative reason a merge (reducing fan
into one node) can genuinely improve retrieval for flat indexes.

### 2.3 Regulation edges use the IAC dual-channel form

The Interactive Activation model (McClelland & Rumelhart 1981) keeps
excitation and inhibition in separate channels with bounded activation
dynamics. Adopt the same shape:

```
Δa_i = (max − a_i)·e_i − (a_i − min)·i_i − decay·(a_i − rest)
```

with `e_i = Σ_conductive A_e(·,i)` and `i_i = Σ_regulatory A_e(·,i)`.
`[min, max]` bounds and `decay` are mandatory: pure diffusion without bounds
converges to a fixed state where retrieval is query-independent (verified:
KG-RAG arXiv:2512.15922, IAC PDP Handbook ch3).

## 3. Learning rules

### 3.1 Edge strength: prediction error (RW/TD)

Edge strength updates use the Rescorla–Wagner form, not raw co-occurrence:

```
Δw_e = α · (λ − V_total) · a_u · a_v      (RW)
```

where `V_total = Σ active edges predicting the same outcome`. Consequences:

- **Blocking**: once the bell fully predicts salivation (`V_total ≈ λ`), a
  new redundant cue learns nothing — "redundant associations stop learning".
- **Saturation**: strength converges to the asymptote, never grows unbounded
  (no separate Oja-style normalization needed for edges).
- **Surprise**: only unexpected co-activation writes an edge.

### 3.1a Strength vs stability: the three-strength model

`NodeRelation.stability` already exists (updated per use). The new `strength`
is not a duplicate — it is a different axis, following the spaced-repetition
three-strength model (FSRS; stability / retrievability / difficulty):

| Axis | Meaning | NMG field | Update signal |
| --- | --- | --- | --- |
| **strength (retrievability)** | how easily the edge is retrieved/activated now | new `strength` (RW `V`, point estimate) | every activation, prediction-error update |
| **stability** | how persistently the edge survives | existing `stability` (Beta posterior, design.md §7.3) | consolidation passes, outcome attribution |
| **difficulty** | intrinsic complexity of the association | (no NMG field today) | — |

So: strength changes fast (per-query activation), stability changes slowly
(consolidation), and the two feed different decisions — strength controls
*when an edge fires* in the AG, stability controls *whether the edge
persists* in the LTG. A strongly-activated but low-stability edge is a
candidate for review, not for consolidation.

### 3.2 Direction: conditional probability, not symmetric weight

The RW/Hebb families learn undirected scalars. Directionality comes from
time order and conditional statistics:

```
direction(u→v)  from temporal order  (u activates before v)
strength(u→v)   = P(v active | u active) − P(v active)     (conditional lift)
```

`causes`/`depends_on` edges require this lift; `related_to` uses the
symmetric joint. NMG already records time (`eventTime`, `createdAt`) and
usage, so the statistics are available from the retrieval trace.

### 3.3 Contrastive maintenance (Boltzmann form)

The canonical "unlearning" signal (Ackley/Hinton/Sejnowski 1985, Hopfield
unlearning 1983):

```
Δw_e = η · ( ⟨s_u s_v⟩_data − ⟨s_u s_v⟩_model )
```

Edges that the model co-activates but the data never shows get weakened.
This is the maintenance pass that removes phantom associations (e.g. a
contradiction edge that no query ever actually surfaces).

## 4. Where this lands in the code

### 4.1 NodeRelation gains runtime-derived fields

Existing `NodeRelation` (src/core/types.ts:82) already has `stability`,
`status`, `consolidationSource`. Add:

```
strength: number          // learned w_uv, persisted (slow axis)
direction: "both" | "source->target" | "target->source"   // from §3.2
fanBudget: boolean        // participates in fan-out dilution
activationRule: "conductive" | "regulatory"               // §2.1 vs §2.3
```

Do **not** add `activation` to the schema — it is derived per query and must
not persist.

### 4.2 HierarchicalActivation gains an edge layer

`HierarchicalActivation` (src/core/hierarchical-activation.ts) currently
computes node scores from attention over vectors. Add an edge-aware term:

```
simEdge = Σ_{e in edges} A_e(u,v) · sim(v, q)      // one extra fused score
```

The 7-dim `scoreWeights` tensor becomes 8 (add `w_edge`); the existing NLL
training already provides the used-node signal that can supervise edge
strength (`usedNodeIds`).

### 4.3 Retrieval pipeline (search.ts / router.ts)

- Compute node activations `a(q)` first.
- Derive edge activations `A_e = f(a, w, type)`.
- Run one or two steps of bounded diffusion (PPR-style: `x' = (1−α)Âx + α·h`,
  `α` from the query seed), then stop — never iterate to equilibrium.
- Apply budget (tokens/nodes/edges) after diffusion, not before, so the
  ranking reflects the propagated signal.

### 4.4 Merge is a caching optimization of this system

When `w_uv` saturates and `P(u|v) ≈ P(v|u) ≈ 1` (1:1 fixed activation), the
edge is behaviourally a single unit. Merging them is then:
- **alias resolution** (identity) or
- **compression** (one node's records serve both addresses, redirect retained)

Merge decisions come from the same statistics the edge learner uses:
`I(U;V)` high and conditional lift ≈ 1 → candidate for alias/merge. This is
the quantitative version of "merge = compressed 1:1 fixed activation".
Rollback is the reverse: evidence that the pair diverges (lift drops,
per-node query behaviour splits) reopens the edge.

#### Two merge motivations must stay separate

Alias merge and compression merge are different operations with different
triggers, costs, and rollback difficulty:

| | Alias merge | Compression merge |
| --- | --- | --- |
| Trigger | identity evidence (Fellegi–Sunter, design.md §7.5) | co-activation statistics (`I(U;V)` high, lift ≈ 1) |
| Meaning | the two names name the same thing | the two nodes behave as one unit |
| Confidence bar | high (false merge is destructive) | higher still — statistics can be spurious |
| Rollback | redirect preserved | redirect + divergence signal reopens edge |

Compression merge is the weaker decision and must be more conservative:
it is an optimization of the retrieval index, never a claim about identity.
**Formal Concept Analysis (FCA, Wille 1982) supplies the *where* of merge,
not the *when*:** the concept lattice organizes objects by shared attributes
into a hierarchy — once a merge is accepted, FCA-style shared-attribute
structure decides the merged node's position in the concept lattice, while
the *trigger* remains the two signals above (candidate status; the lattice
itself is not yet part of the NMG data model).

## 5. Budgets and invariants

| Invariant | Enforced by |
| --- | --- |
| Edge activation derived, never stored | runtime computes from `a` + `w` |
| Edge strength persists; updates only via RW/TD/contrastive passes | write path gates |
| Fan dilution always applied | §2.2 in edge layer |
| Diffusion bounded: max hops, threshold, decay | §2.3 / §4.3 stop rule |
| Contradiction/supersedes edges never summed with conductive | §2.3 dual channel |
| Merge only from statistics, reversible via redirect | §4.4 |
| Confidence/evidence unchanged by activation | activation never writes evidence |

## 6. Open questions

1. Should `w_uv` be per-direction (two scalars) or one scalar + direction
   flag? ACT-R uses one `S_ji`; conditional lift suggests two.
2. Does the edge layer belong in `HierarchicalActivation` (a Lab-facing
   autodiff component) or in the core retrieval path first? Proposal: Lab
   prototype first, matching the repo's Lite/Lab split (docs/design.md §1).
3. Fan-out dilution budget: `S − ln(fan)` is static; should it be learned
   (per-node `S_v`)? Initial design: static, measure, then learn if evidence
   shows a gain (the repo's "simplest measured implementation wins"
   principle).
4. Where does the contrastive unlearning pass run? Proposal: batch
   maintenance alongside the existing retention lifecycle (CLI/admin), not
   per-query.

## 7. Relationship to existing design

- Consistent with design.md §7.2 (activation is query-local, not truth).
- Sharpens §7.3.1: the three axes (confidence, usefulness, activation) map
  exactly onto: evidence posterior (unchanged), `w_uv` (RW/TD updates), and
  derived `A_e` (this document).
- Replaces §7.3's `S_e` update sketch with the verified RW/TD form.
- Makes §7.4/§7.5 merge decisions quantitative: merge candidates from
  `I(U;V)` + conditional lift instead of similarity-only blocking.
