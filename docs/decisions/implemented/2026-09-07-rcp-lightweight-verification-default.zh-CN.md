# RCP 默认轻量验证

[English](2026-09-07-rcp-lightweight-verification-default.md) · [术语](2026-09-07-rcp-lightweight-verification-default.terms.yaml)

**Status:** implemented  
**Approved:** unrecorded
**Relates to:** [窄域验证](2026-09-07-narrow-route-verification.zh-CN.md)

## 问题

路由级验证过去是全有或全无。`agent:verify` 要么运行路由声明的整套 blocking 检查
（一个文件的改动也常跑 `test:product` 加 `build`），要么走可选的 `--narrow` 路径运行
更小的集合，但该路径完全绕过了 reconciliation：不经过 `reconcileOnce`，不写 `.rcp`
receipt，也不记录实际运行了哪个 gate。因此 narrow 运行的 receipt 与 full 运行的 receipt
无法区分，任何把部分运行称为“已验证”的说法都夸大了事实。

固定可信基线（[RCP 决策](2026-08-29-repository-control-plane.zh-CN.md)、
[操作契约](../../design/ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.md#fixed-trusted-baseline-verification)）
保护验收规则不被候选削弱。它本身不降低普通改动的成本，且是单独的显式命令。

## 决策

把 narrow 验证设为默认，但仅在选择规则健全、记录诚实的前提下。

- **选择规则。** 只有当每个改动 scope 恰好被一个路由拥有，且没有任何 scope 落在共享 /
  横切根（`src/`、`tests/`、`scripts/`、`tools/`、`.github/`、`package.json`、
  `package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`agent-context.yaml`、
  `AGENTS.md`）之下时，改动才 narrow-eligible。跨路由、无主、歧义、共享根或空 scope 集
  一律升级为声明的 blocking 集。`--full` 强制 full；`--narrow` 仅请求 narrow，不覆盖
  eligibility，因此不合格 scope 仍升级为 full。两个 flag 互斥；有疑问时跑 full。
- **narrow 是一等 RCP 模式。** 它经 `reconcileOnce` 运行，并像其他运行一样写入
  `.rcp/receipts/` receipt。当没有 authored contract 覆盖该改动时，为 reconciliation
  合成一个内存 contract。不存在旁路执行路径。
- **共享检查与路由测试。** 初始 narrow 实现运行 `check`、`docs:check`、`format:check`、
  `lint`、`package:check`，以及属主路由自己的测试。当前共享检查集与路由级
  `verify.sharedChecks: none` 例外由
  [Narrow and full verification gates](../../design/ci-cd-and-quality/repository-control-plane/lightweight-verification.zh-CN.md)
  拥有。路由 `tests:` 模式解析为具体文件（排除匹配目录），零匹配时 fail-closed；子进程不
  继承父进程的 `NODE_TEST_CONTEXT`，以免 Node 跳过执行并把空运行记为通过。路由测试采用
  可信基线的 TAP 接受规则（`tests > 0`、`pass == tests`，且 `fail`/`cancelled`/`skipped`/`todo`
  均为零）。路由的 `verify.blocking` 集是升级到 full 时运行的内容。
- **诚实的 gate 记录。** `RepositoryReceipt.gate` 携带
  `{ mode: "narrow" | "full"; reason?: string; fullGateRun: boolean }`。narrow 运行的
  `fullGateRun` 恒为 `false`，因此“没有跑完整 gate”是机器可读的事实而非推断。
  `validateReceipt` 会拒绝 `fullGateRun` 与 `mode` 矛盾的 receipt。使用
  `nmg-rcp receipt-verify <path>` 可独立检查 receipt 自洽性；这不认证执行。
- **绑定与 fail-closed 规则不变。** 结果绑定候选、基线、验证器、策略与调用摘要；缺失、
  跳过、空、超时、快照变动或依赖变化的输入一律失败。同一状态下身份有效的 receipt
  重用遵循[协调契约](../../design/ci-cd-and-quality/repository-control-plane/run-to-completion-cli.md)，
  不能用来证明不同 revision。

narrow 减少的是运行的检查，不扩大可主张的范围：`gate.fullGateRun: false` 恰好说明
只跑了部分 gate，任何 receipt 都不主张设计已全部实现。

## 考虑过的替代方案

- **在代表性成本证据出现前保持默认不变。** 拒绝，因为 narrow 规则及其诚实记录现已明确
  并有测试覆盖；保留粗粒度默认只会保留成本。证据问题从默认切换的前提，变为对一个已实现、
  可审计行为的度量。
- **把自哈希收据当简洁证明。** 拒绝。任何人都能伪造结果并重算摘要；收据校验只检查自洽，
  不认证执行来源。
- **把 PCP/SNARK/STARK 作为权威 gate。** 暂缓。它们是真实的证明系统，但本地流程没有
  已实现的证明关系、prover 或成本证据，且不覆盖实际执行与测试规格缺口。
- **形式验证小裁决内核。** 仍可考虑；模型证明必须与实际运行实现建立可靠对应，这里不作
  此主张。
- **仅保留显式 narrow/full 选择。** 拒绝作为默认，因为选择规则是确定且可审计的；
  显式选择 flag 仍保留，但 narrow 请求仍受 eligibility 约束。

## 后果

- 普通小改动不再重跑产品测试套件，且 receipt 说明完整 gate 是否运行。
- narrow 选择是路由归属启发式，不是依赖分析。真实影响跨共享路径、但未落在共享根上的
  改动仍可能不完整。这就是记录 `fullGateRun`、并在归属不明时默认升级的原因。
- narrow 运行适用的共享检查和路由测试，受路由 `verify.sharedChecks` 声明约束；它不运行路由完整的
  `verify.blocking` 集。路由 blocking 仍是升级到 full 时的契约。
- 固定可信基线与本默认是两件事。narrow 绿灯不是可信基线通过，也不是一般正确性证明。
- 可靠性受本地信任模型约束：同用户修改安装或运行时不在其内，哈希也不证明执行。
