# 用需求可追溯矩阵与变异测试支撑验证

[English](2026-09-08-requirements-traceability-matrix.md)

**Status:** implemented

## 问题

RCP 有两个作用：**作为入口引导 agent**，以及**独立验证并记录收据**。两者都为了回答本仓库否则无法回答的问题：

- **Q1——设计做没做？**（一致性）
- **Q2——有没有问题？**（正确性）

2026-09-08 对已发布代码的审计发现：两个作用都**没有完全接线**，两个问题今天都**没有被任何机器回答**。

**引导这一侧又薄又没被用上。** contract 编译成有界的 `WorkOrder`（允许路径、owners、`preserve`、`invariants`、所需检查、预算、预期产物），由 `nmg-rcp plan` 打印，并由命令 harness 从 stdin 接收；`intent` 与 `preserve` 还作为 memory recall 的种子。但 `formatPlan` 只打印 id、intent、允许路径和 checks——`preserve`、`invariants`、`owners`、`budget`、`expectedArtifacts` 只在 JSON 形式里。而仓库自己的开发流程**从不产出 WorkOrder**：它只跑 `npm run agent:verify`（只验，不引导）。`invariants`——设计里说的"agent 的禁止项"——被带进 `WorkOrder`，没有任何代码读取它。散文是引导的正确形状，却是验证的错误形状；同一个字段要同时服务两者。

**contract IR 基本是个壳。** `RepositoryContractIr` 的字段里，真正被消费的只有 `id`/`contractDigest`（work order 身份与收据绑定）、`scope`（允许路径与 scope gate）、`authority.mode`、`preserve`/`intent`（拼成 memory recall 查询串）和 `verification.forgeChecks`。`invariants` 只被写进 `WorkOrder`，无人读取；`extensions` 只解析、从不使用。默认窄化路径下，`planWorkOrder` 的 route 与 checks 来自 `agent-context.yaml` 加硬编码的 `NARROW_SHARED_CHECKS`，contract 的 `verification.routes`/`checks` 被绕过；无 authored contract 覆盖时，`synthesizeNarrowContract` 直接从 route 表反造一个。**三处**在各自声明"跑什么"：`agent-context.yaml` 的 `verify.blocking`、`NARROW_SHARED_CHECKS`、`contract.verification.checks`。

**CUE/OPA 管线并不存在。** 没有 `repo.contract.cue`，没有 CUE 运行时，没有 OPA/Rego，也没有 `Decision {drift, requiredChecks, blockingViolations, advisoryViolations}` 结构。`DefaultPolicyProvider` 只有十行：authority gate 加一句"work order 有没有 checks"。observation 只有文件 digest。

**2026-09-08 的 Dafny 实验**把 `src/rcp/repository.ts` 的 `changedPaths` 形式化：12 verified、0 errors、147 行。植入的 plausible bug（漏掉 modified 文件）被拒；但把契约弱化 + 实现永远返回空，仍然验证通过。**证明检查的是契约，不是意图，也不是那段 TypeScript。**

**根因不是 DSL 选错。** 两个作用里中间那一环都是空的：引导侧的 brief 从未到达 agent，验证侧的 contract 标准被绕过；而两者共有的设计始终是无人求值的散文。换 DSL、IR 或 prover 都救不了。

**这套流程不是新发明，行业版本更完整。** V 模型把每一层设计与一层验证配对，并要求双向追溯。DO-178C、ISO 26262、IEC 62304 与 ASPICE 都要求"每条需求被覆盖"的文档化证明；DO-178C Level A 要求 MC/DC 结构覆盖。"设计做没做"的机器可读形式是 **assurance case**——GSN（Goal Structuring Notation）或 OMG 的 SACM（Structured Assurance Case Metamodel）——一组可审计的 claim / argument / evidence，带显式 context 与 assumption，被 ISO 26262 推荐并已用于 AI 系统。2026 的 AI 原生工具（GitHub Spec Kit、AWS Kiro、Tessl）已提供 spec-first 的阶段模型，`spec-kit-trace` 已能产出 requirement→test 矩阵。下面的提案是这些的廉价子集，不是新点子。

**链条比矩阵长。** 验证只是链条中的一段：需求 → 可验证的验收标准 → 实现 → 单元测试 → 集成测试 → E2E → 部署 → 可观测性 → 真实效果指标。上面的提案只覆盖前六节，到"检查通过"就停了。右半边仓库其实已经有一部分——`evals/` 里有 retrieval、benchmark、gate、disclosure、concurrency、scale 等评估，`verify:research` 与 `verify:chaos` 也是显式执行组——但这些评估全是 **advisory**，而且**没有任何断言能指向它们**。部署只到构建期：`build`、`package:check`（`npm pack --dry-run` 的文件闭包检查）与 `verify:packages`（干净 lockfile 重建）。**没有任何东西真正打包、装进干净的消费方并跑起来**，所以"装上了能不能用"并没有被机器检查。生产可观测性**完全缺失**：`src/` 与 `docs/design/` 里没有任何 telemetry、metric 或 SLO 代码。真实效果指标只以**离线**评估分数的形式存在。所以链条在"检查跑过了"与"现场行为是对的"之间，有一道硬接缝。

