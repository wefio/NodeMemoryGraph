# 代码质量与 CI/CD

**Created:** 2026-07-20  
**Updated:** 2026-08-29
**Authority:** 仓库测试、CI 与 Agent 开发流程契约

NMG 的测试负责阻止可复现错误，不负责冻结尚未验证的设计。产品契约、研究测量与故障注入使用不同执行轨道，避免 benchmark 便利逻辑反向定义产品行为。

## 1. 测试分类

| 类型                        | 保护对象                                 | CI     | 生命周期             |
| --------------------------- | ---------------------------------------- | ------ | -------------------- |
| Safety                      | 数据损坏、资源泄漏、不安全删除、安全回归 | 阻塞   | 长期                 |
| Contract                    | 公共 API、协议、包、持久化、支持的集成   | 阻塞   | 长期                 |
| Guardrail                   | 已知回归修复期间的临时边界               | 阻塞   | 临时，必须退出或晋升 |
| Characterization / research | 当前行为、假设、benchmark adapter        | 非阻塞 | 随研究更新           |

临时 guardrail 放在 `tests/guardrails/<id>/`，并提供 `guardrail.yaml`：

```yaml
id: daemon-startup-race
status: active
reason: Prevent duplicate daemons while lifecycle ownership is being redesigned.
review_after: 2026-10-01
exit_criteria: Replace with a stable contract test or remove after the redesign ships.
```

`agent:context:check` 会拒绝缺少 `reason`、`review_after` 或 `exit_criteria` 的 active guardrail。满足退出条件后必须删除，或明确晋升为长期 Safety/Contract 测试。

## 2. 执行轨道

| 命令                    | 内容                                                 | 用途             |
| ----------------------- | ---------------------------------------------------- | ---------------- |
| `npm run test:product`  | core、CLI、adapter、docs、Skill、工具与 test support | 产品正确性       |
| `npm run test:coverage` | 与 product 相同的集合并生成覆盖率                    | 阻塞 CI          |
| `npm run test:research` | `tests/benchmarks`、`tests/evals`、`tests/official`  | 非阻塞研究表征   |
| `npm run test:chaos`    | Windows 故障注入与进程/文件锁生命周期                | 独立阻塞轨道     |
| `npm test`              | 所有 `tests/**/*.test.ts`                            | 本地完整兼容入口 |
| `npm run verify:static` | build/package/type/lint/format/docs/context           | 本地与 CI 共用   |
| `npm run verify:product-ci` | build + product coverage                         | 本地与 CI 共用   |

`eval:*`、`benchmark:*`、真实 LLM/embedding 与官方大数据集运行不进入 keyless CI。研究测试可以验证 adapter 和计分契约，但不得访问外部密钥或把实验常量提升为产品默认值。

覆盖率轨将测试并发限制为 2，避免 c8 插桩与跨进程/SQLite 测试叠加时制造内存峰值和 Windows 文件锁假失败；普通 product 轨仍使用并发 4。

## 3. CI 契约

`.github/workflows/ci.yml` 使用以下 job。各 job 不复制底层命令清单，而是调用
`verify:static`、`verify:product-ci`、`verify:research`、`verify:node-compat` 和
`verify:chaos` 这些命名 package contract，使本地可复现入口和远程 CI 保持同源：

- `static`：build、package、type、lint、format、文档、Agent context 与生产依赖审计；
- `tests`：Node 24 产品测试和覆盖率；
- `research-tests`：研究/benchmark adapter 表征，`continue-on-error`；
- `node-compat`：最低支持版本 Node 22.19 的 build/package；
- `chaos`：Windows 上的资源与 daemon 故障注入；
- `all-checks-passed`：只聚合阻塞轨道。

CI 或打包规则变更除本地目标测试外，应在 clean checkout（或等价干净 worktree）运行其完整命令，防止未跟踪文件让本地验证产生假阳性。

## 4. 可组合测试运行时

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

该层精确锁定 `@deepseek-ai/cordis@4.0.1` 作为 **devDependency**，只借用插件 effect/fiber 生命周期。NMG Core、daemon、Pi adapter 和发布包均不依赖 Cordis；不引入其 loader、HMR 或配置系统。Cordis adapter 与 NMG fixture composition 分离，未来若替换框架只需修改生命周期 adapter。

