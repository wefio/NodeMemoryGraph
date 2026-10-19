# Progressive Disclosure Evaluation (2026-08-08)

[English](progressive-disclosure-eval-2026-08-08.md) | [简体中文](progressive-disclosure-eval-2026-08-08.zh-CN.md) · [Terms](progressive-disclosure-eval-2026-08-08.terms.yaml)

**Status:** Historical HaluMem content-disclosure diagnosis and proposal. The report's configuration, thresholds, and code behavior are not current defaults. Its backend evaluation did not measure whether an Agent chose to call a tool. Raw observations below are tied to the 2026-08-08 `supersession_trial19` run and were not reproduced in this documentation pass.

## What was evaluated

The report examined the full HaluMem `supersession_trial19` set, with a recorded score of `0.7352` while embeddings were available. It evaluated backend `search()` output and memory-context disclosure. It did **not** evaluate whether an Agent would call `nmg_search`, follow headers with `nmg_get`, continue searching when evidence was insufficient, or abstain when memory was unnecessary.

The report states that all 2,329 imported records were `tier2 conversation_evidence`. Therefore the then-current `warm_halves` path—which required at least five tier-1 records—did not trigger. The evaluation also disabled QPP second pass (`NMG_QPP_SECOND_PASS=0`). The bridge used a nominal 20-item limit and 6,000-token budget; the report observed disclosure of about 13 conversation-evidence records.

## Promotion case and observed failure mode

For “What is Martin Mark's current job title as of June 15, 2033?”, the report's large-budget probe ranked the promotion memory at **#34**; the evaluated disclosure contained 13 unrelated generalized conversation records from 2033-05-10, not the 2033-04-25 “promoted to Executive Director” memory. The answer could not be recovered from the disclosed context. By contrast, a second query that explicitly asked about Martin's April 25 promotion ranked that memory **#1** and disclosed it.

The report described three interacting causes in that historical implementation:

1. lexical score was zero for “job title” versus “promoted to Executive Director,” and vector rank was weak;
2. QPP's then-current trigger judged intent-family coverage rather than content relevance and stopped early on the first query;
3. a `hardLimit` calculation still capped expansion at the caller limit, despite a comment describing the limit as recommended.

These are dated diagnosis statements. They are not claims about current QPP code or current defaults; use the current source and design owners below.

## Disclosure versus capability discovery

The report distinguished two independent questions:

- **Capability discovery:** whether the Agent knows a tool exists and chooses to call it.
- **Memory-content disclosure:** after a call, which candidate headers and exact evidence become visible, and whether the Agent continues or stops.

The HaluMem backend track began at `search()` and measured only content disclosure. The Kimi dynamic-tool-loading comparison in the original note was an analogy, not evidence that NMG and tool-schema loading are the same mechanism. External protocol details from that comparison are not repeated here.

## Historical proposals and evidence boundary

The note proposed revisiting the QPP expansion cap, enabling second pass in the benchmark, improving sufficiency signals, and exposing direct/related selection information for diagnosis. It also proposed a future Agent-tool-trace evaluation with tool-call rates, evidence retrieval after headers, continuation/early-stop behavior, token use, provider cache use, latency, and answer quality. These were proposals, not findings that the backend score measured those outcomes.

The report's `0.7352` is a flat-disclosure score in the described configuration; it is not evidence that progressive disclosure helped or hurt. Historical claims about promotion ranking, budgets, and feature activation must remain bound to this sample and code revision.

## Current owners

- [Tiered disclosure design](../../design/tiered-disclosure-design.md)
- [Fibonacci progressive recall](../../design/fibonacci-progressive-recall.md)
- [Retrieval confidence controller](../../design/retrieval-confidence-controller.md)
- Current retrieval implementation: [`src/core/store/retrieval.ts`](../../../src/core/store/retrieval.ts)

These owners supersede the historical defaults and implementation description in the 2026-08 note.