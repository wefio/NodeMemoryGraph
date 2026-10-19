# 运行至终态的 CLI

[English](run-to-completion-cli.md) · [使用的术语](run-to-completion-cli.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.zh-CN.md)。

## 运行至终态的 CLI

显式规划、外部 harness、中断恢复、PR/forge 绑定或控制面管理使用 `nmg-rcp`。
它是独立入口，不由 NMG daemon 托管。日常 Agent 工作使用 `npm run agent:verify`：
该入口发现唯一完整覆盖 scope 的 authored Contract 后，会执行 workspace-ready reconcile，
不必再手工运行第二条命令。

### 应用前先检查

把 `.rcp/contracts/change.yaml` 替换为目标 Contract 路径。请求 mutation 前，先确认 scope
和授权；命令 flag 不增加权限。编译与规划是只读入口：

```text
nmg-rcp compile .rcp/contracts/change.yaml
nmg-rcp plan .rcp/contracts/change.yaml
```

`reconcile` 默认也只生成 plan。应用时需传入 `--apply`，并显式选择当前 workspace 或
外部 harness。验证已有 workspace 的入口为：

```text
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready --nmg disabled
```

### 恢复时不重放 harness

遇到中断 attempt 标记时，必须显式选择恢复。以下命令只验证现有 workspace；
`--recover-attempt` 只处理已经存在的标记，禁止再次运行外部 harness：

```text
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready --recover-attempt
```

失败收据追加保存，不覆盖旧记录。修复外部状态后可以重试；只有通过完整性校验、绑定当前
route/check/verifier 的 verified 收据才可用于幂等复用。
`.rcp/receipts/` 不参与仓库 observed revision，避免控制面输出改变自身输入。

### 绑定已授权的 PR 与 CI 操作

以下命令会修改 forge 状态，只能在 Contract 和 provider 授权下执行。
将 `main`、`feature/change` 和 `42` 替换为实际 base、head 分支和 PR 编号：

```text
nmg-rcp forge-create .rcp/contracts/change.yaml --base main --head feature/change
nmg-rcp forge-bind .rcp/contracts/change.yaml --pr 42
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready \\
  --pr 42 --operation-key pr-ci --nmg disabled
```

本地验证与 PR/CI 收据使用不同的 `operation-key`，但绑定同一个 Contract digest。
带 `--pr` 的收敛还要求 PR 正文机器标记、head commit 和成功 CI 状态一致。
远程收敛只接受 `spec.verification.forgeChecks` 明确列出的检查否决；其他第三方或 advisory
状态仍记入收据，但不能取得未声明的控制面否决权。

### 发送可选会话反馈

追加 `--nmg optional --session-id <id> --task-frame-id <id>`，将新落盘收据投影到指定会话 AG。
两项身份必须同时提供，使用调用方实际的 session 与 task-frame ID，不能从 Contract ID 猜测。
该路径只连接 `NMG_DATA_DIR` 下已运行、协议和能力兼容的 `nmg.sqlite` daemon；
不启动、替换或停止 daemon，不执行普通 recall，也不发布 Task Board result。

`tool_observation` 保留 receipt ID、Contract digest、observed revision、检查结果与有界诊断，
遵守 AG 激活、去重和会话清理规则。完整证据仍由收据拥有；AG 摘要不是任务完成标签，
也不自动成为 LTG 或训练输入。

完整性与成功分开：scope 越界的 `failed` 收据可以保存并投影，但不能作为成功复用；
`verified` 仍需 scope 匹配。RCP 通过随包 CLI `nmg session observe` 通讯，不导入 NMG 内部模块。
plan 和收据复用不发送新通知；投递失败只记入 `memoryDiagnostics`，不改变验证结论。
该边界不含通用事件总线、自动重试投递、跨会话续接或学习激活。

### 不把权限上限当作常驻服务

支持的路径是 run-to-completion。`continuous` 是 Contract 可声明的权限上限，
不表示已安装 watcher。常驻 queue、catalog 和 watcher 延后到真实持续 Contract 需要时再加入。
