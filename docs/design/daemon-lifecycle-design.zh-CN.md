# NMG Daemon 生命周期加固设计（Idle 超时 / 自动重拉 / 数量上限）

[English](daemon-lifecycle-design.md) · [术语](daemon-lifecycle-design.terms.yaml)

**Status:** current
**Updated:** 2026-10-13
**Related:** [stg-isolated-store.md](stg-isolated-store.md), [memory-graphs.md](memory-graphs.md), [external-source-design.md](external-source-design.md), [design.md](design.md)

受控 reload 及其交接专用客户端描述是保留的源分支设计，条件是已安装实现明确支持该能力；不声明本 checkout 提供该命令或相关测试。普通存储、ownership 与兼容性规则不因此改变，实际可用操作以 CLI 和认证发现为准。

## 背景：2026-08-02 内存耗尽事故

评测 `run.ts locomo matched 99999` 期间，节点内存被 node 进程打爆（63.7GB 物理内存占用 98.2%，工作集超 100GB）。已定位根因（详见事故分析，归档于 NMG 记忆 `NodeMemoryGraph-eval-daemon-leak`）：

- 每个评测 arm 通过 `src/cli/daemon-client.ts` 以 **`detached: true` + `child.unref()`** 拉起独立 nmg daemon（每个 arm 的 sqlite 路径唯一 → `readyState()` 永远复用不了 → 只增不减）；
- daemon **没有 idle 超时**，只在收到 HTTP `shutdown` 或 SIGTERM 时退出；唯一清理路径是扩展的 `pi.on("session_shutdown")`，而评测用 `RpcClient.stop()` 强杀子进程（Windows 下 SIGTERM=TerminateProcess），清理处理器不执行；
- 现场记录：837 个 arm、两个 nmg 模式，以及 **1670 份 `nmg.sqlite.server.json`**；单 daemon 估算 50–200MB，工作集合计约 100GB。

**本次设计目标：在 daemon 侧建立自愈机制（防御纵深），不依赖评测侧是否优雅清理。**

## 需求

| 编号 | 需求 | 验收口径 |
| --- | --- | --- |
| R1 | daemon 空闲超时自动退出 | 无请求超过 `N` 秒后自行优雅退出并释放 lease |
| R2 | 超时退出后能**原样重新拉起** | 客户端再次连接同一 db 时自动重拉新 daemon，sqlite 数据不丢；会话中途 daemon 死亡也能自愈 |
| R3 | daemon 数量上限检测 | 拉起前统计存活 daemon 数，超过上限（默认 32）向 stderr 警告 |

## 决策总览

| 需求 | 方案 | 配置项 | 默认值 |
| --- | --- | --- | --- |
| R1 | daemon 内建 idle 计时器，每次请求刷新；超时走与 `shutdown` 相同的关闭路径 | `NMG_DAEMON_IDLE_TIMEOUT_MS` | `300000`（5 分钟；`<=0` 禁用） |
| R2 | 复用现有 `readyState` 探活 + `acquireServerLease` 残留清理；新增客户端**连接失败自动重连一次** | 无（固定行为） | — |
| R3 | spawn 前扫描 `*.server.json` 统计存活 pid，超限警告 | `NMG_DAEMON_LIMIT` | `32`（`<=0` 禁用） |

## R1：daemon idle 超时自动退出

### 行为定义

- daemon 启动时即启动计时器（**即使一个请求都没收到**也会退出，覆盖"spawn 后客户端先死"的孤儿场景）；
- **请求到达并交给 handler 前**（含 `hello`）重置计时器；响应完成不会再次刷新；
- 超时后调用与 `shutdown` 共用的关闭 helper：`server.close()` 停止接受新连接，随后 `closeAllConnections()` 关闭 HTTP 连接；`closed` promise 决议后调用 `lease.release()`（删除 `*.server.json`），`serveHttp` 返回，`daemon run` 以 0 退出；
- `shutdown` 与 idle 超时互斥：`closing` 标志防止重复关闭；
- **在途请求边界：**设计意图是不打断已接受请求，但当前 helper 调用 `closeAllConnections()`；超时前仍在处理的长请求可能被中断。现有 idle 测试只覆盖退出和刷新，不覆盖长请求。

### 实现位置

`src/cli/http-server.ts` 的 `serveHttp`：

