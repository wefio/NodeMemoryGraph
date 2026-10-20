# Repository Control Plane

[English](repository-control-plane.md) · [使用的术语](repository-control-plane.terms.yaml)

**Authority:** [代码质量与 CI/CD](../ci-cd-and-quality.zh-CN.md)。

## Repository Control Plane

审查权限、状态归属或 provider 边界时，使用本架构参考。范围包括运行至终态的核心，以及
延后扩展的准入条件。`src/rcp/`、`nmg-rcp`、编译、观察、WorkOrder、独立 npm 验证、本地收据、
forge adapter 与可选 NMG 接入构成该核心；不因此具备常驻 watcher/queue/catalog、多租户或
可移植 attestation。理由与替代方案由
[RCP 决策](../../decisions/implemented/2026-08-29-repository-control-plane.zh-CN.md)拥有。
实现状态与历史执行证据归[完成审计](../completion-audit.md)，本参考不表示重新运行了真实 harness 或远程 CI。

### 按动作选择子合同

| 要完成的事 | 必需参考 |
| --- | --- |
| 编写或审查 Contract 及其证据主张 | [Contract 声明面与 IR](repository-control-plane/contract-surface-and-ir.zh-CN.md) |
| 解释收据及其信任边界 | [Verifier 与收据](repository-control-plane/verifier-and-receipts.zh-CN.md) |
| 规划、应用、恢复或绑定 PR/CI | [运行至终态的 CLI](repository-control-plane/run-to-completion-cli.zh-CN.md) |
| 安装已审阅规则并验证固定候选 | [可信基线](repository-control-plane/trusted-baseline-verification.zh-CN.md) |
| 判断 narrow/full 检查面 | [Gate 选择](repository-control-plane/lightweight-verification.zh-CN.md) |

按当前动作读取对应子合同；本页不替代其中的前提与失败规则。

### 产品边界与依赖方向

RCP 位于 NMG daemon 外部，把仓库声明目标转成有界 Agent 工作，并比较期望状态、观测和收据：

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

逻辑外部允许它作为同仓库模块化 CLI 存在，不要求另建仓库或常驻服务。
`NMG_MODE=disabled` 或 NMG 不可用时，核心仍须能编译、规划、观察、验证并生成收据。
NMG 可提供可迁移经验、历史回忆和 Task Board 通知；NMG daemon 不解析 Contract、
启动 Agent、判断 CI、拥有 PR 或回写控制面状态。

### 每类真相只保留一个 owner

| 真相域 | 权威来源 | 非权威视图 |
| --- | --- | --- |
| 期望仓库状态 | Git 中经版本控制的 Contract | catalog、编译缓存、NMG 记忆 |
| 当前仓库状态 | 指定 commit/worktree 的 Observer 输出 | Agent 描述与 PR 文本 |
| 验证事实 | 可信执行者观测；本地收据绑定 Contract digest、observed content revision、verifier identity，clean/forge 场景另绑定 commit | 自报日志、Task Board result、未认证收据 |
| PR/合并状态 | Git forge | 本地缓存与 NMG |
| Agent 工作记忆与经验 | Harness 与 NMG 的 AG/STG/LTG 边界 | 收据摘要 |

Contract 声明期望状态，Observer 产生观测状态，收据记录执行者声称的输入、检查及结果。
只有信任执行者和记录来源，收据才能支持该次执行；自哈希不证明执行发生。
覆盖另一个真相域不是收敛。

Observer 按 Contract include 保守剪枝：仅跳过可证明没有后代文件能匹配任一 include 的目录。
首段含通配符时保守禁用剪枝，不代表模式实际匹配所有目录。逐文件 allow/exclude 语义不变，
读取内容和哈希前已经过滤文件。剪枝减少无关目录枚举与后代 metadata 调用，不是消除原本
不存在的全树内容哈希。历史约 67GB 的目录体积不是实际读取字节或加速比证据。

`observedBytes` 累计成功读取的普通文件 stat 大小；超过默认 256MiB 时，在观察完成后附加
非阻塞诊断，不是扫描前估计或大小硬门禁。文本 plan 显示完成后的文件数、字节数及诊断，
JSON plan 保留 observation 字段；两者均不是读取前预警。Agent 默认不扫描超大目录的规则由
`skills/repo-development/references/control-plane.md` 拥有；运行时仍须完整观察 scope 内文件，
不能静默跳过。尊重 `.gitignore` 是独立的摘要语义决策，不属于剪枝。

### 不信任动作完成声明的协调

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

协调必须幂等、可恢复。复用身份绑定 Contract、observed revision、operation key、route/check
声明和 verifier definition。执行后重新观察，工具返回不等于收敛。Harness 前持久化 in-flight
attempt，收据成功保存后才清除；两者之间中断时普通重试失败关闭，显式恢复只验证已有
workspace，不重放 mutation。

