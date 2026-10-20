# Shared recall entry diagnosis: Chinese recollection questions

[English](shared-recall-entry-diagnosis-2026-10-14.md) | [简体中文](shared-recall-entry-diagnosis-2026-10-14.zh-CN.md) · [Terms](shared-recall-entry-diagnosis-2026-10-14.terms.yaml)

## Scope and baseline

The user approved locating the failure and fixing only one reproducible breakpoint.
Baseline commit `bad23e60e25082b7f36379e10a822067fc7c8822`; Windows / Node 24.19.0.
This round used no external embedding, live LLM, judge, full benchmark or daemon
replacement, and changed no ranking, retrieval budget, output slimming or state
maintenance rule.

At 2026-10-14T10:39:05.373Z, ten records were taken from the existing daemon by exact get
and explicit FTS5 search: five known targets and five off-topic distractors. Search used
`persistTrace:false`; no feedback was submitted. Replay then happened only in an isolated
instance, so ongoing drift of the production router is not treated as a stable baseline.

All five targets were exact-got successfully with current daemon credentials:
`status=active`, `scope.project=NodeMemoryGraph`, tier 0 or 1, an effective `validFrom`,
`validUntil=null` and `expiresAt=null`. That proves this read and the targets' validity, not
content truth, whole-store completeness or another access identity.

| Target | source memory ID |
| --- | --- |
| AG model-visible content slimming preference | `4190957c-0228-4393-a4fb-3bdd6c0f4d68` |
| InformationView implementation event | `3972ae51-ecca-492d-aab0-cc24c6f38693` |
| Unified state implementation event | `122d3a03-840c-43b1-a77e-8b9720f9de14` |
| Maintenance Skill install event | `6e0e5d31-be9f-4f5a-a249-7949704bd4e8` |
| AG / board layout constraint | `4a2aac84-3300-4957-b668-eb298f2f7e77` |

The full A–D proposal is still owned by Git files; the first gold item is only a saved
preference and does not require recalling a complete plan that was never stored in NMG.
Historical implementation events also cannot alone prove current deployment state.

## Fixed replay conditions and boundaries

- Corpus SHA-256: `9823a93da1dc2238f94a6c0cf17d5c2596c779b1c780d85dcb99c19db0cecc2b`.
- Eight-case question set SHA-256: `4ee001f0b40f753fa049118a1c8ac59caf4b8558a45ee6506afe9f42fb2636b3`.
- Both arms used `retrievalMode:fts5`, `maxTier:1`, `limit:12`, `graphHops:0`,
  `secondPass:false`, `tieredDisclosure:false`, `persistTrace:false`, with no embedding client.
- The auto arm took its gate decision and query from real `SessionTaskWindow.prepare()`; the
  explicit arm used the question text verbatim. Only the continuation case was primed with a
  task anchor. Two arms with different queries are not claimed as a same-query ranking comparison.
- Used `searchMemoryContext()`, existing active-graph selections, `store.search()` candidates
  widened to 50 as a control, and `searchInformationViews()` / `prepareInformationOutput()`.
  The auto arm used the context shell and the explicit arm the flat shell, both 16,000 UTF-16
  code units; the zero-budget control case used 0. Different shells mean character differences
  cannot be attributed directly to ranking.

Replay copies statements, node, type, scope, tier, importance, stateKey and eventTime.
Fixtures were written as `assistant/unverified` and copy no production graph, evidence,
access counters, original validity, embeddings or online learning state; the instance used
isolated defaults and write times are not the original record times. This is therefore a
controlled comparison of entry and small-corpus lexical behaviour, not a full production
database snapshot, online precision or normal hybrid evaluation, and it does not cover the
degradation notice under provider failure. The shared gate's independent red test reproduces
the breakpoint without any corpus, which avoids treating replay metadata simplification as
the root cause.

## Question, target, lost layer, cause, fix

Numbers are the target's rank; "—" means the target was not returned, which does not mean the
record is absent.

