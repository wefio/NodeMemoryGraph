# A. Offline semantics

[中文](offline-semantics.zh-CN.md) · [Terms used](offline-semantics.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## A. Offline semantics

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| A1 | The compiler returns a legal plan or a refusal naming task, field and obligation | proven | `tests/integration/task-semantics.test.ts` |
| A2 | The offline model dispatches without publishing or storing run state | proven | `tests/integration/task-semantics-model.test.ts` |
| A3 | The design's six discriminating cases are executable | proven | `tests/integration/task-semantics-cases.test.ts` |
| A4 | Field mapping catches budget-unit confusion, requires/deps confusion and silently dropped keys | proven | mutants `budget-inner-alias-is-dropped`, `over-maximum-budget-is-accepted`, `assumption-may-carry-a-dependency` |
| A5 | Every legal event interleaving of at most four units is enumerated, and every publication at every prefix is checked for its obligations, its inputs and its source | proven | `tests/integration/ooo-publication-invariants.test.ts` (18 cases) over `src/integration/task-semantics-interleavings.ts`. The enumeration is a merge of per-unit scripts, capped at four units and six events, and the checks read the derived view rather than a second model: a dispatch must rest on closed, accepted inputs, a completion (the accepted set closed over the same predicate) must have its verdict bound to the bytes, its bytes present, no cancellation, and inputs that are present and accepted. Both halves are pinned: each checker condition is deleted by a mutant and caught by the case that names it - `the-completion-does-not-bind-the-verdict-to-the-bytes`, `the-input-is-not-required-to-be-accepted`, `the-input-may-be-cancelled`, `the-completion-ignores-a-cancelled-unit`, `the-dispatch-does-not-require-a-closed-input` - and the clean run over the design's script sets reports nothing. The merge's completeness rests on the enumeration's own count assertion rather than on a mutant: the case `the merge enumerates every legal order, not one of them` asserts the multinomial count, which a merge returning one order fails, and the tooth that showed it (`the-merge-enumerates-one-order`) was retired on 2026-09-24 ([decision](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)). The design's caveat stands and is quoted in the module: passing says this finite model satisfies the listed properties, not that any Agent program is correct |

| A6 | The publication order is the frozen plan's stable topological order, and the model's `ordered` mode is that order rather than any topological one | proven | the design sentence is "最初使用冻结计划的稳定拓扑顺序作为发布顺序；生成和验证可以越序". `tests/integration/task-semantics-model.test.ts`: the case `the ordered mode is the declared plan order and nothing else` asserts exactly one ordered plan, that its order is the declared plan order, that the mode reports one order, and that the baseline never gains order freedom while the out-of-order mode gains two - so a mode returning any topological order fails a count rather than a wording. The tooth `ordered-mode-becomes-any-topological-order` was retired on 2026-09-24, once that case stated the rule ([decision](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)) |
