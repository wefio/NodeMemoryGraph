# 外部 Repository Control Plane

[English](2026-08-29-repository-control-plane.md)

**Status:** implemented  
**Date:** 2026-08-29

**实现状态：** 单次 run-to-completion 控制面已通过 PR #3 合并，随后完成证据与恢复边界加固。
Contract 编译、仓库观察、WorkOrder、独立验证、本地 append-only receipt、provider 边界、
Draft PR 绑定及 optional/no-NMG 路径已有确定性产品测试和真实 Contract-bound
PR/CI/本地 receipt 闭环。持续协调与可供第三方独立复核的 portable attestation 仍延后。

## 问题

仓库已有路由、文档所有权、验证命令、CI 和临时 Agent 协作，但它们仍是分散动作。
目前没有一份持久 contract 把期望状态、Agent work order、精确仓库版本、独立验证和
合并就绪状态连接起来。因此 Agent 可能局部合理地修改代码，却隐式改变架构、只完成
设计未完成实现，或在没有机器可验证 receipt 时宣告完成。

若把这些脚本直接变成 NMG daemon 的职责，会解决错的问题。仓库状态与合并权限不是
记忆；这样会让记忆服务控制 Git、CI、PR 和 Agent 执行，使开发闭环依赖 NMG 可用性，
并在 Git、receipt 与 LTG 之间制造竞争真相源。

## 决策

引入外部、Agent-neutral 的 Repository Control Plane（RCP）。它把版本化 Repository
Contract 编译成规范 IR，观察仓库，评估策略，产生受限 WorkOrder，把工作委托给 Agent
harness，独立验证结果并记录不可变 receipt。每次显式调用只执行一次有界协调尝试，
终态为 verified、failed 或 blocked；当前没有实现迭代收敛。

依赖方向严格单向：

```text
Repository Control Plane -> optional NMG client -> NMG daemon
```

NMG 可以提供回忆、可迁移经验和 Task Board 通知，但不解析 Contract、不拥有 PR 状态、
不调度 Agent、不判断 CI，也不协调仓库。NMG 被禁用或不可用时，RCP 核心闭环仍必须
工作。第一版可作为本仓库的模块化 CLI；逻辑分离不要求立即拆仓库或常驻服务。

控制面严格分开四个真相域：

1. Git 中的 Contract 拥有仓库期望状态；
2. Repository Observer 输出拥有指定 revision/worktree 的当前状态；
3. 不可变 receipt 拥有验证事实，并绑定 Contract digest、commit、scope、verifier
   identity、checks 与 evidence；
4. Git forge 拥有 PR 与 merge 状态。

首个 Contract surface 使用版本化 YAML/JSON，并编译成 Agent-neutral IR。它借鉴 CUE 的
约束合一和 OPA 的纯策略边界，但不要求安装两者。Contract 声明 intent、scope、
preservation、invariants、verification、authority mode 与 extensions，不规定 shell 步骤。
稳定 ID 在被引用后不变，content digest 标识精确版本。

协调闭环为：

```text
Contract -> compile -> desired state
Repository -> observe -> current state
desired + current -> policy -> route/plan -> bounded Agent WorkOrder
Agent -> patch/Draft PR -> independent verifier -> receipt
receipt + re-observation -> reconcile or terminate
```

Reconciler 必须幂等，并按 Contract digest、observed revision 与 operation identity 去重。
动作后重新观察，不能依据工具返回值直接相信成功。默认是 plan 模式；写仓库、push、
创建 PR、merge、删除和权限变化都需要 Contract 显式授权及对应 provider，破坏性 drift
不得隐式修复。

Draft PR 是一次变更的持久在途实例。Task Board 可指向 WorkOrder/PR，用于发现、认领、
阻塞与交接，但不是 work system of record。设计 PR 合并只表示接受 proposal，不表示
proposal 中的实现已经完成。

RCP 只通过窄 provider 扩展 repository/forge、harness、verifier、policy、receipt sink
和 optional memory。Provider 声明 capability，不能静默扩大权限。RCP 与 NMG 使用独立
应用协议，但可共享 transport、schema hashing、diagnostics 和 capability negotiation 库。

交付分成六个可独立验证的切片：