## 5. Agent 原生仓库上下文

根 `AGENTS.md` 只保存稳定启动协议。Agent 修改仓库前运行：

```powershell
npm run agent:context -- --scope <目标路径>
```

`tools/repo-context.ts` 从 Git、`package.json`、`agent-context.yaml`、owner 文档和临时 guardrail manifest 生成当前任务视图。它是只读开发工具，不访问 NMG 数据库，不启动 daemon，也不调用 LLM 或 embedding。`--changed` 可以把当前工作树的全部改动作为 scope；共享脏工作树中应优先传入本任务拥有的精确 `--scope`，避免把其他 Agent 的改动误纳入计划。

`skills/repo-development/SKILL.md` 定义修改、测试和提交工作流；`agent-context.yaml` 只维护无法可靠自动推导的模块所有权与验证分类。每条 route 显式区分 `blocking` 与 `advisory`，且命令必须精确对应 `package.json` script；不允许用含义过宽的 `test` 代替 `test:product`、`test:research` 或 `test:chaos`。实现状态继续由源码、`completion-audit.md` 和 `temporary-todo.md` 分别拥有，避免第二事实源。

### 5.1 声明状态协调

`agent:context` 同时生成一个只读 reconciliation 视图，把仓库的事实源与自动化收据分开：

- **desired revision** 是命中 route、验证分类及其 package script 的稳定指纹；
- **observed revision** 绑定所选 scope 和该 scope 的当前内容；Git HEAD 另行记录用于溯源，但不让一次只改变提交元数据的操作使同一内容失去验证；
- **verification evidence** 仍由 `.nmg/verification/latest.json` 提供，必须与前两者一致，并覆盖所有 blocking check。

协调状态只有三种：`unknown` 表示尚无可适用证据或旧证据不含状态指纹；`converged` 表示同一声明、同一观测快照的 blocking checks 全部通过；`drifted` 表示 route 无法机械解析、声明或内容在验证后改变、证据损坏，或 blocking check 未通过/未执行。改变同一个脏文件的内容也会改变 observed revision，不能仅凭相同 HEAD 和文件名复用旧收据。

这是由 `agent:context`、`agent:verify` 和 CI 事件驱动的轻量协调，不是后台 daemon，也不建立服务 catalog 或第二套仓库状态。`drifted` 只说明声明、观测和证据没有收敛，不等于架构错误；依赖方向、公共协议、持久化边界和默认能力等架构影响仍由 owner 文档、decision 与 Agent review 判断。静态测试可以机械保护已确定的 architecture fitness functions，但控制面不承载产品或架构智能。

## 6. AI 开发验证流水线

修改完成后直接运行：

```powershell
npm run agent:verify
```

零参数入口自动读取 Git 变更并选择 route；Git 不可用时失败关闭，不允许空跑后误报成功。共享脏工作树使用 `--scope <本任务路径>` 精确覆盖自动范围。执行器聚合所有命中 route，按首次出现顺序去重，并运行全部 blocking 命令；一个命令退出失败、启动异常、超时或被信号终止，都被归因到该命令且不会阻止后续检查收集证据，最终统一返回失败。默认单命令上限为 30 分钟，可用 `--timeout-ms` 调整。

advisory 命令默认只显示、不执行；显式传入 `--include-advisory` 后才运行，且其失败不改变 blocking 结果。`--dry-run` 只生成计划，`--json` 提供机器可读报告，`--require-clean` 为打包/CI 等任务增加干净工作树门槛。每次成功形成报告后会自动覆盖 `.nmg/verification/latest.json`；该文件包含 run ID、起止时间、运行时、Git HEAD、scope、route 和逐命令结果，位于已忽略的 `.nmg/` 下，不形成无限增长的日志历史。

该流水线的自动化边界是机械路由、声明/观测协调、执行、失败归因和最近证据覆盖。它不负责判断架构是否合理，不自动格式化、修改代码、提交 Git，也不自动调用 LLM、embedding、benchmark 或官方数据集。真实外部评估仍须用户或 Agent 明确选择。GitHub CI 在 push/PR 自动执行命名验证契约；不安装强制本地 Git hook，避免修改未完成时制造隐式副作用。

