# Skill 超出体积预算时，把细节路由进 `references/`

**Status:** implemented
**Approved:** explicit
**Relates to:** [仓库开发 Skill](../../../skills/repo-development/SKILL.md)、
[docs 索引的体积预算行](../../README.md#ci-contract)、
[NMG 记忆 Skill](../../../skills/nmg-memory/SKILL.md)、
[长检查异步跑](2026-09-18-detached-long-checks.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本变更改动了 Skill 的结构约定，因此自带决策与替代方案。

English version: [2026-09-18-skill-grows-by-routing.md](2026-09-18-skill-grows-by-routing.md)

## 问题

`docs/README.md#ci-contract` 记录、`scripts/verify-docs.mts` 强制的那条体积预算，钉在五个
`skills/*/SKILL.md` 入口上，每个 15 000 B。这个上限不是偶然的：这些入口是生成式 Agent 每个会话都会读的
常驻规则，预算买的是"第一次读有界"。

2026-09-18 这条上限先起了作用，然后变成了障碍。加入"长检查异步跑"规则时
`skills/repo-development/SKILL.md` 涨到 15 685 B，第一版处理是压缩这条规则——压了两次——降到 14 931 B，
只剩 69 B 余量。这是错误的压力方向：规则那份实测依据（约 13 分钟的 `mutation:teeth`、三种状态读法、
`A && B &` 的坑）于是只能搬到别处，而下一个规则要为同样的 69 B 打架。一个只能靠删掉自己理由才能生长的
文档，不是被维护的文档。

仓库里其实已经有答案。`skills/nmg-memory/` 就是"入口 10.3 KB + 八个 `references/*.md`（其中两个超过
10 KB）"的 Skill，靠"## When to read the manual"清单路由：清单把每个触发条件与对应参考文件路径成对列出。那些
参考文件按需读，预算也不管它们——政策行的范围写的是"each high-read `skills/*/SKILL.md`"，不是 Skill 下
的每个文件。也就是说，"让第一次读有界"的结构早就存在；缺的只是说明：这就是 Skill 生长的正规方式。

## 决策

1. **Skill 靠路由生长，不靠抬上限。** 入口接近预算时，把**触发条件是偶发**的整节移进
   `references/<主题>.md`，并在入口加一份路由清单——清单写的是**触发条件**，不是主题：
   "For <任务>" 后跟该参考文件的路径。既不抬 `BYTE_BUDGETS`，也不为省字节把一条规则压到丢掉它依赖的事实。
2. **按"多久用一次"切，不按大小切。** 入口保留一次改动正常都会走到的节——治理、发现、测试分类、
   implement-and-verify 主干。只在特定一类改动里才需要的节移出去。
3. **搬走的节保持原意，也保持传入指针。** 整节连同它的条件与例外一起搬（规则不许为了小文件丢条款），
   相对链接按新深度重新定位，所有按名字或锚点指过来的文档在同一个改动里更新。注意：链接检查会剥掉
   `#fragment`，所以**它抓不到失效锚点**——这一条是按意义复核的义务，不是机械检查能覆盖的。
4. **搬走的规则要拿到 owner 行。** 如果这个参考文件现在拥有了 `agent-context.yaml` 里某条路由的主题
   （`packaging`、`repository-control-plane`、各适配器），那条路由就把该参考文件列进 `owners`，正如适配器
   路由已经列了 `skills/nmg-memory/references/harness-adapters.md`。
5. **规则留在政策行里。** `docs/README.md#ci-contract` 在体积预算旁写明：上限覆盖的是常读入口，细节路由进
   `references/`；理由留在本记录里。

同一个改动里对 `skills/repo-development/` 的落实：`## Repository Control Plane beyond agent:verify`
（2 741 B）成为 `references/control-plane.md`，`## Builds and generated artifacts`（1 702 B）成为
`references/builds.md`，入口约 10.4 KB、余量约 4.5 KB。两节都保留可读、文字不改；两个带传入锚点的节
（`#before-editing`、`#implement-and-verify`）留在入口，正是为了让已实现的记录不必改链接。

## 考虑过的替代方案

- **给这个入口抬高 15 000 B 上限。** 否决。上限的意义是常读的第一次读；为一个入口抬就等于让这个数字对
  其它入口都变成随意值，而产生压缩的那种压力只会在 18 KB 处重演。
- **继续单文件硬压缩。** 依据否决：这条规则已经压过两次，第二次把实测细节从规则里压走、只留在决策记录
  里——规则和它的依据已经开始分居。继续这么换，是拿含义换字节。
- **搬入口里最大的那节，包括 `Implement and verify`（5 475 B）。** 否决。它是每次改动都要走的主干，
  切走等于让常见路径多读一个文件，而且它持有一个传入锚点和 `ci-and-tests` 路由的 owner。
- **路由进 `docs/design/` 而不是 `references/`。** 否决：Skill 的操作规程不是设计文档，`docs/design/`
  的内容按设计文档受检，而 `references/` 约定在本仓库已经存在、路由写法也已定型。
- **让预算覆盖 Skill 下的每个文件。** 否决：那会立刻破坏 `skills/nmg-memory/`，并且把"为了入口小才存在的
  按需细节"反过来卡住，恰好取消它存在的目的。

## 后果

- Skill 可以继续长大而入口不长大，常读成本被政策表写明的那个数字钉住。
- 入口同时成为地图：不需要偶发节的读者不必为它付费，需要的读者有名字明确的触发条件可跟。
- 切分是关于触发条件的判断，所以某个"偶发"节变常用时必须重新审视——切错的代价是热路径上多一次读文件。
- 失效锚点对 `docs:check` 不可见（它剥掉 `#fragment`）。因此传入指针的复核是改动的义务，本记录把它写下来，
  而不是指望检查器。

## 推迟

- **把锚点检查做实。** `verify-docs.mts` 可以校验链接的 `#fragment` 是否命中目标文件里的标题，这样决策 3
  的指针那一半就变成机械检查。本次没做：这是对文档合同的改动，自带误报面（GitHub 的标题 slug 与本仓库的
  规则），而且至今没有收集到失效锚点。
- **入口再次接近上限时的第二次切分。** 剩下的大节是 `Implement and verify` 与 `Repository governance`。
  其中任何一个要搬，都是关于热路径的决策，而不是机械跟进。
- **住在别的 worktree 里的指针。** 兄弟 checkout（分支 `feat/ooo-s4-comparison`，那里尚未提交）里的
  `AGENTS.md` 按节名指过本 Skill 的 "Builds and generated artifacts"。这样的指针一旦落地，应指向
  `references/builds.md`。