本提案引入的词汇——`assertion`、`check`、`stage`、`kind`、`evidence`、`context`——本身就是撞名高危：`invariants` 已经覆盖了 `assertion` 的一部分，而"跑什么"有三处在声明。[仓库术语索引](2026-09-08-repository-terminology-index.md) 先给这些名字登记 owner，再实现本 schema。

## 决策

这是一个廉价的 **assurance case**：可审计的 claim(断言)、每条 claim 由具名 evidence 支撑的 argument,以及成立所需的 context。借 GSN/SACM 的结构,不借其工具;借 Spec Kit 的阶段形状,不借其工作流。

1. 契约断言结构化：`assertions: [{ id, statement, check, kind }]`，`check` 指向一个可执行检查，或显式标注 `documented-only`。`statement` 原样保留，于是该字段仍能引导 agent，而 `check` 让它可验证。
2. `kind` 说明 check 是什么：单元/集成测试、属性测试、**运行时断言**（design-by-contract，如 JML 与 E-ACSL）、**蜕变关系**（metamorphic relation，用于没有 oracle 的行为）、结构覆盖目标、或形式证明。标明种类很重要：NMG 有些行为（检索质量、摘要）根本没有期望输出。
3. 追溯**双向**且被检查：每条断言解析到至少一个 check；每个 check 归属至少一条断言；孤儿 check 被报告。
4. `agent:verify` 输出**覆盖表**（断言数、已验证、仅文档、未覆盖、孤儿），而不是二元 pass/fail；并**写入收据**，让过程结果事后可审计。
5. 覆盖按**准则**报告，而不是按数量：语句/分支覆盖（`test:coverage` 已在测）、safety-like 决策用 MC/DC、以及变异分数。DO-178C 自己的指引是：覆盖是**分析信号**，不是要刷的目标。
6. **失败关闭**：既无 `check` 又无 `documented-only` 标记的断言，验证失败。
7. 每条 check 带**负例**；只有正例会空过——`NODE_TEST_CONTEXT` 掩盖子进程正是如此。
8. 修改或退回断言**不属于实现者的权限**，且必须记录理由与 diff。
9. 追溯检查**不是 advisory**。它是**阻塞 check**（`rtm:check`），在窄化与 full 两条路径上都跑；其规则由 trusted baseline 冻结，所以候选无法削弱判定它的规则。该 check **受自身规则约束**：它必须归属到一条断言，或被显式标为 `documented-only`。这与 `testOutputPassed` 是同一个形状：验收规则被冻结在它所判定的代码之外。
10. 断言的 evidence 带命名空间，而不是裸 check 名：`node-test:<route>`、`eval:<name>`、`metric:<signal>`、`review:<id>`，或 `documented-only`。断言同时声明它验证的 `stage`：requirement、acceptance、unit、integration、e2e、deploy、observability、outcome。
11. 覆盖表升级为**链条覆盖表**：逐节报告 evidence 是阻塞、advisory、人工，还是缺失。现有的 `evals/` 成为断言可以直接指向的一等 advisory evidence，而不是活在另一个世界里。
12. 沿链条**失败关闭**：`outcome` 或 `observability` 的断言不能被单元测试关闭，`e2e` 的断言也不能被单元测试关闭。没有机器证据时，断言就是 `documented-only`，缺口**可见**，而不是被全绿的测试套件暗示成不存在。
13. 每条断言都要声明其证据覆盖的 **context**——平台、入口、输入、版本矩阵——因为**检查是采样，不是覆盖**。链条表把该 context 显示在对应节旁边，于是"两个 bin 入口在当前平台能启动"不会被读成"包在哪都能用"。
14. **边界。** RCP 是 local-first 的，它**无法拥有最后两节**。它能要求信号被**声明**、证据工件被**记录**；它无法观测生产指标，也无法证明某次改动导致了指标变化。链条表把这个边界显式化，而不是让通过的测试套件替一个已验证的效果背书。这就是 verification / validation 之分：矩阵证明"按规格造出来了"，不证明"造的是对的东西"。