## 7. Repository Control Plane designed target

本节是**已设计、未实现**的目标边界。当前 `agent:context`、`agent:verify`、Task
Board、GitHub PR 和 CI 是可复用原语，不等于完整控制面已经存在。规划 rationale
和替代方案见 proposed
[Repository Control Plane decision](../decisions/proposed/2026-08-29-repository-control-plane.zh-CN.md)。

### 7.1 产品边界与依赖方向

Repository Control Plane（RCP）位于 NMG daemon 外部，负责把仓库中的声明式目标
转成受约束的 Agent 工作，并持续比较目标、仓库观测和验证收据：

```text
Git contract + repository observation
                  |
                  v
       Repository Control Plane
       | compiler / policy / planner
       | scheduler / reconciler / verifier
       | receipt index / forge adapter
       +--------------------+
       |                    |
       v                    v
Agent harnesses          Git / PR / CI
(Pi/Codex/DSH)                |
       |                      |
       +----------+-----------+
                  |
                  v
          code and evidence

Optional only:
Repository Control Plane -> NMG client -> NMG daemon
```

RCP 可以先作为同仓库中的模块化 CLI 存在，逻辑外部不要求立即拆成新仓库或常驻服务。
其核心必须在 `NMG_MODE=disabled` 或 NMG 不可用时仍能编译 contract、规划、观察、
验证和生成 receipt。NMG 只可提供可迁移经验、历史回忆和 Task Board 通知；NMG
daemon 不解析 contract、不启动 Agent、不判断 CI、不拥有 PR，也不回写控制面状态。

### 7.2 真相域

每类状态只有一个权威所有者，派生缓存不得竞争：

| 真相域 | 权威来源 | 非权威视图 |
| --- | --- | --- |
| 期望仓库状态 | Git 中经版本控制的 Contract | catalog、编译缓存、NMG 记忆 |
| 当前仓库状态 | 指定 commit/worktree 的 Repository Observer 输出 | Agent 描述、PR 文本 |
| 验证事实 | 绑定 contract digest、commit 和 verifier identity 的 immutable receipt | 日志摘要、Task Board result |
| PR/合并状态 | Git forge | 本地缓存、NMG |
| Agent 工作记忆与经验 | 各 harness 与 NMG 的 AG/STG/LTG 边界 | RCP receipt 摘要 |

Contract 描述 desired state；Observer 产生 observed state；Receipt 只证明某次输入上
执行了什么及结果如何。任何一者都不能通过覆盖另外两者来“收敛”。

### 7.3 Contract surface 与 IR

第一版使用容易编辑的 YAML/JSON 声明面，并编译为稳定、Agent-neutral 的 Contract
IR；暂不引入完整 CUE/OPA 运行时。借用 CUE 的约束语义和 OPA 的纯策略边界，而不是
复制它们的产品范围。

最小 Contract 必须包含：

```yaml
apiVersion: repository.nmg.dev/v1alpha1
kind: AgentChange
metadata:
  id: rcp-001                    # 被引用后保持稳定
spec:
  intent: "what should be true"
  scope:
    include: ["src/**"]
    exclude: ["docs/experiments/**"]
  preserve: ["public protocol compatibility"]
  invariants: ["NMG daemon must not depend on RCP"]
  verification:
    routes: ["product"]
    checks: ["npm run agent:verify"]
  authority:
    mode: plan                  # plan | apply | continuous
  extensions: {}
```

编译后的 IR 规范化默认值、路径、source locations、diagnostics、extension namespace
和 `contractDigest`。语法升级不得改变稳定 `metadata.id`；未知必需字段失败关闭，未知
可选 extension 可被保留但不能静默执行。Contract 写目标和约束，不写逐条 shell
操作；具体动作由可替换 planner/provider 产生。

### 7.4 控制循环