```ts
export async function serveHttp(
  service: NmgService,
  lease: ServerLease,
  options: { idleTimeoutMs?: number } = {},
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? daemonIdleTimeoutMs(); // env
  let idleTimer: NodeJS.Timeout | undefined;
  let closing = false;
  const close = () => { /* server.close + closeAllConnections + 清计时器 */ };
  const touch = () => {
    if (closing) return;
    clearTimeout(idleTimer);
    idleTimer = idleTimeoutMs > 0 ? setTimeout(close, idleTimeoutMs) : undefined;
  };
  // 启动即 touch()；每个请求 handler 先 touch()
}
```

`daemonIdleTimeoutMs()` 读取 `NMG_DAEMON_IDLE_TIMEOUT_MS`，非法值回退默认。`options.idleTimeoutMs` 仅测试注入。

### 为什么默认 5 分钟

| 场景 | 要求 |
| --- | --- |
| 交互式 `nmg daemon start` | 用户可能长时间思考后回来，5 分钟起步合理 |
| 评测 arm（单次 prompt） | arm 完成后 daemon 即失联，5 分钟内自退；可调低至 60s 加速回收 |
| 慢模型思考间隙（两次 nmg 调用间隔） | 工具调用间隙通常 < 5 分钟；即使超时被杀，R2 的重连兜底可自愈 |

### 备选方案（不选）

| 方案 | 否决理由 |
| --- | --- |
| 父进程存活探活（PPID 轮询） | daemon 由 `detached` 拉起，PPID 语义在 Windows 上不可靠；`spawn` 父进程（cli.js 子进程）本就短命，父死即退会让"评测 arm 内多次连接"失效 |
| 固定 TTL（启动后 N 秒必退） | 长会话（长文档问答）会被误杀，且无请求语义区分活跃/闲置 |

## R2：超时退出后能原样重新拉起 —— 结论：能

### 现有机制已支持（逐环验证）

1. **连接侧探活**：`daemon-client.ts` 的 `readyState()` 要求 `isProcessAlive(pid)` 为真才复用；daemon 超时退出后 pid 死亡 → 视为"无 daemon" → 走 spawn 分支；
2. **残留 lease 清理**：`lifecycle.ts` 的 `acquireServerLease` 用 `wx` 独占创建 `*.server.json`，遇 EEXIST 时读 pid：存活则报错（防双 daemon），**已死则 `rmSync` 后重试** → 强杀/崩溃残留的 stale 文件不阻塞重拉；
3. **持久数据恢复**：新 daemon 用同一 `--db` 恢复 SQLite 记忆与黑板。AG、writer 租约与其他进程内状态不恢复；token/port 每次新生成，客户端通过 `server.json` 重新发现。

### 新增：客户端连接失败自动重连（防"会话中途被杀"）

agent 思考间隙超过 idle 超时时，daemon 可能在会话中途退出。客户端按同一
`databasePath` 重新发现端点和 hello 能力，并更新原连接对象。只有旧 owner 确实退出
才允许连接级重拉；存活 owner 的瞬时端点故障不会让客户端另起第二 writer。

`invokeDaemon` 在调用前等待交接并刷新改变的 owner，再进行能力检查。
请求尚未发出时可正常连接新 owner；请求已经发出而响应丢失时，只对
[客户端读取集合](../../src/cli/daemon-client.ts)自动重试一次。变更操作结果不确定就
明确报错且不重放。HTTP/协议/领域拒绝不重试；缺能力不隐式升级。

### 重连的所有权语义

- 重连 spawn 的新 daemon `startedByCaller=true` → 扩展 `session_shutdown` 时 `shutdownOwnedDaemon` 会正确关停它，与"评测场景下每个 cli.js 子进程独占一个 arm daemon"的事实一致；
- 原 daemon 若由**本进程**启动且已死，重连后新 daemon 归本进程所有，无归属冲突。

## R3：daemon 数量上限检测（默认 32，超限警告）

### 触发点与行为

- 在 `connectDaemon` **spawn 新 daemon 之前**统计（复用路径不统计，因为不新增）；
- 存活数 > `NMG_DAEMON_LIMIT`（默认 32）时向 **stderr** 输出警告，**不阻断** spawn（按需求：警告而非拦截）；
- **每进程只警告一次**：评测 ~6000 次连接调用，逐次警告会刷屏；首次越限时附带当前计数与处置提示。

