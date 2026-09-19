# 为逃逸出去的失败新增事故复盘层

[English](2026-09-13-postmortem-tier.md)

**Status:** implemented  
**Approved:** explicit

## 问题

NMG 已经记录了设计、决策、测量、完成度与未完成事项，但没有一处安放"到达了它不该到达的地方"的失败。于是重新发现代价最高的部分——每一道安全网为什么都没拦住——无处落地。

已经有两次逃逸出去的失败是被顺带记录的：

- 一次家族迁移用 `git show HEAD:<path>` 覆盖了一批文件，取到的是更早迁移之前的版本，又从错误的备份路径恢复，只把后一次迁移重新应用。于是更早那次迁移在同时出现在两批里的四个文件中静默消失，而 `evals/` 没有任何校验覆盖。它是一次一次性的重复度测量偶然发现的（`90178712`）。
- `omni-venv` 被删除后，`benchmark:omni` 改用 `PATH` 上碰巧存在的 `python` 继续运行——产出的是错数字而不是错误——而另一个脚本则大声失败。这条只落进了[ venv 决策](2026-09-11-benchmark-venv-consolidation.zh-CN.md)的 `## Problem` 里，因为那一节正是决策用来交代动机的地方。

两次都是偶然发现的，而且它们发生当天并不存在哪条规则缺失：缺的是失败叙述没有 owner，而已有的每一层都不欢迎它。决策记录的主题是一次选择而不是一次事故，其格式也没有时间线或根因的位置。`docs/experiments/` 保存的是向前看的测量，且只有被决策接纳后才成为规范。`docs/design/improvement-areas.md` 列的是尚未造成失败的缺口。而[精简清单](../../../skills/doc-maintenance/SKILL.md#one-home-per-fact-and-the-slop-checklist)禁止在设计散文里叙述历史，这条禁令本身是对的。剩下唯一的去处就是 commit body，而只有已经知道是哪个 commit 的人才找得到它。

## 决策

新增 `docs/postmortem/`，作为本仓库失败叙述的唯一归属，并对其结构加门。

- **触发条件。** 机制隐蔽、逃逸原因是系统性的（测试、工具、校验或约定上的缺口）、且重新发现代价高昂时才写。普通的 bug 修复留在 commit 里。这条规则写在[该层的索引](../../postmortem/README.zh-CN.md#什么时候写一篇)里。
- **必需章节。** 每篇记录都带非空的 `Executive summary`、`Summary`、`Impact`、`Timeline`、`Root cause`、`Guardrails added`、`Lessons`。这些问题就是写作者必须回答的问题，其中包括"这次失败**不可能**做到什么"。确实没有答案的章节要用文字说明。
- **头部块。** 字段集合封闭，只承载 `**Status:** open | resolved`——`resolved` 表示防护已存在且已链接，`open` 表示机制已弄清但尚未被拦下。
- **编号与索引。** 记录按 `NNNN-slug.md` 命名，从 `0001` 起连续，英文为规范版本，可配 `.zh-CN.md`。索引每篇记录一行，并带上它的失败类别。
- **防护的归属。** 记录链接现在能拦住这一类的每道防护；规则本身留在它的 owner 上——一个测试、`docs:check` 的一行、一个 Skill 约定或一篇决策。记录从不复述规则。
- **校验。** `docs:check` 会因以下情况失败：记录命名不合规、编号不连续或重复、必需章节缺失或为空、状态不在枚举内、头部出现未知字段、记录未进入索引、索引行指向不存在的记录。`docs/postmortem/README.md` 与每篇记录都属于契约文档，因此断掉的防护链接是错误而不是警告。缺译文仍只是警告，与决策记录一致。

规则写在索引与 [doc-maintenance](../../../skills/doc-maintenance/SKILL.md) 里；门是 `scripts/verify-docs.mts` 中的 `checkPostmortemRecord` 与 `checkPostmortems`，测试在 `tests/docs/verify-docs.test.ts`。政策行在 [docs/README.md](../../README.zh-CN.md#ci-契约)。

## 考虑过的替代方案

**继续把事故故事留在 commit body 里。** 这是现状，而它恰恰在促成这次变更的情形上失效：批量恢复事故横跨三个 commit，包含两处由不同手段发现的静默失效，解释被拆散在没有任何索引可达的散文里。commit body 是 changelog 条目，不是一份状态还能停在 `open` 的记录。

**把事故写进修复它的那篇决策里。** venv 决策就是这么做的，当事故只有一段、修复只对应一次决策时它可用。但没有任何决策产生时它就失效：批量恢复事故只改了一处命名、撤回了一道门，两者都是次要的，而真正的教训——一次没有任何校验覆盖的恢复操作——不属于任何决策。它还会让决策承担第二份职责，因为决策格式里没有 `Timeline` 或 `Root cause`。

**放进 `docs/experiments/`。** 实验是被决策接纳后才成为规范的测量，其文件名带运行日期。事故复盘是向后看的记录，不确立测量，且比事故本身活得更久；复用这一层会让每个读实验的人遇到第二种生命周期不同的文档。

**扩展 `docs/design/improvement-areas.md`。** 它以 symptom/concern/approaches 的形式列出尚未发生失败的缺口，也没有从 open 走到 resolved 的状态。一条带证据和防护的失败会成为该文件里的第二类条目，而它的现状性论断归设计层治理。

**放进 `.rcp/counterexamples.yaml`。** counterexample 是对某个断言提出的开放质疑，必须带上证明该断言为假的输入；`unsubstantiated` 用于无法复现的担忧。事故复记录的是已经发生过的失败，带根因和防护，而不是一个待质疑的断言。

**改用带日期的文件名（决策与实验的写法）。** 事故是靠类别与序号被引用的（"静默丢掉迁移的那次批量恢复"、"第 0001 号事故"），日期本来就在 git 里。沿用日期在前的形状会让两层看起来相同却含义不同：一种是选择，一种是失败。

**只做警告而不报错。** 决策层就是反证：三篇 `implemented/` 决策一直带着 `## Acceptance criteria`，直到[一道门禁止该标题](2026-09-09-enforce-documentation-rules.zh-CN.md)。必需章节不被强制的层会退化成散文堆，而"空章节即错误"正是迫使写作者诚实写下"未重建"的机制。

**不要索引，只用目录。** [同一篇 2026-09-09 决策](2026-09-09-enforce-documentation-rules.zh-CN.md)移除了决策索引，理由是它重复了路径已经编码的标题、生命周期与日期，并引用了 DeepSeek Harness 因同样理由删除自己 `INDEX.md` 的做法。这个论证不能平移：事故复盘的索引承载失败类别，而没有任何路径成分编码它；它是每次事故一行，而决策索引是每篇决策一行（今天约 30 行）。这份副本在真正要紧的方向上被校验守住——记录未进索引会失败，索引行指向不存在的文件会通过契约文档链接校验失败。代价写在"后果"里。

## 验证

- `docs:check` 会因记录命名不合规、编号在连续序列中缺失、`**Status:**` 不在 `open | resolved` 内、必需章节缺失或为空而失败；四种情形由 `post-mortem records enforce a numbered name, an exact status, and sections` 覆盖。
- 编号出现缺口与同一编号被用两次都会失败（`post-mortem numbering is contiguous from 0001 and unique`）。
- 记录未进索引、以及索引行出现两次，都会失败（`the post-mortem index lists every record exactly once`）。
- 记录与它的 `.zh-CN.md` 译文是**同一篇记录**：两个文件名都通过，编号与索引行按英文名计一次，译文同样要满足头部与章节要求（`a record and its translation are one record, not two names and not a naming error`、`a translation still has to carry the record's header and sections`）。这条命名规则的第一版会判译文违规，于是这个层里没有任何一篇记录能带上译文——这是当天另一条工作流写进这个层里的真实记录发现的，而不是测试发现的（当时还没有译文用例）。
- 头部字段保持英文、章节标题可翻译；**被翻译的字段会自己说明问题**：`**状态：**` 会被报为未知字段，而不只是"它替换掉的那个英文字段缺失"（`a translated header field is reported as the unknown field it is`）。
- 加入该层且尚无任何记录时，`npm run docs:check` 报告 0 错误、0 警告。

## 后果

- 新增一次事故要改两个文件——记录与索引行——每种语言各一份。门把这一对绑在一起；它判断不了根因是否正确。
- 失败类别列会累积成这个仓库反复重新发现的逃逸类别清单。上面引用的三处失败里已有两处属于同一类：本该大声失败却静默降级的回退。
- 记录进入契约文档集合，因此烂掉的防护链接会让 `docs:check` 失败。这是刻意的：记录的核心主张就是"那道防护存在"。
- 与决策层一样，门校验的是结构而不是诚实。写下"未重建"的章节会通过，也没有任何检查会发现机制写错了。

## 未完成项

已知的两起事故——静默丢掉 parts 迁移的批量恢复、以及回退到 `PATH` python 的 benchmark venv——尚未写成记录。先把这一层落地，这样这些条目是写在一道已经强制其形状的门之下的。

`Failure class` 在记录足够多、足以把类别收敛成受控列表之前保持自由文本。
