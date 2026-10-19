# Narrow 与 full 验证门

[English](lightweight-verification.md) · [使用的术语](lightweight-verification.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.zh-CN.md)。

## Narrow 与 full 验证门

判断 `npm run agent:verify` 选择哪些检查、结果能说明什么时，使用本参考。
Gate 选择是归属启发式，不是依赖分析。实际影响跨 owner 或归属不明时使用 full，
不能仅凭修改文件名就推断安全。

### 判断所选 gate

默认 narrow 要求每个改动 scope 恰好有一个 owner、同一路由独占整次改动，且没有 scope
落在共享/横切根下。共享根为 `src/`、`tests/`、`scripts/`、`tools/`、`.github/`、
`package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、
`agent-context.yaml` 和 `AGENTS.md`。

| 情况 | 选中的检查面 |
| --- | --- |
| 唯一、无歧义的非共享 owner | Narrow：共享不变量加属主路由测试。 |
| 跨路由、无主、共享根、歧义或空 scope | Full：适用路由声明的 blocking 集。 |
| `--full` | 强制 full。 |
| `--narrow` | 请求 narrow；归属不满足条件时仍升级 full。 |

`--full` 与 `--narrow` 互斥。Full 指适用的 blocking 集，不代表运行仓库所有 benchmark、
平台或 advisory 检查。

`NARROW_SHARED_CHECKS` 为 `check`、`docs:check`、`format:check`、`glossary:check`、
`lint`、`package:check`、`rtm:check`。路由 `tests:` 模式解析为实际文件，排除匹配的目录，
零匹配失败关闭；合成为 `node-test:<routeId>` 检查。

### 拒绝跳过或空跑的路由测试

路由测试子进程不继承 `NODE_TEST_CONTEXT`，否则 Node 可能跳过执行，导致空跑被误判通过。
TAP 接受规则与可信基线路由测试相同：`tests > 0`、`pass == tests`，且
`fail` / `cancelled` / `skipped` / `todo` 均为零。单项跳过、全 skip 或零执行都不算成功。

### 解释路由对共享检查的声明

路由可声明 `verify.sharedChecks: none`（默认为 `always`），表示这些共享不变量不适用于
它拥有的表面。仅在该路由独占整次改动时生效；此时 narrow 只跑路由测试。
声明不能让共享/横切根免于升级。路由未声明自己的测试时，配置加载就拒绝此声明，
不能通过拒绝共享检查制造“什么也没跑”的成功计划。

收据的 `gate.reason` 会点明此声明，不要求读者数检查条数才能发现。
取舍见[决策](../../../decisions/implemented/2026-09-16-route-declines-shared-checks.md)。

### 区分验证证据与收据

Narrow 经 `reconcileOnce` 执行，使用 authored Contract 或合成的内存 Contract，并写入
`.rcp/receipts/` 收据。Full 有适用 authored Contract 时也走 RCP；没有时直接执行普通 route
计划，记录验证证据，但不生成 RCP 收据。选择分支由[执行器](../../../../tools/agent-verify.ts)拥有。

RCP 收据的 `gate.mode` 为 `narrow` 或 `full`，`gate.reason` 可选；narrow 的
`gate.fullGateRun` 恒为 `false`。`validateReceipt` 拒绝 mode 与 flag 矛盾的收据。
使用 `nmg-rcp receipt-verify` 并提供收据文件可独立检查完整性；
`agent:verify --receipt <id>` 不是执行器支持的选项。

### 保留证据边界

Narrow 减少检查面，不放宽其 verifier 模式的身份要求。该模式要求的候选、基线、verifier、
policy 和 invocation 绑定仍适用；普通验证不会因此变成隔离的可信基线验证。
历史或不同身份的证据不能代替当前检查。缺检查、跳过、超时、空报告、快照变动或依赖变化
均失败关闭。身份完整且同状态的收据能否幂等复用，由[协调合同](run-to-completion-cli.zh-CN.md)
决定，不表示旧结果可以认证另一版本。

Narrow 不覆盖没有执行的检查，`gate.fullGateRun=false` 记录这一限制。
即使不涉及共享根，文件归属也可能漏掉真实跨界影响。对抗 fixture 的 owner 为
`tests/tools/agent-verify.test.ts`、`tests/tools/narrow-verify.test.ts` 与
`tests/rcp/receipts.test.ts`。