1. Contract schema、compiler、IR、digest、diagnostics 与 fixtures；
2. 只读 observer 与 run-to-completion planner/reconciler CLI；
3. 独立 verifier 和绑定 commit/Contract 的 receipt；
4. Draft PR/CI 接入、幂等重观察与 conditions；
5. 多 harness provider 与 optional/no-NMG parity；
6. 只有出现真实持续 contract 和独立发布需求后，才加入 watcher、queue、catalog 与拆分。

规范数据契约、生命周期、安全默认值、阶段计划和完整验收由
[ci-cd-and-quality.md §7](../../design/ci-cd-and-quality.md#7-repository-control-plane)
拥有。

## 考虑过的替代方案

1. **把控制面放进 NMG daemon。** 拒绝；仓库权限不是记忆，这会反转依赖，并让核心
   开发依赖一个可选记忆服务。
2. **保留独立脚本，只要求 Agent 遵守文档。** 简单，但不能协调 desired/current，
   也不能证明自报检查适用于同一 Contract 与 commit。
3. **立即拆成新产品/仓库。** 暂缓；逻辑模块和 provider 边界已经提供所需隔离，物理
   拆分应由独立发布、运行隔离或所有权证据驱动。
4. **立即引入 CUE、OPA、Backstage 或 Kubernetes 风格 API server。** MVP 拒绝；可借鉴
   语义，但完整运行时会在最小 contract 尚未验证前使本地闭环过重。
5. **把 Task Board 或 NMG LTG 当 work system of record。** 拒绝；TTL 协作和语义记忆
   不能替代版本化 desired state、仓库观测、forge 状态和不可变验证 receipt。

## 后果

- RCP 保持在 NMG daemon 外部，并可在 NMG 禁用时完成 run-to-completion 路径；记忆与
  Task Board 接入只提供可选增益。
- 已实现 CLI 把 Contract、scope 观测、WorkOrder、命名检查、forge 状态与一份
  append-only receipt 绑定起来；它不会自动执行 preservation 文本，也不自行证明语义等价。
- 默认 `FileReceiptSink` 写入被 Git 忽略的 `.rcp/receipts/`。这些 receipt 用于本地幂等和
  操作者审计，不是可移植的第三方 attestation，也不会由 `npm run agent:verify` 单独产生。
- GitHub CI 仍是仓库远程验证权威。只有出现独立外部证明需求时，才增加 artifact/
  attestation provider 发布 receipt 证据。
- 当前只实现单次 run-to-completion；watcher、queue、持续收敛、通用 catalog 与多租户仍需
  真实需求和独立安全设计。
- 可复用 receipt 会校验完整性，并绑定当前 route、checks 与 verifier definition。Apply 在
  缺少 Git provenance 时失败关闭，process harness 有明确时限，in-flight journal 防止
  中断后的 mutation 被普通重试重复执行。Journal 只是本地协调状态，不是验证证据；
  receipt 成功落盘后即清除。

## 风险

- 控制面可能在仓库真正需要前成为第二个产品。因此先做 run-to-completion CLI，推迟
  daemon、catalog、queue、多租户和通用 DSL。
- 弱 Contract 或 verifier 会把错误行为形式化。架构与检查强度仍需 review；控制面传递
  决策，但不提供产品智能。
- 多个状态存储可能漂移。Desired、observed、receipt、PR 与 memory 必须分属不同 owner，
  并由稳定 ID/digest 连接。
- Provider 可能成为权限逃逸口。必须要求 capability declaration、policy、scope match，
  对未知操作失败关闭。
- 过程指标可能鼓励仪式而非有用工程。Receipt 证明执行与来源，不证明设计本身正确。

## 参考资料

- [OpenGitOps principles](https://opengitops.dev/)
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Backstage software catalog](https://backstage.io/docs/features/software-catalog/)
- [Crossplane control planes](https://docs.crossplane.io/latest/whats-crossplane/)
- [CUE constraints](https://cuelang.org/docs/tour/basics/constraints/)
- [OPA philosophy](https://www.openpolicyagent.org/docs/philosophy)
- [GitHub Spec Kit](https://github.github.com/spec-kit/)
- [SLSA build provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md)