```
NMG: warning: 1670 NMG daemons running (limit 32); raise NMG_DAEMON_LIMIT or stop stale daemons (nmg daemon stop --data-dir <dir>)
```

stderr 会被 `RpcClient` 子进程捕获并透传到评测主进程，可观测。

### 统计实现 `countRunningDaemons`

- **扫描根**：`daemonScanRoots()` 仅返回 `resolveNmgDataDir()`（默认 `~/.nmg`）；不加 `process.cwd()`，只覆盖该数据根。附近注释仍提到 cwd；以函数实现为准，warning 不是全局计数；
- **存活判定**：递归找 `*.server.json`，排除 `SKIP_DIRS`，筛选有效 HTTP 字段和存活 PID，再用 250ms authenticated `hello` 验证并按端点去重；
- **排除目录**：`node_modules`、`.git`、`dist`、`coverage`、`.nmg`、`build`（与 `tests/cli/http-boundary.test.ts` 的 `SKIP_DIRS` 一致）；
- **成本**：模块 memo TTL 为 **1 秒**。当前扫描还会并行 authenticated `hello`；早期 50–200ms 估算不是当前端到端测量；
- 扫描是**只读、无协调**的：不引入跨进程注册表，避免陈旧条目/锁竞争。

### 为什么默认 32

评测并发上限 16（`NMG_BENCH_CONCURRENCY` 硬上限）× matched 模式每用例 2 个 nmg arm（nmg-deterministic + nmg-candidate）= **恰好 32 个合法在途 daemon**。因此：

- `32` = "一整套满并发评测的合法规模"，默认值下正常评测不误报；
- 超过 32 即提示有泄漏/重复运行（上轮事故 1670 ≫ 32）；
- `NMG_DAEMON_LIMIT=0` 或负数可完全禁用检测。

### 备选方案（不选）

| 方案 | 否决理由 |
| --- | --- |
| 注册表文件登记 pid | 跨进程无原子保证、强杀后残留脏条目、与 `*.server.json` 现有事实源重复 |
| 超限即拦截（硬上限） | 需求明确"警告"；拦截会引入评测误伤（合法多进程同时拉起）风险，留待后续按需加 `NMG_DAEMON_LIMIT_BLOCK` |
| 只扫 `NMG_DATA_DIR`（当前实现范围） | 原设计因 arm 数据可能在项目树而否决；当前函数仍只返回 data root，可能漏掉该范围外的 daemon |

## 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/cli/http-server.ts` | `serveHttp` 增加 idle 计时器（touch/close/closing 标志）；`daemonIdleTimeoutMs()` 读 env；`httpHandler` 保持签名不变（onShutdown 改为内部 close） |
| `src/cli/daemon-client.ts` | `DaemonConnection.databasePath`；`connectDaemon` spawn 前调 `countRunningDaemons` + 越限警告（每进程一次）；`invokeDaemon` 连接级失败重连一次；新增 `countRunningDaemons`、memo、环境变量解析 |
| `tests/cli/process.test.ts` | 新增 idle 超时退出、超时后重拉、数量检测/警告的进程级测试 |
| `tests/cli/http-boundary.test.ts` | 不破坏：`daemon-client.ts` 仍只 import `./http-client.ts`、`./lifecycle.ts`（新增 import 需复核不引入 `../core/*`） |
| 本设计文档 + `evals/README.md` | 记录 `NMG_DAEMON_IDLE_TIMEOUT_MS`、`NMG_DAEMON_LIMIT` |

| `src/cli/main.ts` | `waitForState` 增加 `isProcessAlive(pid)` 探活（修复 stale lease 时误把死进程端点当活 daemon 去连接） |

## 测试计划

