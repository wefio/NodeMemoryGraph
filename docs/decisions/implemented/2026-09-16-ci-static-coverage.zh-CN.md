# 静态门禁声明自己的扫描面，并把暂时还不清的债分级为警告

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
轨道做类型检查；按 `--noUnusedLocals --noUnusedParameters` 运行它，报出的正是评审那条发现所属的
"未使用代码"这一类。

## Decision

**lint 扫描面 = 原四个目录 + `tests/`、`evals/`、`scripts/`、`tools/`。** 只有 `src/` 从第一天起
按 error 报告，因为它是唯一原本就在扫描面内的目录。新纳入的研究面与脚本面上真正触发的三条规则
按 `warn` 报告，并在 `eslint.config.js` 里逐条按"规则 + 原因 + 退场方式"写明。降级机制不是把某条
规则对某个目录整体关闭：那会把发现连同检测能力一起删除。Node 全局变量通过 `globals` 依赖一次性
声明，这正是 83 条误报归零的原因。

**那条豁免终于作用在它一直想作用的地方。** 测试、研究 harness、脚本与仓库工具按设计输出 TAP、
测量进度与诊断信息，因此 `no-console` 对它们关闭，对产品代码保持开启。

**扫描面是被检查的，不是被声称的。** `tests/tools/eslint-config-coverage.test.ts` 锁定三件事：
`lint` 与 `lint:fix` 扫同一批目录；每个以目录锚定的 `files:` 块都落在这些目录内；每个这样的块都
仍能匹配到脚本实际会扫的文件。它导入 `eslint.config.js` 并向 ESLint 自己的
`calculateConfigForFile` 询问生效的 severity，所以注释无法让它通过；而它的第一条断言在改动前的
配置上就是红的 —— 当时 `evals/**/*.ts` 与 `scripts/**/*.ts` 指向扫描面之外。

**债在 CI 里被报告，但不会变成合并阻塞。** 必跑的 `static` job 增加两个 advisory 步骤：
`npm run lint:debt`（同一条 ESLint 调用加 `--max-warnings 0`，让被分级的发现可被计数）与
`npm run check:tests`（`tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters`，
这也是 `tsconfig.tests.json` 第一次被脚本引用）。两者在债存在期间预期失败，而
`continue-on-error` 加在**步骤**而非 job 上，因此必跑聚合仍然为绿。每次运行读者能得到的是：
每条被分级的 ESLint 发现一条 `warning` annotation、每个类型错误一条 `error` annotation，
以及 job 日志里两个退出码。读者得不到的是 checks 列表里的红叉：这笔债刻意不是合并阻塞项，
而一个在债清零前不可能变绿的 check，等于对一个仓库已决定不据此失败的东西宣布失败。
job 级 `continue-on-error` 仍被
[2026-09-12](2026-09-12-visible-non-blocking-research-track.md) 否决：那里的反对理由是 job 的真实
结果与"从未运行过"无法区分；把细节以 annotation 形式发出而不是把步骤吞掉，就是这里保住该区分的
做法。

### 新扫描面上被分级的 11 条发现

| 扫描面 | 规则 | 发现 |
| ------ | ---- | ---- |
| `evals/` | `@typescript-eslint/no-unused-vars` | `omnimemeval/experiment-manifest.mjs:134,190,191`、`omnimemeval/merge-embedding-caches.mjs:76`、`omnimemeval/research/probes/hyde-context.mjs:120`、`retrieval/profile-size.ts:36`、`retrieval/run.ts:38` |
| `evals/` | `no-useless-assignment` | `longmemeval/retrieval-evidence.ts:44`、`omnimemeval/research/probes/hyde-probe.mjs:167` |
| `evals/` | `preserve-caught-error` | `halumem/agent-extract.ts:145` |
| `scripts/` | `preserve-caught-error` | `sync-nmg-skill.ts:140` |

### `tests/` 上 23 条发现的逐条判定

`tests/` 不做任何分级降级。每条发现要么是**丢失的断言** —— 与评审那条 `throws` 同类，值被算出来
却从未被检查 —— 要么是死代码：

