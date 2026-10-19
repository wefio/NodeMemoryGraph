# Progressive retrieval

[简体中文](progressive-retrieval.zh-CN.md) · [Terms used](progressive-retrieval.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Progressive retrieval

Progressive retrieval constructs and expands the Active Graph; it is separate
from both storage tiers and the STG/LTG lifecycle:

1. **Resident layer:** a very small query-independent seed of critical
   constraints and stable profile information placed into every relevant AG.
2. **Automatic recall layer:** bounded dynamic selection from STG and LTG based
   on the current query, task, scope, time, and available budget. A harness-side
   memory gate first chooses `retrieve`, `cue`, or `none`; `none` must not search
   or inject dynamic long-term memory. Ordinary code inspection, tests,
   calculations, formatting, and other self-contained turns therefore remain
   memory-free. Explicit Chinese temporal recall cues include both `之前` and
   `先前`; equivalent past-state questions use the same retrieval decision.
   The gate may retain bounded task anchors so a terse continuation
   can recall the immediately preceding task without treating every substantive
   prompt as a history query.
3. **Agent-directed recall layer:** compact headers/cues that let the model call
   `nmg_search`, inspect costs, and expand the AG with exact details through
   `nmg_get`.

Automatic recall and Agent-directed recall share the same indexed records.
Explicit recall triggers may improve candidate nomination in either layer, but
they do not bypass the memory gate, Active Graph budgets, QPP folding, scope or
truth filters, or the requirement to load exact evidence before relying on a
detail.

The third layer is additionally bounded as a tool process, not just as returned
information. Repeated candidate sets count as no progress, an exact `get` only
unlocks further search when it loads previously unseen evidence, and hard
per-turn search/tool ceilings terminate loops even when QPP keeps recommending
expansion. Progressive disclosure therefore governs both content volume and the
number of disclosure actions.

Candidate generation should compose independent signals:

```text
Inbox/Delta + surface anchors + fine-grained record semantics
  -> word-level FTS only as a zero-configuration/degraded fallback
  -> optional node/leaf semantic routing at measured large scale
  -> optional graph expansion
  -> scope/time/truth filtering
  -> type-aware reranking and diversity
  -> bounded Active Graph projection
  -> compact headers and selected exact evidence
```

The implementation keeps these stages inspectable rather than treating
`searchContext` as one ranking formula: AG hard-budget selection, main-candidate
ranking, active-graph projection selection, and duplicate marking are pure
functions. Storage reads and optional graph/semantic expansion remain orchestration
steps. Autodiff remains a supported controller mechanism because it is a small,
already implemented DAG-native computation layer; it is not a mandatory runtime
dependency for ordinary retrieval.

Search signals are separated by purpose:

- semantic/vector search for meaning;
- contentless trigram surface-anchor retrieval for explicit quoted phrases,
  paths, versions, IDs, error codes, code-like identifiers, and configured
  recall triggers; NFKC normalization preserves equivalent surface forms while
  punctuation remains searchable;
- structured filters for dates and scopes;
- word-level FTS5 as the zero-configuration or degraded fallback, not as a
  substitute for semantic retrieval and not as an English benchmark policy;
- regular expression only as an advanced/debug fallback over a bounded candidate
  set or raw session subset.

On the FTS5-only path, adjacent candidates with exactly equal `combinedScore`
are ordered by IDF-weighted coverage of the query's word terms in their statements
and first 500 evidence characters before the direct result cap and the Active
Graph budget select evidence. Non-tied order and scores remain unchanged; the
selected prefix and QPP observations may change because the budget sees the
resolved order. Open attachments retain their reserved positions. Semantic
retrieval and forced surface-anchor supplements do not use this rule. Its scope,
evaluation, and the rejected neural ranking arm are recorded in
[lexical tie ranking](../../decisions/implemented/2026-09-30-lexical-tie-ranking.md).

Arbitrary model-generated regex is not a relevance ranker and must not scan the
entire store by default. Surface anchors are admitted beside semantic candidates
before the shared AG budget and projection. Plain prose produces no surface
anchor solely from word overlap, preventing an English benchmark from redefining
product ranking. Arbitrary literal scans remain disallowed because the trigram
index provides the bounded precision path without regex escaping or
catastrophic-backtracking risk.

Offline learned relevance uses the source and evaluation boundaries in
[relevance-training.md](../relevance-training.md). Its artifacts remain candidates;
cross-corpus measurements do not grant runtime admission.

### Query formation and route fusion boundary

NMG accepts a primary query plus optional caller-generated `queries[]`. The
caller may produce these clauses through query decomposition, alternate
wording, domain knowledge, or a hypothetical answer (HyDE). HyDE is therefore
not an NMG subsystem: the Agent or another LLM-facing harness method generates
the hypothetical text, while NMG only searches the supplied clauses.

The retrieval boundary owns stable-ID deduplication, primary-query priority,
and the shared record/token budget. The verified Lite path currently appends
unique secondary-query results after the primary ranking. Weighted reciprocal
rank fusion is available as a deterministic Lab primitive, and reverse
retrieval remains an offline candidate-generation probe. Neither changes the
Lite default until a shared bounded implementation and matched product tests
show a benefit outside one benchmark distribution.

Benchmark-owned answer and judge prompts remain upstream protocol. They may be
used unchanged for comparability, but they do not define NMG query generation,
ranking, or product prompt policy.

### QPP actuation and progressive disclosure

QPP is an optional control plane over the same Active Graph retrieval path, not
a separate store or retrieval engine. Its three actions are independently
configurable because they have different costs and failure modes:

1. **QPP1** predicts how broad the first candidate pool should be. It can
   observe without acting or allocate a bounded initial Fibonacci tier.
2. **QPP2** operates only inside the candidate pool. It may continue
   progressive inspection and decide which headers are individually visible
   versus folded.
3. **Search recommendation** converts insufficient automatic recall into an
   advisory signal for the model. It never invokes a tool by itself.

NMG's responsibility ends at producing auditable scores and measuring each
module's quality and cost. Whether to activate a module, and which modules to
compose, is operator policy rather than a learned NMG decision. The project
does not need to optimise or endorse a combinatorial configuration.

QPP2 performs progressive disclosure rather than deletion. Let the controller
produce listwise necessity scores `s_i`; convert them to relative odds and
normalised local mass:

```text
o_i = clamp(s_i) / (1 - clamp(s_i))
p_i = o_i / sum_j(o_j)
```

The visible directory is the smallest score-ranked set whose cumulative local
mass reaches the configured retention target, currently
`NMG_QPP2_RETAINED_MASS` (default `0.98`; see
[Pi QPP controls](../../../README.md#headless-pi-control)). Retrieval Top-1
is the only fixed safety anchor. A flat distribution therefore remains wide, while a steep
distribution folds more candidates. Folded candidates remain in the Active
Graph and retrieval trace and must stay explicitly unfoldable.

The mass is a query-local relative allocation, not a calibrated absolute
probability that a record is necessary. QPP2 therefore remains opt-in until
matched tests show that the model can use the folded directory without losing
answer evidence. Concrete Pi settings, defaults, compatibility variables, and
operator instructions belong in the README rather than this architecture
contract.
