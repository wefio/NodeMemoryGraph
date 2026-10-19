# Memory-maintenance feedback and evidence boundaries

[English](feedback-loop-design.md) | [简体中文](feedback-loop-design.zh-CN.md) · [Terms](feedback-loop-design.terms.yaml)

**Status:** Current contract summary, checked against the core store, daemon service, Pi remember surface, and controller-shadow integration.

NMG records observable retrieval and write events, but those observations are not interchangeable with semantic judgments or evidence that an answer relied on a memory. This design separates three APIs and one diagnostic trace so that a memory write, a controller-training label, and a verified claim outcome cannot be confused.

## Four distinct signals

| Signal | Owner / source | What it supports | What it does not establish |
| --- | --- | --- | --- |
| Disclosure | NMG retrieval/render path | Which memory IDs were actually exposed in a recorded recall surface. | That the answer used them or was correct. |
| `answer_overlap` | NMG diagnostic | Textual overlap between an answer and surfaced memory text. | Causal use, truth, or a training label. |
| Claim outcome | Explicit caller with `source`, `sourceLineage`, `semanticTaskId`, and a supported/contradicted result | An attributable outcome event and a per-claim shadow posterior. | Automatic proof merely because retrieval, reuse, task completion, or silence occurred. |
| Supersession | Caller or separately configured judge | A declared same-scope replacement of an older value. | A fact inferred from similarity alone. |

A diagnostic overlap score must never be promoted into a `claim outcome`. The owning write and evidence contracts are in [`skills/nmg-memory/references/writes.md`](../../skills/nmg-memory/references/writes.md) and [`skills/nmg-memory/references/natural-evidence.md`](../../skills/nmg-memory/references/natural-evidence.md).

## Do not conflate the feedback APIs

### `NmgStore.recordFeedback(RecordFeedbackInput)` — write-path maintenance

This core-store method accepts:

```ts
interface RecordFeedbackInput {
  sessionId?: string;
  attributedMemoryIds?: string[];
  supersede?: {
    supersededMemoryId: string;
    newMemoryId?: string;
    reason?: string;
  };
  retrieveHints?: Array<{ memoryId: string; hints: string[] }>;
}
```

- `attributedMemoryIds` is an explicit access signal and updates usage statistics. It is not evidence of causal model reliance.
- `supersede` is a caller judgment: both IDs apply full supersession; only the old ID marks the record `disputed` until a replacement exists. See [supersession design](supersession-design.md).
- `retrieveHints` attaches the supplied hints to the named memory as canonical `recall_trigger` markers and refreshes its search projection. Unknown memory IDs are a soft no-op. Hints are retrieval metadata, not new claims.

The Pi `nmg_remember` tool exposes supersession as `action=supersede`; its remember surface displays candidates but explicitly leaves semantic selection to the Agent. The generic core store does not call an LLM to decide whether to supersede.

### Daemon/MCP `recordFeedback` — online learner input

The daemon method with the same name is not `NmgStore.recordFeedback`. It consumes labeled automatic-recall feedback for the online learner. It requires the explicitly named `activeGraphId`, binds feedback only to that graph, and does not fall back to the latest staged decision. If the learner is unavailable, the graph is absent, or the learner has no usable staged decision, it does not report training. This API does not apply memory supersession or save claim outcomes.

### `recordClaimOutcomes` — attributable claim evidence

This is a separate path for explicit `supported` or `contradicted` outcomes. The caller must provide a non-empty `semanticTaskId`, `sourceLineage`, and valid claim selection. A supplied `activeGraphId` restricts votes to memories actually exposed by that trace. The task key prevents repeated turns from repeatedly voting for the same claim.

An optional `evidenceSource` carries a user/tool source message. When present, its actor must match `source`, and its `sourceMessageId` must match `sourceLineage`; source content and session ID are required. These structural checks establish attribution metadata, not an automatic semantic entailment check. The caller remains responsible for the verdict. `collectionOrigin` distinguishes `natural`, `controlled`, and `legacy` records; benchmark-origin votes default to `controlled`.

The resulting claim posteriors are shadow metadata until a calibrated retrieval policy explicitly consumes them. Recording an outcome does not itself change the memory statement, supersede another record, or activate a controller.

## Controller-shadow trace

The Pi controller-shadow bridge distinguishes the exact recall disclosure, diagnostic answer overlap, and attributable verified-claim support. A `verified_claim_support` trace is written only from accepted claim-outcome evidence; it is not manufactured from overlap or from the fact that a memory appeared in context. Shadow scoring records proposed decisions for inspection and does not actuate retrieval behavior.

For online feedback, the daemon learner additionally requires the graph identifier shown to the consumer. Missing or mismatched graph context is skipped rather than rebound to an unrelated decision.

## Evaluation boundary

`evals/omnimemeval/bridge.ts` may use a separately configured external judge to examine a restricted set of high-priority supersession candidates. That is benchmark-harness behavior, not a core-store guarantee or proof of normal product integration. Benchmark results and `controlled` collection records must remain distinct from natural product-maintenance evidence.

## Source references

See [`RecordFeedbackInput`](../../src/core/types.ts), [`NmgStore` write path](../../src/core/store/writes.ts), [`claim outcome` storage](../../src/core/store/maintenance.ts), [daemon service](../../src/cli/service.ts), [Pi memory surface](../../src/integration/agent-surface.ts), [controller-shadow bridge](../../.pi/extensions/nmg/controller-shadow.ts), and the [OmniMemEval bridge](../../evals/omnimemeval/bridge.ts).