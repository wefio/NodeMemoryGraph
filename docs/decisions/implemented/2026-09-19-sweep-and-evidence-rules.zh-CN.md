# 扫描运行中的树不可读，且证据没有第三态

[English](2026-09-19-sweep-and-evidence-rules.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [事故记录 0003](../../postmortem/0003-checks-read-a-live-mutant.zh-CN.md)、[事故记录 0004](../../postmortem/0004-flaky-was-a-clock-boundary.zh-CN.md)

## 问题

本分支上的两个失败类别，无法用已有机制关闭。

1. **检查会读到 mutant。** mutation 扫描把一个具名的错误版本替换进目标文件、之后再还原；在两次写之间，
   磁盘上的文件**就是** mutant。在这个窗口里跑的 `lint` 与 `complexity:gate` 报的是 mutant，而在那里**通过**的
   检查，是关于从未存在过的代码的证据。覆盖这一点的规则只写了"写"（"不要编辑、不要暂存正在被扫描改写的
   文件"），而那正是扫描进程自己控制的一侧——检查只是**读**，所以规则从未触发。随后同一个类别第二次逃脱：
   被杀掉的扫描把 mutant 留在树里，下一条扫描把它继承为基线。
2. **标签会关闭问题。** `test:product` 在负载下失败过一次，被 ledger 记成 "flaky, not fixed"，然后一整个会话
   无人再看。它是真实产品缺陷（current-value 边界上 JavaScript `Date` 与 SQLite `now` 相差 1–2 ms），只在
   这个标签被拒绝之后才被发现。

(1) 的机制部分现在有机械防护（锁与拒绝）。两者剩下的都是**检查无法裁定的会话行为**：读者在扫描持有树时如何
对待它，以及一条 ledger 行可以对无法复现的失败说什么。

## 决策

三条规则落在 `skills/repo-development/SKILL.md`——这个工作流原本的归属地：

- **运行中的扫描让树不可读，而不只是不可写。** 信号是那把锁（`tools/mutation-lock.ts`），
  `npm run agent:verify` 在持有期间拒绝，`npm run agent:context` 打印它。读者不再靠记忆重建这件事。
- **证据没有第三态。** 间歇失败要么连同复现尝试与比率一起记录，要么留在 open——绝不写成 "flaky"，
  那是一个关闭了无人回答之问题的标签。
- **各车道的进度信号不同，不可互换。** 测试车道流式输出 TAP；扫描只在结束时写总结，因此它的实时信号是
  锁的 `target`（每换一个目标就前进）加上目标文件的 mtime。

## 考虑过的替代方案

- **让三条都只留在两篇事故记录的正文里。** 拒绝：`docs/postmortem/README.md` 的晋级规则明确说，防护只是记录
  自身正文的类别**没有被抓住**；而类别 (1) 已经逃脱两次——正是晋级的触发条件。
- **为"禁止贴 flaky 标签"写一条检查**（ledger 行出现 flaky 且无复现就失败）。拒绝：过度拟合——这个词在记录
  "它为什么错"的句子里是正当的，而这条规则要裁的是失败**意味着什么**，不是字符串。
- **让 harness 每目标/每 mutant 打印一行**，好让 Skill 里旧的说法（"每个 mutant 一行进度"）变成真的。不是拒绝
  而是**推迟**，且本决策不依赖它：锁已经回答了"还活着吗、在哪"，无需新增输出契约；改 harness 是它自己的切片。
- **把规则写进 `AGENTS.md`**（晋级表允许的另一个归属）。拒绝：这个工作流的归属文档是 repo-development Skill，
  而这些规则说的是如何跑它的车道。

## 后果

- 机械的一半由代码承担并被钉住：`tools/mutation-lock.ts`、`tools/agent-verify.ts` 的拒绝、`tools/repo-context.ts`
  的警告行，以及 `tests/tools/mutation-lock.test.ts`（其中一例真的跑一次扫描，断言被替换的 mutant 报
  `live: true`）。
- 判断的一半由 Skill 承担，因此读到它的会话不会得出"扫描什么都不打印，所以它卡住了"，也不能靠命名来关闭失败。
- 一条 ledger 行不再能用标签结束问题：那句 "flaky, not fixed" 现在带着复现率与已修缺陷，而它原先的措辞错在
  读者可以看见的地方。
- 这些规则是在本记录之前写进 Skill 的，而审批层级（[2026-09-09](2026-09-09-approval-tiers.zh-CN.md)）要求它为
  explicit。操作者于 2026-09-19 在产生它们的同一个会话中批准；本记录即那次批准，顺序上的失误被写明而不是掩盖。
