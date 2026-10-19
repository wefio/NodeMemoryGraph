# Theoretical lineage

[中文](theoretical-lineage.zh-CN.md) · [Terms used](theoretical-lineage.terms.yaml)

**Authority:** [Memory graphs](../memory-graphs.md).

## Theoretical lineage

Use these comparisons as background for STG/LTG/AG roles, not prerequisites,
implementation proof or promotion policy. Cognitive stores and NMG's semantic
stores are not identical. The references are retained design background, not a
new literature verification or a claim of complete coverage.

### Atkinson–Shiffrin multi-store model (1968)

Atkinson & Shiffrin's sensory / short-term / long-term model supplies a historical
structural analogy:

| NMG role | Comparison | Limit |
| --- | --- | --- |
| AG | Bounded attended working context | AG is a mutable session graph, not a biological buffer or one frozen projection. |
| STG | Temporary information before durable integration | NMG holds provisional meaning and may persist it in SQLite. |
| LTG | Durable semantic/episodic/procedural material | Persistence does not promise unlimited capacity. |

Approximate human-buffer figures (20 seconds, 7±2 chunks) are unverified
comparative pointers here, not NMG retention/capacity defaults. Attention and
consolidation motivate governed admission; the analogy does not establish exact
equivalence to NMG's write path.

### Complementary Learning Systems (McClelland, McNaughton & O'Reilly, 1995)

CLS (Psychological Review 102, 419–457; PMID 7624455) supplies a fast-encoding /
slow-integration analogy:

| NMG | CLS comparison | Design use |
| --- | --- | --- |
| STG | Fast hippocampal encoding | Keep provisional material separate from stable structure. |
| LTG | Slower cortical integration | Require evidence before structural consolidation. |
| STG→LTG | Systems consolidation/replay | A mechanism analogy, not automatic promotion permission. |

Interference motivates separating fast observations from slower structural
learning. Repeated co-activation may nominate a candidate, but does not prove a
relation or raise stability by itself. NMG additionally requires independent
source/task attribution and qualified outcomes. Atomic facts may use a separate
governed immediate-admission path; that is an NMG rule, not a theorem derived
from CLS. Scheduled replay remains an [open design question](../memory-graphs.md#open-questions).

### ACT-R / SOAR cognitive architectures

The earlier comparison cites Laird's 2022 account (arXiv:2201.09305): bounded
working buffers hold current retrieval, declarative memory holds facts and
experiences, and procedural memory holds skills. AG's bounded working role is
the analogy. AG can change across turns; an immutable projection revision selects
one retrieval/disclosure surface. Calling the entire AG a query projection would
collapse those distinct lifecycles.

### Modern agent memory systems (engineering comparisons)

The recorded MemGPT/Letta comparison maps core memory (in context) to AG's
working role, archival retrieval to LTG and conversation recall to evidence.
Mem0/Zep provide extraction/graph-construction comparisons. These are engineering
analogies, not validation of NMG, dependencies, or proof that other systems lack
provenance/verification. The [runtime literature cross-check](../session-active-graph-runtime-design.md#literature-cross-check-surveyed-2026-09-01)
keeps the historical survey and its evidence limits.

### Boundary notes

- AG is not exactly A-S short-term memory or raw capture. It is a mutable working
  graph selected from provisional/durable meaning and observations; projections
  are frozen separately.
- Cowan's focus-of-attention view, with approximately four chunks, is an
  unverified background pointer retained from the earlier notes, not an AG cap.
- NMG's immutable `HistoryRecord` is closer to episodic source traces; STG/LTG
  are semantic interpretations. CLS's forgetting/interference descriptions are
  analogies, not measured NMG behavior.
- [Promotion and demotion](../memory-graphs.md#promotion-and-demotion) owns
  admission thresholds and provenance. No analogy overrides those conditions.