2026-09-08 已落地：`spec.assertions: [{ id, statement, check | documentedOnly, kind, stage, context }]` 取代 `spec.invariants`，两份 authored contract 完成迁移。共 13 条断言：12 条**指名覆盖它的那条测试**（`node-test:<route>#<测试名>`），1 条 `documentedOnly`——「运行时注册与热重载保持不可用」这条没有任何测试断言的否定性声明。`npm run rtm:check` 在 check 既不是 package.json script、也不是已声明 route、也不是该 route 测试文件里真实存在的测试名时失败关闭，并报告没有任何断言认领的 check。`nmg-rcp plan` 现在打印 owners、preserve 与 assertions。

## 考虑过的替代方案

- **引入 CUE 与 OPA 运行时。** 否决。`DefaultPolicyProvider` 只有十行；控制面决策已把通用 DSL 与 CUE/OPA 运行时推迟。缺的是"可执行的设计"和"被消费的决策"，不是策略引擎。
- **用 Dafny 或 LemmaScript 当契约 IR/DSL。** 作为 IR 否决：两者都是函数级契约工具，不是仓库级配置。LemmaScript 是 TypeScript 原生的（无模型 gap），仍是纯逻辑不变量的候选 **check 类型**；但本仓库可验证面很小（`src/` 里 45 个 class、116 处 `await`、94 处 `node:` 导入、33 处 `Math.log/exp/pow/sqrt`）。
- **冻结测试、禁止修改。** 按原样否决：只要权限不分离，"退回"就是修改的后门；应改为版本化 + 独立批准人。
- **删掉 contract 层。** 暂不采纳：per-change 的 scope 声明与收据绑定是承重的，该删的只是那些空转字段。
- **完整采用 V 模型 / ASPICE / DO-178C 流程。** 否决：对单人维护的仓库太重——认证级的追溯、评审记录与工具资质是受监管行业的成本。取那个能产出性质（追溯、具名证据、独立性、冻结的验收规则）的廉价子集。
- **采用 GSN/SACM 工具链。** 借结构（claim / argument / evidence / context / assumption），不借 XML 元模型与工具。
- **整体采用 Spec Kit / Kiro / Tessl。** 借阶段形状（constitution、specify、plan、tasks、implement、validate）与 `spec-kit-trace` 的矩阵，不借 branch-per-spec 工作流；本仓库已有 contract 与 route。

## 验证

截至 2026-09-08 已验证：

- `invariants: string[]` 被 `assertions` 取代，两份 authored contract 完成迁移。
- 既无 `check` 又无 `documented-only` 的断言失败：契约编译不过，`rtm:check` 也失败。
- `rtm:check` 在窄化与 full 两条路径上都是阻塞项，对解析不到的 check 与不存在的具名测试失败关闭，并报告孤儿 check 但不因此失败。
- 文档写明：矩阵全绿意味着「声明的断言被检查过了」，不是「设计正确」。

## 未完成项

- `agent:verify` 不打印覆盖表；`rtm:check` 只打印一行统计。收据记录每个 check 的通过/失败与摘要绑定，**不**记录覆盖率数字——check 的 evidence 只在失败时写入。
- `rtm:check` 的规则摘要未钉在 `.rcp/trusted-policy.json`。
- 没有变异门，也没有变异分数。2026-09-08 手工对 `changedPaths` 与 `isPathAllowed` 打 4 个变异并还原；其中「去掉 `changedPaths` 的 sort」只有为此新增的测试能杀。
- 只有 `node-test:<route>`、`node-test:<route>#<测试名>` 与 `documentedOnly` 能解析；`eval:` / `metric:` / `review:` 命名空间未实现。
- 收据不带链条覆盖表；`outcome` 或 `observability` 的断言被单元测试关闭时，验证不会失败。
- 还没有任何 `deploy` 断言，所以「安装期证据」这条要求尚未被行使。

## 后果

- 规则已强制，但程序尚未完成：上面的「仍未满足」就是「已采纳」与「已完成」之间差距的诚实尺寸。
- 矩阵是维护成本，会腐烂。
- 变异测试慢；按改动范围限定。
- 矩阵全绿不闭合规格缺口：设计仍可能不完整或错误。矩阵让缺口**可见**，不是让它不存在。
- 覆盖数字会变成目标并被刷（Goodhart）。强度信号是变异分数，不是断言条数。
- 矩阵不闭合 validation 缺口：它证明"按规格造出来了"，不证明"造的是对的东西"。
- 效果指标是滞后且混杂的；仓库能要求信号被定义并发出，不能要求它变好。声称更多就是因果上的过度断言。
- 最后两节可能归消费方产品所有，而不是本仓库；在这里断言它们会造成对别人 telemetry 的虚假所有权。
- **没有检查等于覆盖**。检查证明的是被采样的那条路径，不是性质本身。变异分数衡量 check 对代码的约束有多紧，`documented-only` 记录什么没有被检查；断言措辞超出其 context 就是没有证据的声明。