| 发现 | 判定 |
| ---- | ---- |
| `core/graph-cycles.test.ts:120`（`m2`、`m3`、`m4` 未使用） | 丢失的断言。原来只检查了链首链尾，外加 `size === 5`，所以"5 个错误记录组成的集合"也能通过。现在改为与 `ids` 做集合相等断言。 |
| `core/store/duplicates.test.ts:177`（`norm` 未使用） | 丢失的断言。现在断言两条同规范化语句都被检索到，而这句话旁边的注释早已声明了。 |
| `core/store/duplicates.test.ts:375,381`（`old2026`、`new2033` 未使用） | 丢失的断言。as-of 排序此前只通过语句子串检查；现在把两个记录 id 断言到子串找到的槽位上，排序不再能被另一个记录满足。 |
| `cli/service.test.ts:836,837` | 死的初始化。这两个 id 在关闭 service 的 `try`/`finally` 之后才被读取，`""` 初值从未被读；改用 definitive assignment 断言，与 `tests/support/test-runtime.ts` 已有的写法一致。 |
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
- **拓宽扫描面并在同一次改动里清账。** 否决：那 11 条发现位于正在并发改动的研究 harness 与构建
  脚本里，在这里重写它们会把无关的 eval 逻辑塞进一次 lint 改动，让两边的评审同时变差。分级为警告
  让这些发现仍可计数，而不是被丢掉。
- **把 `evals/`、`scripts/` 的规则整体关闭来"消音"。** 否决：那正是守卫测试要防的失败，工单也明确
  禁止。留在 `warn` 的规则仍然持续报告。
- **用 job 级 `continue-on-error` 实现"只警告、不阻塞"。** 被
  [2026-09-12](2026-09-12-visible-non-blocking-research-track.md) 的先例否决；那还会重复一个已经
  存在的 job，而不是报告新的东西。
- **用一个独立的非阻塞 job 报告这笔债（`research-tests` 的形状）。** 目前否决：它要多一次
  checkout 与 install，并会在每个 PR 上挂一个红叉，而这件事是仓库决定不阻塞的。步骤形式能携带
  同样的信息，却不会声称一个聚合并不兑现的失败。如果这笔债在变得紧迫时仍未清掉，这就是应当重新
  考虑的选项——两者之中，只有它会被只看 checks 列表的读者看到。
- **手写 Node 全局变量而不加 `globals` 依赖。** 否决：手写清单会重新制造正在修的同一类缺陷 ——
  漏掉一个全局变量，就会让每个使用处长期被报成未定义。
- **把配置当文本读取来做守卫。** 否决：那样注释与排版就能决定结果，而工单要求的正是"注释不能让它
  失败"。
- **在同一次改动里拓宽 `format:check`。** 记为 Deferred 而非否决：它是同一类漏洞，但需要对新增
  目录跑一次 Prettier，而研究代码的格式化重写会淹没与它同行的 lint 改动。

## Consequences

- `tests/`、`evals/`、`scripts/`、`tools/` 下的文件不再可能新增而不被 lint；`files:` 块也不可能再
  落在扫描面之外或匹配不到任何文件。
- `tests/` 这条面第一次获得类型检查，形式是一个 advisory 步骤，其失败计数就是债。
  `tsconfig.tests.json` 从一个没人读的文件变成了被脚本引用的文件。
- 分级警告是真实的债：它出现在每一次 `npm run lint` 里，也在每次 CI 里表现为逐条 annotation。
  退场标准已写明 —— 当 `npm run lint:debt` 对被分级的这些规则不再报出任何发现时，删除
  `eslint.config.js` 里那几行，并把 `lint:debt` 移入 `verify:static`。
- 代价：债存在期间 advisory 步骤每次都失败，而 checks 列表仍然写着 `All checks passed`。这笔债被
  报告，而不是被强制执行；只看 checks 列表的读者看不到它。annotation 与打印出来的计数是反作用
  力，而上面的备选方案是它不够用时的出口。
- 代价：advisory 步骤不能证明债是否真的在被还；只有退场标准和常规评审能做到。
- 回滚：revert 一个 commit。这里没有数据迁移，也没有运行时契约变更。

## Deferred

- `format:check` 仍只扫 `src/`、`.pi/`、`workbuddy-plugin/`。`tests/`、`evals/`、`scripts/`、
  `tools/` 仍未纳入格式检查，补上这个洞需要单独一次 Prettier pass。
- 没有任何轨道对 `evals/`、`scripts/` 以及 `tsconfig.json` 里那三个文件名之外的 `tools/` 做类型
  检查。`check:tests` 只是第一刀；产品面加同样 flag 只报 1 个错误，因此后续改动可以对它使用同样的
  分级处理。
- 上面列出的 11 条分级发现。
