# 代码质量与 CI/CD

[English](ci-cd-and-quality.md) · [使用的术语](ci-cd-and-quality.terms.yaml)

**Created:** 2026-07-20

**Updated:** 2026-10-15
**Authority:** 仓库测试、CI 与 Agent 开发流程契约

NMG 的测试负责阻止可复现错误，不负责冻结尚未验证的设计。产品契约、研究测量与故障注入使用不同执行轨道，避免 benchmark 便利逻辑反向定义产品行为。

## 按任务阅读

| 要完成的事 | 入口 | 读完后应能判断 |
| --- | --- | --- |
| 选择产品、研究或故障注入轨道 | [执行轨道](ci-cd-and-quality/verification-tracks.zh-CN.md) | 检查是否阻塞，以及没有运行的部分 |
| 找改动的 owner 与路由 | [Agent 仓库上下文](ci-cd-and-quality/repository-context.zh-CN.md) | 应改哪里、应运行哪些检查，而不是据导航结果推断架构正确 |
| 运行并解释本地验证 | [AI 开发验证流水线](#ai-开发验证流水线) | 实际 scope、命令状态、超时和失败归因 |
| 判断 narrow 或 full | [Gate 选择规则](ci-cd-and-quality/repository-control-plane/lightweight-verification.zh-CN.md) | 当前检查面及升级条件 |
| 审查验证收据 | [Verifier 与 receipt](ci-cd-and-quality/repository-control-plane/verifier-and-receipts.zh-CN.md) | 记录绑定了什么，以及不能证明什么 |
| 使用独立可信基线 | [固定基线验证](ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.zh-CN.md) | 安装前提、权限边界与失败处理 |

流程词义由本主题的 [RCP 词条](ci-cd-and-quality/repository-control-plane.terms.yaml)和
[验证词条](ci-cd-and-quality/verification-tracks.terms.yaml)拥有。正文首次使用仍保留必要解释；
完整条件在表中行为 owner，不要求先读完全部术语。共用清单引用规范词形，不复制定义；可查询规范名称或别名：

```sh
npm run glossary:check -- --resolve 收据
npm run glossary:check -- --resolve "assertion context"
```

## 仓库治理不变量

以下原则约束开发控制面、Agent 工作流与维护自动化；它们不建立新的状态库或审批层：

1. **Repository as environment**：主动把仓库塑造成 Agent 可导航、可理解、可验证的工作环境。稳定入口、owner、route、Skill 和验证命令应让 Agent 从目标路径找到下一步；反复需要口头解释的隐含知识应回到其既有 owner，而不是积累新的旁路说明。
2. **Proof before trust**：Agent 的完成声明、PR 文本或本地输出都不足以证明修改成立。目标测试、独立 verifier、干净环境 CI，以及适用时的真实外部运行共同提供分层 proof；每项证据只证明它实际测量的边界，benchmark 或单次绿灯不能替代架构审查。
3. **Explicit state transitions**：工作、PR、decision、guardrail 与 release 使用显式状态和转换条件。自动化可以请求转换，但不能用自然语言的“完成”“ship it”绕过前置检查、授权、失败状态或回滚路径。
4. **Aggressive entropy detection, conservative destruction**：主动发现已完成临时工作、过期 guardrail、重复测试、无消费者兼容层、陈旧分支和失效抽象。缓存、生成物和有明确期限的临时产物可按契约自动清理；源码、历史证据、公开接口、issue 和 PR 只能先形成可审查候选，再依据 owner、proof 与授权处理。
5. **One fact, one owner**：每类状态只有一个权威写入者，其他组件只能观察、缓存或引用。GitHub 拥有 PR/CI 状态，Contract 拥有 desired state，observer 拥有当前观测，verifier/receipt 拥有验证事实；NMG 只提供记忆与通知价值，不竞争这些事实源。

治理目标是减少下一位 Agent 的重新发现成本，同时阻止自动化把一次局部便利固化为永久架构。只把可机械验证的边界写成测试；语义合理性、删除授权和架构取舍继续由 owner 与 review 判断。

## 测试分类

| 类型 | 保护对象 | CI | 生命周期 |
| --- | --- | --- | --- |
| Safety | 数据损坏、资源泄漏、不安全删除、安全回归 | 阻塞 | 长期 |
| Contract | 公共 API、协议、包、持久化、支持的集成 | 阻塞 | 长期 |
| Guardrail | 已知回归修复期间的临时边界 | 阻塞 | 临时，必须退出或晋升 |
| Characterization / research | 当前行为、假设、benchmark adapter | 非阻塞 | 随研究更新 |

临时 guardrail 放在 `tests/guardrails/<id>/`，并提供 `guardrail.yaml`：

```yaml
id: daemon-startup-race
status: active
reason: Prevent duplicate daemons while lifecycle ownership is being redesigned.
review_after: 2026-10-01
exit_criteria: Replace with a stable contract test or remove after the redesign ships.
```

`agent:context:check` 会拒绝缺少 `reason`、`review_after` 或 `exit_criteria` 的 active guardrail。满足退出条件后必须删除，或明确晋升为长期 Safety/Contract 测试。

测试资源按断言边界选择，与上述阻塞分类正交：只断言路由测试失败的 narrow verifier fixture 可声明不适用共享检查，同时保留真实 CLI、Git 和路由测试；默认 narrow 的代表测试仍验证共享检查执行（[决策](../decisions/implemented/2026-09-23-route-only-verifier-fixtures.md)）。

## 执行轨道

为检查选择产品、研究或故障注入轨道时，读[执行轨道](ci-cd-and-quality/verification-tracks.zh-CN.md)。轨道决定阻塞地位；结果只覆盖实际执行的检查，不替代架构审查。

## CI 契约

`.github/workflows/ci.yml` 使用以下 job。各 job 不复制底层命令清单，而是调用
`verify:static`、`verify:product-ci`、`verify:research`、`verify:node-compat` 和
`verify:chaos` 这些命名 package contract，使本地可复现入口和远程 CI 保持同源：

- `static`：build、package、type、lint、format、文档、术语索引、需求追溯、Agent context 与生产依赖审计；
- `static` 通过 `verify:static` 阻塞执行 `check:tests`，不重复运行 advisory 类型检查步骤。ESLint 在开发面上的两条活性规则仍是 `warn`，与 TypeScript 的类型及 unused 检查分别执行（决策：[静态覆盖面](../decisions/implemented/2026-09-16-ci-static-coverage.md)）；
- `tests`：Node 24 产品测试和覆盖率；
- `research-tests`：研究/benchmark adapter 表征，**非阻塞但可见**：它不进入 `all-checks-passed`，因此失败不阻塞合并；但它未设置 `continue-on-error`，所以失败会以红色 check 出现在 PR 上，而不是永远显示绿色（决策：`docs/decisions/implemented/2026-09-12-visible-non-blocking-research-track.md`）。
- `node-compat`：最低支持版本 Node 22.19 的 build/package；
- `chaos`：Windows 上的资源与 daemon 故障注入，仅在推送到 `main` 时运行（该决策的历史样本为 145 次 CI 运行、1 次失败且在 `main` 上；见[决策](../decisions/implemented/2026-09-09-chaos-tests-on-main-pushes.md)）；
- `all-checks-passed`：只聚合阻塞轨道。
- `static` 内的 `ci:uncovered-tests`：从各 job 实际调用的 glob 推导出**没有任何 job 覆盖的测试文件**，`evals/` 下（研究 harness，按需运行）可留为 acknowledged，其余一律失败关闭并指名文件。
- `.github/workflows/on-demand-suites.yml`（仅 `workflow_dispatch`）：在 Linux 与 Windows 上以 `--test-concurrency=1` 跑上述未覆盖套件，并把 TAP 逐字记录作为 artifact 上传；不是必需检查。

CI 或打包规则变更除本地目标测试外，应在 clean checkout（或等价干净 worktree）运行其完整命令，防止未跟踪文件让本地验证产生假阳性。

## 可组合测试运行时

Cordis 本身只出现在 `tests/support/cordis-adapter.ts`。该文件只导出
`createTestRuntime()`，返回可组合 effect 与幂等 `dispose()` 的最小生命周期对象；它不导入 NMG
Core、CLI 或 daemon。需要文件系统、SQLite 和 daemon 的集成测试再由
`tests/support/test-runtime.ts` 组合 NMG 专用资源：

```text
TestRuntime
├── testWorkspace
├── testDatabase
└── testDaemon
```

测试通过 `withTestRuntime(...)` 或显式 `dispose()` 获取 RAII 式回收。插件依赖必须显式：database 要求 workspace，daemon 要求 database；缺少依赖时失败，不偷偷创建隐含全局状态。daemon 在进程内使用真实 HTTP JSON-RPC handler，因此能验证协议，同时不会遗留后台进程。

测试资源按断言需观察的边界分为四类，按需取得最轻且隔离的资源（[决策](../decisions/implemented/2026-09-24-resource-matched-test-fixtures.md)）：

| 断言边界 | 测试资源 | 可省的准备工作 |
| --- | --- | --- |
| 纯数据或决策 | 进程内输入 | 工作区、数据库和外部进程 |
| 单个 SQLite 连接的读写 | 每项独立的 `:memory:` store | 临时数据库文件及其清理 |
| 重开、旧库迁移、WAL、独立连接或路径 | 每项唯一的文件数据库或工作区 | 与断言无关的额外文件和服务 |
| CLI、Git、HTTP、daemon lease 或跨进程共享 | 断言这些边界时使用实际进程、端口及所需工作区 | 不参与断言的重复启动和检查 |

观察文件或跨进程语义的测试保留真实边界；只断言控制平面策略、receipt 或 harness 编排时，可以注入固定的 `RepositoryProvider` 观察值，另由真实 Git 集成测试覆盖发现、dirty 范围、提交和 forge 绑定。集成 `testDatabase()` 使用真实文件路径供 daemon 共享。真实 Git fixture 保留 `init/add/commit`，提交身份只传给 `commit`，避免每项再启动两次 `git config`。资源类别只决定 fixture 和可安全减少的准备工作，不改变 Safety/Contract/Guardrail 分类、阻塞地位或 narrow/full 验证范围；后两者由既有 route 与验证契约决定。

该层精确锁定 `@deepseek-ai/cordis@4.0.1` 作为 **devDependency**，只借用插件 effect/fiber 生命周期。NMG Core、daemon、Pi adapter 和发布包均不依赖 Cordis；不引入其 loader、HMR 或配置系统。Cordis adapter 与 NMG fixture composition 分离，未来若替换框架只需修改生命周期 adapter。

## Agent 原生仓库上下文

不确定 owner 或验证要求时，用 [Agent 仓库上下文](ci-cd-and-quality/repository-context.zh-CN.md)定位当前任务。它区分声明、观测和验证证据；返回的 owner 是查找入口，不是全篇必读清单。

## AI 开发验证流水线

修改完成后直接运行：

```powershell
npm run agent:verify
```

零参数入口从 Git 脏路径推导 scope 并选择 route；Git 不可用时失败关闭，不允许空跑后报成功。
共享工作树使用本任务的位置路径，或兼容形式 `--scope <target-path>`；只有确实要纳入全部脏改动
时才追加 `--changed`。

默认 narrow 与升级条件由 [gate 规则](ci-cd-and-quality/repository-control-plane/lightweight-verification.zh-CN.md)
拥有。Full 计划聚合命中 route，按首次出现顺序去重，并运行全部 blocking 命令。
`ci-and-tests` 把 `verify:static` 展开为 CI contract 的同一组原子检查；跨 route 共享检查只执行
一次，保留各自状态与 route 归因。CI 仍调用命名的 `verify:static` contract。

非 RCP full 计划越过 build/package 写入屏障后，有界并发执行独立静态检查，再运行产品测试；
结果按计划顺序展示，RCP 和 narrow 仍串行。命令失败、启动异常或信号终止都归因到该命令，
不阻止继续收集后续证据，最终整轮失败。

官方入口整轮默认预算为 150 秒，可用 `--timeout-ms` 调整；外层看门进程超时后返回失败与
`incomplete` 证据。普通执行和 RCP full/narrow 共用从执行器入口计算的剩余预算，每个子命令
只获得剩余时间。预算耗尽后不启动后续检查，逐项记为失败，不能报告整轮通过。需缩短或重新
划分检查后重跑；早先通过的局部检查不是整轮成功。

advisory 命令默认只显示、不执行；显式传入 `--include-advisory` 后才运行，且其失败不改变 blocking 结果。`--dry-run` 只生成计划，`--json` 提供机器可读报告，`--require-clean` 为打包/CI 等任务增加干净工作树门槛。每次成功形成报告后会自动覆盖 `.nmg/verification/latest.json`；该文件包含 run ID、起止时间、运行时、Git HEAD、scope、route 和逐命令结果，位于已忽略的 `.nmg/` 下，不形成无限增长的日志历史。

该流水线的自动化边界是机械路由、声明/观测协调、执行、失败归因和最近证据覆盖。它不负责判断架构是否合理，不自动格式化、修改代码、提交 Git，也不自动调用 LLM、embedding、benchmark 或官方数据集。真实外部评估仍须用户或 Agent 明确选择。GitHub CI 在 push/PR 自动执行命名验证契约；不安装强制本地 Git hook，避免修改未完成时制造隐式副作用。

## Repository Control Plane

修改 Contract、planner、执行或收据生命周期时，进入 [Repository Control Plane](ci-cd-and-quality/repository-control-plane.zh-CN.md)。该页路由到完整子合同；不要从 Agent 完成声明推断独立验证、授权或合并状态。

## 修改验证

普通产品改动的 gate 由 [gate 选择规则](ci-cd-and-quality/repository-control-plane/lightweight-verification.zh-CN.md)决定：narrow 运行共享不变量加属主路由测试，
其余使用适用的完整 blocking 集。完整产品 gate 包含目标测试、`npm run check`、
`npm run test:product` 与 `npm run build`，不是要求每次纯文档 full 计划都运行这些命令。文档按 [文档 CI 契约](../README.zh-CN.md#ci-契约)
运行 `npm run docs:check`。仓库工具还运行 `npm run agent:context:check`；包边界运行
`npm run package:check`。

提交只包含本任务拥有的文件。工作区有用户或其他 Agent 修改时必须保留，不能为获得“干净”结果回滚它们。
