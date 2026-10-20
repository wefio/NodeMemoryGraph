# Information and communication interpretation

[简体中文](information-and-communication-interpretation.zh-CN.md) · [Terms used](information-and-communication-interpretation.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Information and communication interpretation

The information-theoretic model is a design and evaluation framework, not a
requirement to implement a literal codec:

```text
Historical stream       information source
Memory extraction       source encoder into STG
LTG nodes/relations     consolidated semantic codebook
Node/leaf headers       progressive access codes
SQLite/index            storage channel
Query/current context   decoder side information
Active Graph builder    query-conditioned decoder
Raw evidence            lossless fallback and error check
```

STG retains recent or provisional symbols before structural coding is stable.
LTG stores durable atomic memories and consolidated relations. The Active Graph
decodes only the bounded projection needed by the current task. Node headers are
short lossy codes, leaf headers add discriminating bits, typed relations provide
side information, and raw history prevents irreversible loss.

This interpretation supplies vocabulary and measurable objectives; it does not
claim that the implementation is a literal communications channel or that
semantic errors are independent bit flips. The distinction between implemented
mathematics and structural analogy is maintained in
[`math-physics-foundations.md`](../math-physics-foundations.md).

The topology can be evaluated with a minimum-description/rate-distortion
objective:

```text
J = structure_cost
  + lambda * semantic_distortion
  + mu     * retrieval_cost
  + nu     * maintenance_cost
```

Semantic distortion is not bit error rate. Relevant observable errors include:

- wrong node or block routing;
- missing supporting evidence;
- wrong scope;
- stale state selection;
- summary/evidence inconsistency;
- false relation expansion.

Hybrid signals act as error-correcting redundancy: FTS/exact terms, embeddings,
time/scope fields, graph paths, and raw evidence can correct one another's
failures. A structural change is justified only when it reduces expected
retrieval distortion enough to pay for its added complexity and maintenance.
