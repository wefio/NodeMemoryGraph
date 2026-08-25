# 代码质量与 CI/CD

**Created:** 2026-07-20  
**Updated:** 2026-08-25  
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

`eval:*`、`benchmark:*`、真实 LLM/embedding 与官方大数据集运行不进入 keyless CI。研究测试可以验证 adapter 和计分契约，但不得访问外部密钥或把实验常量提升为产品默认值。

覆盖率轨将测试并发限制为 2，避免 c8 插桩与跨进程/SQLite 测试叠加时制造内存峰值和 Windows 文件锁假失败；普通 product 轨仍使用并发 4。

## 3. CI 契约

`.github/workflows/ci.yml` 使用以下 job：

- `static`：build、package、type、lint、format、文档、Agent context 与生产依赖审计；
- `tests`：Node 24 产品测试和覆盖率；
- `research-tests`：研究/benchmark adapter 表征，`continue-on-error`；
- `node-compat`：最低支持版本 Node 22.19 的 build/package；
- `chaos`：Windows 上的资源与 daemon 故障注入；
- `all-checks-passed`：只聚合阻塞轨道。

CI 或打包规则变更除本地目标测试外，应在 clean checkout（或等价干净 worktree）运行其完整命令，防止未跟踪文件让本地验证产生假阳性。

## 4. 可组合测试运行时

需要文件系统、SQLite 和 daemon 的集成测试使用 `tests/support/test-runtime.ts`：

```text
TestRuntime
├── testWorkspace
├── testDatabase
└── testDaemon
```

测试通过 `withTestRuntime(...)` 或显式 `dispose()` 获取 RAII 式回收。插件依赖必须显式：database 要求 workspace，daemon 要求 database；缺少依赖时失败，不偷偷创建隐含全局状态。daemon 在进程内使用真实 HTTP JSON-RPC handler，因此能验证协议，同时不会遗留后台进程。

该层精确锁定 `@deepseek-ai/cordis@4.0.1` 作为 **devDependency**，只借用插件 effect/fiber 生命周期。NMG Core、daemon、Pi adapter 和发布包均不依赖 Cordis；不引入其 loader、HMR 或配置系统。测试运行时通过窄 wrapper 隔离，未来若替换框架只修改 test support。

## 5. Agent 原生仓库上下文

根 `AGENTS.md` 只保存稳定启动协议。Agent 修改仓库前运行：

```powershell
npm run agent:context -- --scope <目标路径>
```

`tools/repo-context.ts` 从 Git、`package.json`、`agent-context.yaml`、owner 文档和临时 guardrail manifest 生成当前任务视图。它是只读开发工具，不访问 NMG 数据库，不启动 daemon，也不调用 LLM 或 embedding。`--changed` 可以把当前工作树的全部改动作为 scope；共享脏工作树中应优先传入本任务拥有的精确 `--scope`，避免把其他 Agent 的改动误纳入计划。

`skills/repo-development/SKILL.md` 定义修改、测试和提交工作流；`agent-context.yaml` 只维护无法可靠自动推导的模块所有权与验证分类。每条 route 显式区分 `blocking` 与 `advisory`，且命令必须精确对应 `package.json` script；不允许用含义过宽的 `test` 代替 `test:product`、`test:research` 或 `test:chaos`。实现状态继续由源码、`completion-audit.md` 和 `temporary-todo.md` 分别拥有，避免第二事实源。

## 6. AI 开发验证流水线

修改完成后运行：

```powershell
npm run agent:verify -- --scope <目标路径>
```

同一任务拥有整个工作树时可使用 `--changed`。执行器聚合所有命中 route，按首次出现顺序去重，并运行全部 blocking 命令；一个 blocking 失败不会阻止其余检查收集证据，最终统一返回失败。advisory 命令默认只显示、不执行；显式传入 `--include-advisory` 后才运行，且其失败不改变 blocking 结果。`--dry-run` 只输出计划，`--json` 提供机器可读报告。

该流水线负责机械路由、执行和证据汇总，不负责判断架构是否合理，不自动格式化、修改代码、提交 Git，也不自动调用 LLM、embedding、benchmark 或官方数据集。真实外部评估仍须用户或 Agent 明确选择。

## 7. 修改验证

普通产品改动至少运行目标测试、`npm run check`、`npm run test:product` 与 `npm run build`。文档按 [文档 CI 契约](../README.md#ci-contract)运行 `npm run docs:check`。仓库工具还运行 `npm run agent:context:check`；包边界运行 `npm run package:check`。

提交只包含本任务拥有的文件。工作区有用户或其他 Agent 修改时必须保留，不能为获得“干净”结果回滚它们。