默认只生成 plan。写文件、推送、开 PR、合并、删除或修改权限都需要 Contract 授权及对应
provider；破坏性 drift 不自动修复。Run-to-completion change 在设计/实现 PR 验证后进入终态；
continuous Contract 只在显式启用 watcher 后持续监测架构 fitness、文档/协议或生成物漂移。
权限名称不表示 watcher 已安装。

### WorkOrder、Agent 与 PR

Planner 从 IR 和观测生成有界 `WorkOrder`，至少包含 Contract ID/digest、允许路径、owner、
检查、保留行为、断言和预算。单次 attempt/timeout 预算传给 harness；process harness 只能采用相同或
更严格的时限。Pi、Codex、DSH 中至少两个 harness 使用同一 WorkOrder 合同。
Agent 提交 patch/PR 和证据，不能自行推进 `verified`；越界时返回 `scope_violation` 或请求
Contract amendment。

`expectedArtifacts` 与 `HarnessResult.artifacts` 不是受支持的产物检查：无人消费的字符串数组
也不进入收据。以后若需要逐 Contract 检查产物存在，须显式声明路径/glob，不能恢复无人读的数组。

Draft PR 是变更的持久在途实例与审阅入口。Task Board 只负责短期发现、认领、阻塞与通知，
指向 WorkOrder/PR，不拥有其记录。设计 PR 合并只代表接受 proposal，不把尚未实现的验收项
改成完成。完成审计只依据实现和验证证据推进，不依据计划或 PR 文本。

### 通过 provider 边界扩展

窄接口阻止插件直接写核心状态：

- `RepositoryProvider`：Git/worktree/forge 观察与已授权 mutation。
- `HarnessProvider`：向 harness 投递 WorkOrder 并收集结果。
- `VerifierProvider`：具名检查、超时、证据和可信身份。
- `PolicyProvider`：对 IR、plan、receipt 的纯决策。
- `ReceiptSink`：本地文件、CI artifact 或远程可审计存储。
- `MemoryProvider`：可选 NMG recall/board/experience，失败时可降级。

Provider 注册 capability，由 Contract 请求和 policy 选择，不能静默扩大权限。
RCP 与 NMG memory 协议独立，可共用 transport、schema hashing、diagnostics 与能力协商库。
普通协调拒绝自报完成及已检测到的 scope/check 失败，但不隔离候选 npm、测试或规则；
独立审批边界见可信基线子合同。

### 保持扩展的前提条件

交付顺序为：compiler/schema/IR/digest/fixtures 与只读 plan；复用 `agent:context` 路由的
Observer/reconciler 与 WorkOrder；复用 `agent:verify` 原语的独立验证与收据；带重观察、重试
和幂等的 Draft PR/forge 状态；最后是多 harness、可选 NMG 与断连行为。每阶段都须有行为测试、
失败关闭路径和可删除的兼容边。

本地收据绑定 commit/scope/Contract/verifier，但不作为远程 artifact 发布。操作者可将 Draft PR、
required CI check 与本地收据绑定到同一 commit 和 digest；外部审阅者能复核 Git/PR/CI，不能取得
被忽略的本地文件。NMG 增加记忆/协调价值，不成为闭环依赖。

常驻 watcher、queue、backoff、catalog、多租户需要真实 continuous Contract；外部
artifact/attestation provider 需要跨机器独立复核需求。不提前搭建 service catalog、通用 DSL、
分布式队列或控制面数据库。是否独立产品/仓库由 provider 数量、独立发布与运行隔离证据决定，
不是由概念大小决定。收据校验、复用绑定、provenance、扫描、harness 超时与恢复有产品测试，
不因此证明持续控制器或第三方证明成立。

### 只观察 CI，不授予权限

规范 `CI` workflow 完成后，`.github/workflows/ci-status.yml` 启动只读 GitHub-hosted worker，
读取 jobs/失败步骤，输出紧凑 Step Summary，并上传标记为 `observation-only` 的
`nmg.ci-status.v1` JSON artifact。它不授权合并、生成本地收据或替代 required checks。

Worker 不评论、写 label、运行仓库测试或连接本地 NMG daemon，只持有 `actions: read` 和
`contents: read`。消费者协调前仍须通过 Forge provider 重读 GitHub 当前状态；workflow-run
payload 与 artifact 可能过期，不是另一事实源。将来可用外部轮询/webhook bridge 唤醒本地工作，
但不改变只读合同。

### 设计背景

以下是背景，不是首版必需依赖：[OpenGitOps](https://opengitops.dev/) 的声明式、版本化和协调状态；
[Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/) 的 spec/status 与幂等；
[Backstage](https://backstage.io/docs/features/software-catalog/) 的仓库事实源；
[Crossplane](https://docs.crossplane.io/latest/whats-crossplane/) 的 provider/composition；
[CUE](https://cuelang.org/docs/tour/basics/constraints/) 的约束合一；
[OPA](https://www.openpolicyagent.org/docs/philosophy) 的 policy/decision 分离；
[GitHub Spec Kit](https://github.github.com/spec-kit/) 的 spec-to-task 追踪；以及
[SLSA provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md) 的输入、builder、
invocation 和 artifact 身份。
