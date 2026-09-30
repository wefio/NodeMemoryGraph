# 静态门禁声明自己的扫描面，并把活性发现交给人类判断

[English](2026-09-16-ci-static-coverage.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [非阻塞轨道也必须可见](2026-09-12-visible-non-blocking-research-track.md)

## Problem

第三方评审报出 `evals/ooo-execution/live-continuation.ts` 里有一个未被使用的 `throws` 声明。这条
发现是真的，而本仓库没有任何门禁可能产出它：

- `npm run lint` 只扫 `src/ .pi/extensions/ claude-plugins/ workbuddy-plugin/`。
- `npm run check` 的类型面是 `tsconfig.json` 的 include：`src/`、`.pi/extensions/`、
  `claude-plugins/` 以及 `tools/` 下的三个文件 —— 不含 `tests/`、`evals/`、`scripts/`，
  也不含 `tools/` 的其余文件。
- `npm run format:check` 覆盖的仍是原来那三个目录。

比"没扫到"更糟的是"扫了但没生效"。`eslint.config.js` 里早已有
`files: ["**/*.test.ts", "evals/**/*.ts", "scripts/**/*.ts"] → no-console: off`，
而它对任何文件都没生效：被扫的四个目录里没有 `*.test.ts`，`evals/` 与 `scripts/` 从不被扫。
`files:` 块落在 lint 脚本扫描面之外，并不是一条更宽松的豁免，而是一条从未运行过的豁免，
且没有任何东西能把它与"运行过"区分开。

另外两项测量决定了改动规模。按原配置拓宽扫描面后，8 个 `evals/omnimemeval/**/*.mjs` 探针报出
83 条 `no-undef`，全部是误报：配置没有声明 Node 全局变量，`process`、`console`、`fetch` 因此被
当作未定义。`tsconfig.tests.json` 存在却没有任何脚本或工具引用它，`tests/` 这条面因此不被任何
轨道做类型检查。

## Decision

**lint 扫描面 = 原四个目录 + `tests/`、`evals/`、`scripts/`、`tools/`。** Node 全局变量通过
`globals` 依赖一次性声明，这正是 83 条误报归零的原因；`no-console` 豁免改为点名它一直想覆盖的
目录：测试、研究 harness、脚本与仓库工具按设计输出 TAP、测量进度与诊断信息。

**两条活性规则在开发面上只报告，在 `src/` 上仍然是错误。**
`@typescript-eslint/no-unused-vars` 与 `no-useless-assignment` 都在断言"这个值从未被读取"——
这正是静态工具最可能对**活代码**判断错误的地方。它对本次改动自己的第一遍扫描就判错了：
`tests/core/graph-cycles.test.ts` 里那三个"未使用绑定"是漏掉的断言，不是死代码；下面 `tests/`
的 23 条里还有 4 条属于同一类。在阻塞规则下，通向绿灯最省事的做法就是把线索删掉。因此在
`tests/`、`evals/`、`scripts/`、`tools/` 上这两条规则只报告、不失败；在 `src/` 上它们照旧失败，
与改动前一致。要把某条提升为错误，是一次刻意改动：删掉那两行里的一行，并同步守卫测试钉住的
severity。

**扫描面是被检查的，不是被声称的。** `tests/tools/eslint-config-coverage.test.ts` 锁定三件事：
`lint` 与 `lint:fix` 扫同一批目录；每个以目录锚定的 `files:` 块都落在这些目录内；每个这样的块都
仍能匹配到脚本实际会扫的文件。它导入 `eslint.config.js` 并向 ESLint 自己的
`calculateConfigForFile` 询问生效的 severity，所以注释无法让它通过。它的第一条断言在改动前的
配置上就是红的 —— 当时 `evals/**/*.ts` 与 `scripts/**/*.ts` 指向扫描面之外。

**测试面的类型检查阻塞，ESLint 活性发现仍只报告。** `check:tests` 运行
`tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters`，在 `verify:static`
里执行一次；`ci-and-tests` 声明相同的原子检查。CI 调用共享契约，不重复运行 advisory 类型检查步骤。
覆盖面是配置显式包含的文件及其导入依赖，不等于全部 `evals/`、`scripts/`、`tools/`。
必跑的 `static` job 仍把开发面上的两条 ESLint 活性规则报为警告；这不放松 TypeScript 的 strict
类型检查或 unused 检查。

2026-09-25 的后续清理测得 79 条类型错误，并在不排除文件、不加 `@ts-ignore`、不放松编译器 flag
的前提下修复。fixture 补齐当前契约字段并收窄判别结果；Kimi hook 的 JavaScript 导出有声明边界，
渲染 fixture 使用完整检索记录。阻塞契约测试锁定一次 `check:tests` 调用，并拒绝重复 advisory 步骤。

**格式检查覆盖声明的 TypeScript 面。** `format` 与 `format:check` 以 `**/*.ts`
扫描 `src/`、`.pi/`、`workbuddy-plugin/`、`tests/`、`evals/`、`scripts/`、`tools/`。
暂存文件 hook 使用相同目录集合，子包保留自己的格式流程；本次不拓宽至 `.mjs`、`.mts`、Python
等类型。`test-groups.test.ts` 锁定两条命令的扫描面与 hook 一致性。故意错误的评估 fixture
只格式化、不修正确性：它们的错误行为是 evaluator 的输入，不是产品缺陷。

### 首次拓宽扫描报出的 11 条

第一次扫过新覆盖面时共 11 条。其中 9 条确实是死代码，已删除；另 2 条根本不是死代码：

| 发现 | 它是什么 |
| ---- | -------- |
| `evals/omnimemeval/experiment-manifest.mjs:133,134` | `llmClientText` 以及只为它存在的 `llmClientPy` 路径；它看起来要采集的参数其实由 `paramIn` 读取。已删除。 |
| `evals/omnimemeval/experiment-manifest.mjs:181,190,191` | `correct`、`anyHit` 两个每轮自增却从未被读取的计数器；分类汇总用的是 `byCat`。已删除。 |
| `evals/omnimemeval/merge-embedding-caches.mjs:52,76` | `kept` 以及它计数的 `wasMissing`；汇总里的重复量是 `total - finalCount`。已删除。 |
| `evals/omnimemeval/research/probes/hyde-context.mjs:120` | `userId`，被 store 真正使用的键 `storeUserId` 取代。已删除。 |
| `evals/retrieval/profile-size.ts:36` | 未使用的 `catch (e)` 绑定，改为 `catch {`。 |
| `evals/retrieval/run.ts:38` | 未使用的 `NODE_SUMMARY_PROMPT_VERSION` 导入。已删除。 |
| `evals/longmemeval/retrieval-evidence.ts:44` | `let traceId: string \| null = null` —— 每个读取 `traceId` 的路径都必须先经过赋值，所以初值从未被读。死存储。 |
| `evals/omnimemeval/research/probes/hyde-probe.mjs:167` | `let hydeCtx = baseCtx` —— 每次读取之前都已被赋值。现在改为赋值所在分支内的 `const`。死存储。 |
| `evals/halumem/agent-extract.ts:145` | 不是死代码：解析失败后重新抛出的新错误丢掉了原因。加 `{ cause: error }` 保留症状。 |
| `scripts/sync-nmg-skill.ts:140` | 不是死代码：锁竞争错误丢掉了触发它的 `EEXIST`。加 `{ cause: error }`。 |

### `tests/` 上 23 条发现的逐条判定

其中 5 条被报成死代码、实际是**丢失的断言**——这正是上面那条"只报告"severity 的依据：

| 发现 | 判定 |
| ---- | ---- |
| `core/graph-cycles.test.ts:120`（`m2`、`m3`、`m4` 未使用） | 丢失的断言，不是死代码。原来只检查了链首链尾，外加 `size === 5`，所以"5 个错误记录组成的集合"也能通过。现在改为与 `ids` 做集合相等断言。 |
| `core/store/duplicates.test.ts:177`（`norm` 未使用） | 丢失的断言。现在断言两条同规范化语句都被检索到，而这句话旁边的注释早已声明了。 |
| `core/store/duplicates.test.ts:375,381`（`old2026`、`new2033` 未使用） | 丢失的断言。as-of 排序此前只通过语句子串检查；现在把两个记录 id 断言到子串找到的槽位上，排序不再能被另一个记录满足。 |
| `cli/service.test.ts:836,837` | 死的初始化。这两个 id 在关闭 service 的 `try`/`finally` 之后才被读取，`""` 初值从未被读；改用 definite assignment 断言，与 `tests/support/test-runtime.ts` 已有的写法一致。 |
| `evals/longmemeval/retrieval-evidence.test.ts:24`、`evals/natural-maintenance-audit.test.ts:18` | 同样是死的初始化。 |
| `cli/process.test.ts:3`（`mkdirSync`）、`evals/omnimemeval-bridge.test.ts:8`（`NmgStore`） | 死导入，删除。 |
| `evals/omnimemeval-judge-provider.test.ts:86`（`init` 未使用） | fetch stub 的参数，本来就不被检查。改名 `_init`，与配置里的 `argsIgnorePattern` 一致。 |
| `extensions/nmg/index.test.ts:1457`（`error` 未使用） | 这个 catch 是为了在 Windows 上重试句柄释放，不是为了看错误内容；`catch {` 表达了这一点。 |
| `integration/controller-channel.test.ts:79,118`（8 条 `no-useless-escape`） | 模板字符串里的 `\"`。噪音，去掉多余转义。 |
| `support/test-runtime.ts:104`（`prefer-const`） | 噪音：handler 闭包引用了它正在构造的 server；改为单个 `const` 声明。 |
| `chaos/chaos-storage-corruption.test.ts:41` | 一条已失效的 `eslint-disable-next-line no-loop-func`，删除。 |

## Alternatives considered

- **只删掉那个死配置块，到此为止。** 否决：这去掉了症状（一条失效的豁免）却留下病因（没有门禁能
  到达的扫描面），评审那条发现仍然不可见。
- **对新覆盖面一律按 error 处理。** 否决：上面这些发现说明，正是那两条活性规则在这类代码上的判断
  不可靠；而阻塞门禁面对一条不可靠的发现，给出的答案是删掉它指向的代码。报告它们不花任何代价，
  为此失败则不然。
- **把 `evals/`、`scripts/` 的规则整体关闭来"消音"。** 否决：那正是守卫测试要防的失败。留在
  `warn` 的规则仍然持续报告；关掉的规则不再报告。
- **把 11 条先按分级警告留在原处。** 逐条读过之后否决：9 条是死代码——这正是该扫描存在的目的——
  另 2 条是丢掉的错误原因。分级留档等于给一个十行的修复套上文书。
- **用 job 级 `continue-on-error` 实现"只警告、不阻塞"。** 被
  [2026-09-12](2026-09-12-visible-non-blocking-research-track.md) 的先例否决；那还会重复一个已经
  存在的 job，而不是报告新的东西。
- **手写 Node 全局变量而不加 `globals` 依赖。** 否决：手写清单会重新制造正在修的同一类缺陷 ——
  漏掉一个全局变量，就会让每个使用处长期被报成未定义。
- **把配置当文本读取来做守卫。** 否决：那样注释与排版就能决定结果，而工单要求的正是"注释不能让它
  失败"。
- **永久保留 advisory 类型检查。** 实测错误修复后否决：它会允许同样的 fixture 与 API 漂移
  再次积累。把错误 fixture 经 `unknown` 强转或排除报错文件也被否决；它们不能证明测试遵守了
  自己要检验的契约。
- **把格式化 pass 混进 lint 或类型修复提交。** 否决：大范围研究代码格式化会淹没语义修复。
  覆盖扩展与受控 Prettier pass 单独提交，并验证 fixture 语义与 mutation 证据。

## Consequences

- `tests/`、`evals/`、`scripts/`、`tools/` 下的文件不再可能新增而不被 lint；`files:` 块也不可能再
  落在扫描面之外或匹配不到任何文件。
- 未使用的导入、未使用的变量与死存储会在每一个开发面上被报告。本次改动删掉了其中 9 条，下一条会
  以警告 annotation 的形式出现在运行里，而不是变成一个合并阻塞项。
- `tests/` 依赖图中的类型错误会使本地静态验证与必跑 CI static job 失败；编译器 flag 与
  include 面不变。
- 代价：一条没人读的 advisory 发现不是门禁。反作用力是这些发现会作为 annotation 挂在 diff 上、
  在运行里被计数，而守卫测试让 severity 自身不会悄悄漂移。
- 回滚：revert 一个 commit。这里没有数据迁移，也没有运行时契约变更。

## Deferred

- `evals/`、`scripts/`、`tools/` 中既未被 `tsconfig.json` / `tsconfig.tests.json` 显式
  包含、也未被其依赖图导入的文件仍在类型检查之外；全目录类型覆盖是独立范围。

