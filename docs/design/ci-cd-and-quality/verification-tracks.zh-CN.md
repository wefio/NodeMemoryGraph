# 选择验证轨道与解释静态检查

[English](verification-tracks.md) · [使用的术语](verification-tracks.terms.yaml)

**Authority:** [所属范围](../ci-cd-and-quality.zh-CN.md).

## 执行轨道

按要验证的行为选择入口。产品正确性、研究表征和故障注入不是相互替代的证据；
运行了某条轨道，也不表示其他轨道已经运行。表中列出用途，精确命令集合由
`package.json` 拥有；CI 的触发与聚合条件见[CI 契约](../ci-cd-and-quality.zh-CN.md#ci-契约)。

### 选择测试或组合验证入口

| 命令 | 内容 | 用途 |
| --- | --- | --- |
| `npm run test:product` | core、CLI、adapter、docs、Skill、工具与 test support | 产品正确性 |
| `npm run test:coverage` | 与 product 相同的集合并生成覆盖率 | 阻塞 CI |
| `npm run test:research` | `tests/benchmarks`、`tests/evals`、`tests/official` | 非阻塞研究表征 |
| `npm run test:chaos` | Windows 故障注入与进程/文件锁生命周期 | 独立阻塞轨道 |
| `npm test` | 所有 `tests/**/*.test.ts` | 本地完整兼容入口 |
| `npm run verify:static` | build/package/type/牙齿锚点/lint/format/docs/context/complexity | 本地与 CI 共用 |
| `npm run verify:product-ci` | build + product coverage | 本地与 CI 共用 |

一次本地验证实际执行哪些 blocking/advisory 检查，以其计划和结果为准；不能从表中的
轨道名称推断所有检查均已执行。自动选路和失败处理见[验证流水线](../ci-cd-and-quality.zh-CN.md#ai-开发验证流水线)。

### 本地分析与自动修复

以下三个命令只用于本地，刻意不作为 CI 轨道：`npm run lint:fix`（与 `lint` 同一 ESLint 范围，加 `--fix`）、`npm run hotspot:modules`（对 store 各方法做静态调用点计数）、`npm run perf:hotspots`（从某个 store 的 `perf_aggregates` 打印分段延迟占比）。

### 判断 lint 与格式检查覆盖了哪里

`npm run lint` 扫描
`src/ .pi/extensions/ claude-plugins/ workbuddy-plugin/ tests/ evals/ scripts/ tools/`。
解释结果时区分以下例外：

- `@typescript-eslint/no-unused-vars` 和 `no-useless-assignment` 两条活性规则都判断
  “值从未被读取”。在 `tests/`、`evals/`、`scripts/`、`tools/` 上，两者只报告 `warn`；
  在 `src/` 上仍为 error。其余规则对开发面与 `src/` 使用相同标准。
- 测试、研究 harness、脚本和仓库工具按设计打印，因此这些面的 `no-console` 关闭。

活性告警需要检查是否漏掉了消费或断言，不应只为消除告警而删掉线索。
`tests/core/graph-cycles.test.ts` 的三个“未使用绑定”实际是漏掉的断言；这也是不把开发面
这两条规则升级为阻塞错误的理由。完整取舍见
[静态覆盖面决策](../../decisions/implemented/2026-09-16-ci-static-coverage.md)。

`tests/tools/eslint-config-coverage.test.ts` 检查扫描面的完整性：`lint` 与 `lint:fix` 同面；
config 中每个以目录锚定的 `files:` 块均落在扫描面内，且仍能匹配文件。
生效 severity 由 ESLint 自己回答；提升规则级别必须是刻意的规则变更。

`format` 与 `format:check` 的 `**/*.ts` 面为 `src/`、`.pi/`、`workbuddy-plugin/`、`tests/`、`evals/`、`scripts/`、`tools/`；暂存格式 hook 与它们同面，子包保留独立流程。守卫测试锁定两条命令及 hook 一致，评估 fixture 的故意错误行为不因格式化而修正（[静态覆盖面决策](../../decisions/implemented/2026-09-16-ci-static-coverage.md)）。

### 区分类型检查与机制词检查

`npm run check:tests`（`tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters`）进入 `verify:static` 与 `ci-and-tests` 的阻塞集合。它检查 `tests/`、配置显式包含的源文件以及它们导入的依赖；不声明覆盖全部 `evals/`、`scripts/`、`tools/`。

`check:policy-words` 在 `verify:static` 与 `ci-and-tests` 的阻塞集合中执行一次；维护词表、分类记录和扫描面由[机制，不是策略](../../decisions/implemented/2026-09-21-mechanism-not-policy.zh-CN.md#决策)拥有。它阻止未登记的命中与记录漂移，不证明机制层已无策略。

### 区分 mutant 锚点解析与实际 mutation 测试

`verify:static` 中的 `mutation:anchors`（`tools/mutation-teeth.ts --anchors-only`）
解析全部具名 mutant 的位置，不运行用例，也不写入文件。它只检查每个锚点能否解析，
不能用作实际 mutation 测试通过的证据。

该检查防止失效锚点被静默忽略：`mutation:teeth` 不在任何 CI 作业中，而匹配不到位置的
mutant 会在 sweep 报告中被列为“不可应用”并排除出分母。全量 sweep 仍不进入闸门；
它要实际运行用例，属于分钟级、推送前执行的常设规则。理由和历史缺陷见
[决策](../../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md)。

### 解释复杂度基线和未测量文件

`verify:static` 中的 `complexity:gate` 默认以 `git merge-base HEAD origin/main` 为基线；
使用 `--base <ref>` 可以显式覆盖。阅读报告时检查三个问题：

1. **用了哪个基线？** 每次运行必须报告基线。基线应为 merge base，而不是 `HEAD`：
   `HEAD` 只比较未提交内容，会漏掉已经提交到分支的改动，在干净 CI 检出上误报“无改动”。
2. **比较的是不是同一个方法？** 同名方法按 object/class owner 区分，身份由 AST owner
   推导，不依赖行号。不能只用 ESLint 的裸方法名覆盖 map；一个方法降到报告阈值以下，
   不得让另一个未变方法套用它的基线，也不能用另一 owner 的高复杂度债务掩盖增长。
   阈值和增长限制不变。
3. **哪些改动没有测量？** 报告必须点名这些文件。ESLint 拒绝某路径或无法解析文件时，
   同样可能产出“零发现”；没有测量不能解释为“量过且干净”。

### 保持 keyless 测试与 provider 环境隔离

`eval:*`、`benchmark:*`、真实 LLM/embedding 与官方大数据集运行不进入 keyless CI。研究测试可以验证 adapter 和计分契约，但不得访问外部密钥或把实验常量提升为产品默认值。

启动 daemon / MCP server 的测试，必须在模块顶层调用
`tests/helpers/test-env.ts` 的 `stripProviderEnv()`，清空
`NMG_EMBED*` / `NMG_SUMMARY*` / `NMG_JUDGE*`。被测 daemon 继承测试进程环境；
如果残留 ambient provider，例如 `NMG_EMBED_PROVIDER=gemini`，recall 会依赖外部服务，
变得缓慢且不确定。需要 provider 的测试必须显式传入环境，不能依赖 ambient 配置。

`tests/support/test-env-guard.test.ts` 扫描 `tests/**/*.test.ts`，检查 daemon 启动路径，
包括 `connectDaemon(`、`StdioClientTransport`、`bin/nmg.mjs`、tutorial 脚本和
pi extension harness。命中启动路径但没有模块顶层调用者的测试，一律失败。

### 解释覆盖率轨的并发与活性指标

覆盖率轨将测试并发限制为 2，避免 c8 插桩与跨进程/SQLite 测试叠加时制造内存峰值和 Windows 文件锁假失败；普通 product 轨仍使用并发 4。覆盖率轨还以 c8 的 0.01% 行覆盖率下限检查是否产生非零源码证据；它是活性检查，不是覆盖率质量目标（[决策](../../decisions/implemented/2026-09-23-coverage-evidence-liveness.md)）。