| 用例 | 方法 | 断言 |
| --- | --- | --- |
| idle 超时退出 | `NMG_DAEMON_IDLE_TIMEOUT_MS=1000` 起 daemon，等 ~1.5s | `daemon status --json` → `running:false`；`*.server.json` 已删除 |
| 请求刷新计时器 | idle=2s，第 1s 发 `hello`/`status`，第 3s 再发一次 | 第 3s 调用仍成功（计时器被刷新） |
| 超时后原样重拉 | 上例后再次 `connectDaemon`（或 `daemon start`） | 新 daemon 可用、pid 变化、`remember`/`search` 数据完整 |
| stale lease 重拉 | 手动写 `*.server.json`（pid=已死进程）后 `daemon start` | 自动清理残留并拉起成功 |
| 数量检测 | 在临时 `NMG_DATA_DIR` 根下启动真实测试 daemon，再用另一个连接触发 spawn；覆盖 authenticated `hello` 计数 | 超限时 stderr 含 warning；高上限或 `NMG_DAEMON_LIMIT=0` 时无警告。当前测试不把“pid 存活”单独当作 daemon 计数证据 |
| 连接失败重连 | 起 daemon → `stopServer` 杀掉 → 立即 `invokeDaemon` | 自动重拉新 daemon 并成功返回 |
| 边界守护 | 跑 `tests/cli/http-boundary.test.ts` | 不回归（daemon-client 未引入 core 依赖） |

## 验收标准（针对事故场景复现）

**实测（2026-08-02 17:37 本地实机）**：`NMG_BENCH_CONCURRENCY=4 NMG_DAEMON_IDLE_TIMEOUT_MS=60000 NMG_DAEMON_LIMIT=4` 跑 `npm run eval:locomo -- matched 1`（5 用例 × 3 模式 = 15 个 arm），deepseek-v4-flash，约 90 秒完成：

| 指标 | 结果 |
| --- | --- |
| RPC 子进程峰值 | 4（= 并发上限，不再失控） |
| nmg daemon 峰值 | ~9（= 并发 × 2 + idle 窗口内未退出的旧 daemon） |
| 评测结束后 daemon | 60s 内逐批自退，2 小时观察恒为 1（用户日常 ~/.nmg 基线），**零残留** |
| 数量警告 | 将上限调低至 4 后，记录到计数为 5 与 6 的 warning（当时计数含用户基线 daemon） |
| 评测正确性 | 15/15 行有答案，0 answerError |
| 内存 | 评测期间占用 ~19GB，结束后回落，可用 44.5/63.7 GB |

这只是 2026-08-02 的单次本地观察，不构成通用内存/性能保证，也未验证当前扫描器对其他 data-root 的覆盖或时延。事故记录中的 1670 个描述符和约 100GB 工作集仅作量级对照。

1. 模拟并发：`NMG_BENCH_CONCURRENCY=16 nm npm run eval:locomo -- matched 5`；
2. 运行中 `tasklist /FI "IMAGENAME eq node.exe"` 观察：daemon 峰值 ≈ 并发 × 2（≤32），arm 完成后逐个自退；
3. 进程数不再单调累积；内存峰值与 daemon 峰值同步，不随时间膨胀；
4. 人为把某 daemon 杀掉（`stopServer`）后，下一次 nmg 调用自动拉起新 daemon，评测不失败；
5. stderr 出现越限警告（人为调低 `NMG_DAEMON_LIMIT` 验证），正常配置下无警告。

## 不做的事（范围外 / 后续）

- **评测侧显式清理**（`evaluate()` finally 里 `shutdownOwnedDaemon`、启动前全量扫 stale daemon）：本设计是 daemon 侧兜底，评测侧修复仍推荐单独做（互不替代）；
- **daemon 复用**（matched 3 arms 共享同一 seed db/daemon）：减少 spawn 次数的结构性优化，独立改动；
- **硬阻断上限**：留 `NMG_DAEMON_LIMIT_BLOCK` 作为可选后续项。

## Controlled code reload

Read the complete responsibility: [受控代码重载](daemon-lifecycle-design/controlled-code-reload.zh-CN.md).

## Implementation lineage

- **Introduced — `39516537`**：建立 resident CLI daemon 生命周期。
- **Superseded — `9444a3c1` → `692fe85c`**：gRPC transport 被跨平台 HTTP JSON-RPC 取代；协议语义继续由 `src/cli/protocol.ts` 管理。
- **Hardened — `80167da9`、`a5787cd6`、`30e273e8`**：owned shutdown、idle 退出和重连路径收敛。
- **Hardened — `11e2101f`**：stale protocol fail-closed，避免旧 daemon 静默接受新客户端。
- **Hardened — `9a911d00`、`ac2d1114`**：对齐 SQLite 单写者/STG 并发契约，并按最长前缀稳定路由嵌套 CLI 命令。

完整历史分类见 [implementation lineage](implementation-lineage.md)。
