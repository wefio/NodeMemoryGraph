# Cross-domain structural analogy: research and implementation boundary

[English](cross-domain-analogies.md) | [简体中文](cross-domain-analogies.zh-CN.md) · [Terms](cross-domain-analogies.terms.yaml) · Parent: [Temporal/logical chain design history](../temporal-logical-chains-design-2026-08-13.md)

Historical research note with a source-checked implementation summary. External papers and claims cited by the 2026-08-13 draft were not independently verified in this audit. The current implementation is structural candidate generation, not a general semantic-analogy system.

## Goal and non-goals

The design explores whether structurally similar subgraphs can suggest a useful cross-domain connection. It is not ordinary semantic search, and it is not repeated subgraph matching within one connected neighborhood. The output is a suggestion for a caller to inspect; it must not be treated as proof that two topics share a meaning.

The current implementation excludes nodes directly related to the query cluster by a consolidated relation. That does not prove that a returned node is semantically unrelated; the implementation does not perform a semantic-independence test.

## Current structural signature

`src/core/store/analogy.ts` reduces an input set of node IDs to the presence and counts of five structure patterns:

- `EVOLUTION`: supersession records associated with a node;
- `CONTRADICTION`: unique pairs connected by consolidated `contradicts` relations;
- `DEPENDENCY`: consolidated `depends_on` or `causes` relations;
- `AGGREGATION`: consolidated `is_a` or `part_of` relations;
- `FEEDBACK`: directed cycles found among the module's configured directed relation types.

`abstractSubgraph()` intentionally ignores node names and statement text. `findStructuralAnalogies()` builds the query signature, examines other nodes' ego subgraphs (`hops` defaults to `1`), and ranks non-empty signatures by Jaccard overlap of **pattern types**. Pattern counts do not weight the Jaccard score. The default candidate count is five. The operation returns node IDs, names, scores, shared pattern types, and the target signature; it does not write records, relations, or chains and does not change retrieval ranking.

The test suite includes a constructed “budget” / “tech-stack” fixture and reverse-direction checks. A fixture match—including a score of `1.0` when pattern-type sets are equal—does not establish general cross-domain accuracy, precision, recall, or user value. No benchmark result is claimed here.

## Relationship to other graph paths

Memory-chain expansion, graph-neighborhood retrieval, cycle diagnostics, and structural-analogy suggestions are separate operations. A chain is explicitly authored structure; an analogy is a computed advisory result from pattern overlap. Neither authorizes the system to write a new semantic relation or memory. See the parent [chain design history](../temporal-logical-chains-design-2026-08-13.md), current [chain source contract](converged-design.md), and the [supersession design](../supersession-design.md).

## Historical research context

The earlier draft cited structure-mapping / SME, MAC/FAC, graph-transfer and topology-pattern research, knowledge-graph embedding analogy (AnKGE), graph edit distance / SimGNN, curiosity-oriented cognitive architectures, and G²SN-Transfer as context for possible future work. It also cited TrustMem and MemOps to motivate conservative mutation and failure attribution. These are literature pointers from the historical note, not verified NMG evidence, and no quantitative claim from them is reproduced here.

## Source references

See [`src/core/store/analogy.ts`](../../../src/core/store/analogy.ts), [`tests/core/analogy.test.ts`](../../../tests/core/analogy.test.ts), the [memory-chain implementation](../../../src/core/store/base.ts), and the [chain retrieval path](../../../src/core/store/retrieval.ts).