| Fixed question | Target | auto before → after | explicit before → after | Localization and handling |
| --- | --- | --- | --- | --- |
| 好像是不是要精简AG内容来着？还有其他几步其他的？ | AG preference | — → 1 | 1 → 1 | gate returned none, no search ran; added the `来着？` question form |
| 之前AG显示瘦身的偏好是什么？ | AG preference | 1 → 1 | 1 → 1 | already recognized phrasing, unchanged |
| 你还记得都做了什么、有哪些没做吗？我忘了 | InformationView | 1 → 1 | — → — | auto carried the previous nmg-context anchor; isolated explicit lacked task words, so candidates were empty. Not fixed as a ranking bug |
| 先前的统一state入口是不是AG和board都能用？ | Unified state | 1 → 1 | 1 → 1 | previously fixed `先前` case used as regression, not re-fixed |
| 你记得 working-state-maintenance Skill装在哪里吗？ | Skill event | — → 1 | 1 → 1 | gate returned none, no search ran; added the `你／您记得` interrogative form |
| 之前AG和黑板的显示布局约定是什么？ | Layout constraint | 1 → 1 | 1 → 1 | original behaviour unchanged |
| 以前提过我最喜欢的火星餐厅吗？ | Should be empty | empty → empty | empty → empty | no such known record, correct empty result |
| 之前AG显示瘦身的偏好是什么？（显示预算 0） | AG preference | rank 1, shown 0 → unchanged | rank 1, shown 0 → unchanged | retrieval already hit; the whole item was budget-omitted, not a retrieval breakpoint |

DAP stopped in `decideMemoryLoad()` with the actual query
`你记得 working-state-maintenance Skill装在哪里吗？`; explicit and optional patterns were both
false. The stack was `SessionTaskWindow.prepare → decideMemoryLoad`, and no question text was
dropped. The independent core test also failed with `none/memory_not_needed` while expecting
`retrieve/explicit_recall`.

Two question rules were added only in the [shared gate](../../../src/core/gate.ts), with no
Pi-specific patch. Neither `记得` nor `来着` is matched as a bare substring; reminders to save a
file or run tests, and `用来着色`, still return none. Behaviour is defined in
[progressive retrieval](../../design/design/progressive-retrieval.md#progressive-retrieval),
and the reasoning follows the
[recall intent decision](../../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.md).

## Matched control results

- The core regression went red first (8/9) and green after the fix (9/9), covering five
  recollection questions and four negative controls.
- Four SessionTaskWindow contract tests passed, including forwarding the new question text,
  mode and reason.
- Both entry misses became auto rank 1 and actually entered the prepared text.
- The eight explicit results and the previously triggered auto results kept the same
  source-ID ranking, display selection and character counts.
- Display count of the five preselected off-topic distractors totalled 16 → 18 across all 16
  arms (repeated displays counted). The increase of 2 comes from the newly triggered AG
  question, which brought two video-to-text desktop records with the target; the Skill
  question produced no such increase. Explicit and previously triggered auto distractors were
  unchanged. That is residual lexical candidate mixing: no noise reduction is claimed, and no
  cause for full production ranking is asserted from it; a second layer was not changed here.
  Other related NMG records were not labelled irrelevant, so absence from the minimal gold set
  is not noise, and general precision was not measured.
- The two newly triggered auto texts added 2,088 / 551 UTF-16 code units respectively. That is
  input growth for recovered material, not slimming or a cost benefit; no billing, cache or
  latency conclusion follows.

## Evidence and reproduction

Diagnostics receipts live in the shared checkout under
`.nmg/verification/shared-recall-diagnosis/`: `corpus.json`, `cases.json`,
`eligibility.json`, `baseline.json`, `red.json`, `after.json`, `comparison.json` plus temporary
`collect.ts` / `probe.ts` / `compare.ts`. Those scripts are diagnostic artifacts, not a new
platform or product entry point.

Permanent minimal regression that runs independently:

```sh
node --experimental-strip-types --test tests/core/gate.test.ts
node --experimental-strip-types --test --test-name-pattern="session task window" tests/extensions/nmg/index.test.ts
```

The work closed on this shared gate breakpoint. Misses on the full corpus, other unrecognized
phrasings, normal hybrid behaviour, natural model behaviour, the final provider send and any
benefit are not proven by this round.