```text
Contract -> compile/validate -> DesiredState
                                |
Repository -> observe ---------+-> diff -> policy -> route/plan
                                                    |
                                                    v
                                             bounded Agent run
                                                    |
                                                    v
                                              code / Draft PR
                                                    |
                                                    v
                                             independent verify
                                                    |
                                                    v
                                                Receipt
                                                    |
                                                    `-> reconcile again
```

Reconciler 必须幂等、可恢复且不相信“动作已经成功”。它以
`contractDigest + observedRevision + operationKey` 去重；执行后重新观察，而不是依据
工具返回值直接宣告收敛。默认只生成 plan；写文件、推送、开 PR、合并、删除或权限变化
均需 contract 授权和对应 provider。破坏性 drift 不自动修复。

RCP 区分两类资源：

- **run-to-completion change**：一次设计/实现 PR，验证后进入 terminal condition；
- **continuous contract**：持续监测 architecture fitness、文档/协议契约或生成物漂移，
  只在明确启用 watcher 时周期协调。

### 7.5 Work Order、Agent 与 PR

Route Planner 将 IR 与 observed state 转成 bounded `WorkOrder`，至少包含 contract ID/
digest、允许路径、owner 文档、所需检查、保留项、禁止项、预算与预期产物。Agent 只能
提交 patch/PR 和证据，不能自行把 contract 标成 verified；超出 scope 时返回
`scope_violation` 或提出 contract amendment。

Draft PR 是一次变更的持久在途实例和可审阅入口。Task Board 只负责短期发现、认领、
阻塞与通知，并用稳定 ID 指向 WorkOrder/PR；它不是 WorkOrder 的 system of record。
设计 PR 合并只表示 proposal 被接受，不能把未实现的 acceptance criteria 改成完成。

### 7.6 Verifier 与 receipt

Verifier 在 Agent 变更之后独立运行，检查至少分为结构、行为、边界、来源四类。Receipt
是 append-only 事实，不是操作日志，也不是自然语言完成声明。最小字段为：

```json
{
  "receiptSchema": "repository.receipt/v1alpha1",
  "contractId": "rcp-001",
  "contractDigest": "sha256:...",
  "observedRevision": "sha256:...",
  "commit": "git-sha",
  "invocationId": "...",
  "verifier": { "id": "verify:product-ci", "digest": "sha256:..." },
  "scope": { "declared": ["src/**"], "actual": ["src/**"], "matched": true },
  "checks": [{ "name": "...", "status": "passed", "evidence": "..." }],
  "decision": "verified"
}
```

Receipt store 可有索引数据库，但规范 receipt 必须绑定 immutable input/output identity。
GitHub required checks 只接受受信 verifier 的结果；PR 描述和评论用于解释，不作为唯一
机器状态。一次 receipt 可被 NMG 作为来源引用，但不会自动成为 LTG；只有经归因、可复用
且由独立 `remember` 接入的经验才进入记忆。

### 7.7 扩展边界

控制面通过窄接口扩展，而不是让插件直接写核心状态：

- `RepositoryProvider`：Git/worktree/forge observe 与受权 mutation；
- `HarnessProvider`：Pi、Codex、DSH 的 WorkOrder 投递和结果收集；
- `VerifierProvider`：命名检查、超时、证据和可信身份；
- `PolicyProvider`：对 IR/plan/receipt 的纯决策；
- `ReceiptSink`：本地文件、CI artifact 或远程可审计存储；
- `MemoryProvider`：可选 NMG recall/board/experience，故障时可降级。

Provider 通过 capability declaration 注册；核心根据 Contract 请求和 policy 选择，禁止
provider 隐式扩大权限。RCP 协议与 NMG memory protocol 独立，但可以共享 transport、
schema hashing、diagnostics 和 capability-negotiation 库。

### 7.8 分阶段交付

1. **Contract compiler MVP**：schema、IR、digest、diagnostics、fixtures；只读 plan。
2. **Observer + reconciler CLI**：复用 `agent:context` 路由，生成 Desired/Observed diff 和
   WorkOrder；一次运行后退出。
3. **Independent verifier + receipt**：复用 `agent:verify`，receipt 绑定 commit、scope、
   contract 与 verifier；CI 可验证 receipt。
4. **Draft PR closed loop**：forge adapter、状态 conditions、重观察、重试/幂等；Task Board
   只发布指针。
5. **Provider boundary**：支持多个 harness；NMG adapter 设为 optional 并验证无 NMG 降级。
6. **Continuous reconciliation**：只有真实持续契约需要后再加入 watcher、queue、backoff、
   catalog 和多租户能力。

每个阶段必须拥有行为测试、失败关闭路径和可删除的兼容边；不提前搭建服务 catalog、
通用 DSL、分布式队列或控制面数据库。是否拆成独立产品/仓库由 provider 数量、独立发布
需求和运行隔离证据决定，而不是概念规模决定。

### 7.9 完整闭环验收

只有以下条件同时成立，RCP 才能从 designed target 升为 implemented：

- 同一 Contract 在无 NMG 情况下可编译、plan、执行受限 Agent 工作、验证并生成 receipt；
- desired、observed、receipt 和 PR 状态分别可追踪且不存在竞争写入者；
- Agent 无法通过自报完成、改弱检查或越权路径使 verifier 判定收敛；
- 重复 reconcile 不重复执行同一 mutation，进程中断后可从仓库与 receipt 恢复；
- plan/apply/continuous 权限明确，破坏性动作默认不自动执行；
- Pi、Codex 或 DSH 至少两个 harness 通过同一 WorkOrder contract；
- NMG adapter 断开时闭环仍可工作，接入时只增加记忆/协调价值；
- Draft PR、CI required check 与 receipt 绑定同一 commit 和 contract digest；
- completion audit 只根据实现和验证证据升级，不根据本规划或 PR 文本升级。

### 7.10 理论来源

设计借鉴 [OpenGitOps principles](https://opengitops.dev/) 的 declarative/versioned/
reconciled state、[Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
的 spec/status 与幂等控制循环、[Backstage catalog](https://backstage.io/docs/features/software-catalog/)
的 repository-owned source of truth、[Crossplane](https://docs.crossplane.io/latest/whats-crossplane/)
的 provider/composition 边界、[CUE](https://cuelang.org/docs/tour/basics/constraints/)
的约束合一、[OPA](https://www.openpolicyagent.org/docs/philosophy) 的 policy/decision
分离、[GitHub Spec Kit](https://github.github.com/spec-kit/) 的 spec-to-task 追踪，以及
[SLSA provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md)
的输入、builder、invocation 和 artifact identity。它们是设计依据，不是首版依赖。

### 7.11 Run-to-completion CLI

候选实现提供独立的 `nmg-rcp` 入口；它不由 NMG daemon 托管。最小流程为：

```text
nmg-rcp compile .rcp/contracts/change.yaml
nmg-rcp plan .rcp/contracts/change.yaml
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready --nmg disabled
nmg-rcp forge-create .rcp/contracts/change.yaml --base main --head feature/change
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready \
  --pr 42 --operation-key pr-ci --nmg disabled
```

`reconcile` 默认只 plan；`--apply` 还必须显式选择当前 workspace 或外部 harness。
本地验证 receipt 与 PR/CI receipt 使用不同 `operation-key`，但都绑定同一 Contract
digest。带 `--pr` 的收敛还要求 PR body 中的机器标记、head commit 与成功 CI 状态一致。
失败 receipt 只追加、不覆盖，并允许在外部状态修复后重试；只有已验证 receipt 才用于
幂等复用。`.rcp/receipts/` 不参与仓库 observed revision，避免控制面输出改变自身输入。

当前只实现 run-to-completion 路径。`continuous` 是 Contract 可声明的权限上限，不表示
已经存在 watcher；在出现真实持续 contract 前，常驻 queue/catalog/watcher 仍明确延后。

## 8. 修改验证

普通产品改动至少运行目标测试、`npm run check`、`npm run test:product` 与 `npm run build`。文档按 [文档 CI 契约](../README.md#ci-contract)运行 `npm run docs:check`。仓库工具还运行 `npm run agent:context:check`；包边界运行 `npm run package:check`。

提交只包含本任务拥有的文件。工作区有用户或其他 Agent 修改时必须保留，不能为获得“干净”结果回滚它们。
