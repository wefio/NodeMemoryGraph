# Daemon 操作

[English](operations.md) · [术语](operations.terms.yaml)

## 开发 CLI 路径

本 Skill 中的示例假设 `nmg` 已在 `PATH` 中（全局安装）。在开发 checkout 中使用以下任一方式：

```text
npm run cli -- <command>
node bin/nmg.mjs <command>
```

## 安全的生命周期所有权

启动前运行 `nmg daemon status --json`。只有 `compatible=true` 时才复用已运行的 daemon，并让它继续运行。如果本次调用启动了原先停止的 daemon，则在清理时将其停止。

```text
nmg daemon start --json
nmg daemon status --json
nmg daemon stop --json
```

Pi 适配器会自动跟踪本次启动的所有权。

正在运行但不兼容的 daemon 是明确的协作边界。不要自动停止、重启或替换它：它可能正由另一个 Agent 共享。报告旧协议版本和所需协议版本，并请求 owner／用户在安全时机执行 `nmg daemon restart`。重启后正常重新连接；不得回退到旧 RPC 名称，也不得静默省略失败的操作。

## 受控代码重载

只有在明确协调的升级边界上才使用 `nmg daemon reload --db <DATABASE> --json`。它要求当前运行的 owner 声明 `controlled-reload` 能力；旧 daemon 会被拒绝，而不会静默重启。先构建选定 checkout。重载会排空已接受的调用，为替代进程启动设置 fence，并确认新的已认证 owner。持久记忆和 board 数据保留；私有 AG 与 writer 租约会清除，必须根据仓库／任务证据重建。

格式错误或孤立的 `<DATABASE>.reload.json` 不代表可以删除它或另启 owner。检查 controller 和两个候选 daemon 进程后，协调恢复。见[生命周期 owner](../../../docs/design/daemon-lifecycle-design/controlled-code-reload.zh-CN.md#controlled-code-reload-1)。

## 存储选择

CLI 的 LTG 存储默认为 `NMG_DATA_DIR` 或 `.nmg`。Pi 适配器的 LTG 默认为 `~/.nmg`，并将工作目录作为项目 STG 根目录。指定 LTG store 后，每个生命周期及记忆命令都传入相同选项：

```text
--data-dir <DIRECTORY>
--db <SQLITE_FILE>
```

不要意外混用不同 store。

当 `remember`、`search` 或 `get` 可能访问项目 STG 时，使用 `--project-dir <DIRECTORY>`。如需填充有作用域的项目缓存，显式执行：

```text
nmg stg sync --project-dir . --scope project=atlas --limit 50 --json
```

该命令幂等。它将权威 LTG 内容复制到 `<project>/.nmg/stg.sqlite`，不会移动或删除 LTG 记录。

## 故障处理

1. 检查 daemon 状态，包括 `compatible`。
2. 仅当 daemon 已停止时尝试启动一次。如果它不兼容，应请求协调重启，不要另启 daemon。
3. 确认选择的数据目录／数据库一致。
4. 用 `nmg status --json` 检查存储和 embedding 健康状态。
5. 如果检索 embedding 降级，词法召回仍可能可用。

不要反复启动 daemon，也不要手工删除 daemon 状态。不要仅因一个 Agent 已完成工作就停止共享 daemon。

## 保留生命周期（L4 / L5）

记忆会经过不同层级老化。正常索引层级之外还有两种保留状态：**L4 dormant**（待移除候选）和 **L5 quarantine**（永久丢失前的恢复窗口）。生命周期是显式的，不会自动删除：

```text
# Dry-run：列出将被保留的记录，并比较当前状态与建议状态
nmg retention candidates \
  --dormant-after-days 90 \
  --quarantine-after-days 30 \
  --maximum-importance 0.3 \
  --maximum-access-count 5 \
  --json

# 对候选记录采取操作
nmg retention archive <MEMORY_ID>        # -> L4 dormant
nmg retention quarantine <MEMORY_ID> \   # -> L5 quarantine
  --recovery-days 30
nmg retention restore <MEMORY_ID>        # -> indexed（恢复）
```

保留操作改变可见性，不改写底层历史证据。只要记录仍处于 quarantine，就可以恢复。

## 节点维护

图结构不正确时可以合并或拆分语义节点。合并可以通过 redirect 反向恢复；拆分会把每条记忆重新分配且只分配一次。

```text
# 将多个节点合并为一个（身份／别名巩固）
nmg node merge <NODE_ID> <NODE_ID> \
  --target-name "merged node name" \
  --target-kind concept \
  --json

# 将一个节点拆为多个，并分区分配其中的每条记忆
nmg node split <NODE_ID> \
  --partition "new node A=<MEMORY_ID1>,<MEMORY_ID2>" \
  --partition "new node B=<MEMORY_ID3>" \
  --json
```

合并前运行 `nmg status --json` 检查 store 健康状态。Node ID 来自 `nmg search --json` 结果或 `nmg get` 输出。
