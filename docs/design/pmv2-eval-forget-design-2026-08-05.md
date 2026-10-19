# PersonaMem v2 Evaluation and Forget Rendering (2026-08-05)

[English](pmv2-eval-forget-design-2026-08-05.md) | [简体中文](pmv2-eval-forget-design-2026-08-05.zh-CN.md) · [Terms](pmv2-eval-forget-design-2026-08-05.terms.yaml)

Historical evaluation and design record. The run values below are transcribed from the 2026-08-05 report and were not reproduced in this documentation pass. The old runner's infrastructure notes are not current workflow instructions; use the [OmniMemEval evaluation skill](../../.pi/skills/omnimemeval-eval/SKILL.md) and its current config.

## Forget rendering decision

The report records a choice to preserve limited identity metadata for a forgotten memory while withholding its statement from agent-facing context. The visible marker was `[forget] (content withdrawn)`. The intended boundary was that an Agent can recognize a revocation record without receiving the content to quote or reconstruct.

Current code owners include [`src/integration/search-projection.ts`](../../src/integration/search-projection.ts), [`src/integration/agent-surface.ts`](../../src/integration/agent-surface.ts), the shared prompt at [`src/prompts/nmg-prompts.yaml`](../../src/prompts/nmg-prompts.yaml), and the [shared disclosure decision](../decisions/implemented/2026-10-10-shared-disclosure-copy.md). The extension test checks that forgotten content is absent from both search headers and formatted exact-lookup context ([`tests/extensions/nmg/index.test.ts`](../../tests/extensions/nmg/index.test.ts)). These current owners supersede the historical wording and adapter list in the original report.

## Reported PersonaMem v2 sample

The report described three runs over 60 questions:

| Rendering | Run label | `ask_to_forget` overlap count | Overall accuracy |
|---|---|---:|---:|
| Original statement plus marker | `155659` | 4/11 | 0.300 |
| Redacted content | `165251` | 4/11 | 0.267 |
| Metadata plus redaction | `omnimemeval_20260805` | 0/11 | 0.317 |

The report states that all 11 contexts in the redacted run omitted the original forgotten statement. But the leakage metric is not an outcome measure for redaction: answer options themselves included withdrawn phrases, answers were multiple-choice letters with no provenance, and the three-run accuracy varied. The values do not establish a causal behavioral benefit for one rendering. The decision was grounded in the semantic boundary—do not disclose withdrawn content—not in this noisy metric.

## Evaluation-workflow boundary

The note's temporary CSV truncation, Python encoding, file-lock retries, and runner command describe a dated debugging episode. They should not be copied as current instructions. Current benchmark entry points, configuration, and reuse rules belong to the OmniMemEval skill and `evals/omnimemeval/` owners. Historical benchmark values must remain attached to their dataset, model, prompt, judge, and sample; they are not a current baseline without a reproducible receipt.