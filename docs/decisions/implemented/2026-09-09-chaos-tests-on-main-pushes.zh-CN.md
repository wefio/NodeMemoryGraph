# Windows 混沌测试只在推送到 main 时运行

[English](2026-09-09-chaos-tests-on-main-pushes.md) · [术语](2026-09-09-chaos-tests-on-main-pushes.terms.yaml)

**Status:** implemented  
**Approved:** unrecorded

## 问题

每个 PR 并行跑六个 CI job。最贵的是两个：product 套件（70–108s）与 Windows 混沌套件（58–101s）。混沌 job 跑在 `windows-latest` 上，GitHub 的计费是 Linux 的两倍。

而混沌 job 在 PR 上几乎从不报告任何东西。2026-08-21 至 2026-09-09 的 145 次 CI 运行中：

| job | 运行次数 | 失败 | 失败率 |
| --- | --- | --- | --- |
| Static and package contracts | 133 | 13 | 9.8% |
| Product tests and coverage | 132 | 6 | 4.5% |
| Node 22 compatibility | 152 | 5 | 3.3% |
| Research characterization（非阻塞） | 130 | 4 | 3.1% |
| Windows chaos tests | 153 | 1 | 0.65% |

那唯一一次混沌失败发生在 **`main`** 上（`chaos (22)` @ `53aa07d`），**PR 上从未失败**。窗口内 job 名字变过（`ci (22..24)`、`chaos (22..24)`、`Unit tests and coverage`），上表已合并。

这个测量本身就是全部论据。一个 153 次里只失败 1 次的检查，并没有在为 PR 把关，只是在为 PR 花一个双倍计费的 runner。

## 决策

`chaos` job 只在推送到 `main` 时运行。PR 跳过它，`all-checks-passed` 对**该 job**接受 `skipped`，所以 PR 仍然报告绿色聚合结果。在 `main` 上它仍然是必需项：`skipped` 只在 job 无法运行的地方被接受。

套件本身不变。`npm run test:chaos`、`verify:chaos` 与 `agent-context.yaml` 里的 `chaos` route 仍然是阻塞项；移动的只是 CI 的触发条件。

### 2026-11-05 修订：输入变了才跑

当初推迟的替代方案成为了规则。2026-11-03，一次 store 改动（`9d474b34`，legacy-tesserae 迁移）确定性地打破了 `chaos truncated active WAL`：迁移的回滚把 corruption 错误换成了 `no such savepoint: nmg_tessera_migration`，测试的期望永远匹配不上。`main` 一直红到 2026-11-05 修复落地。

0.65% 测的是**偶发**。它描述不了**确定性回归**——那种在有人修之前每次都失败、而恰恰是 PR 能拦住的一类。现在该 job 在推送到 `main` 时运行，也在 diff 触及 `src/core/store/`、`src/core/schema.ts`、`src/core/types.ts` 或 `tests/chaos/` 的 PR 上运行。

### 2026-11-05 修订：纯文档改动跳过代码 job

新增一个 `changes` job，只读一次 diff，发布 `code` 与 `store` 两个输出。如果 PR 的每个改动路径都是文字（`docs/`、`*.md`、`*.terms.yaml`、`README`、`AGENTS`、`LICENSE`、`CHANGELOG`），则跳过 `static`、`tests`、`node-compat`、`onlion` 与 `research-tests`，改跑一个 `docs` job：`docs:check`、`glossary:check`、`rtm:check`、`agent:context:check`、`check:policy-words` 与 `tests/docs`。`skills/` 与 `tests/` 在这里**不算**文字，因为 `tests/skills` 与 `tests/docs` 会校验它们。

`all-checks-passed` 读同一份 scope 输出：只有改动确实是纯文档时，才接受代码 job 被跳过；`changes` job 自己失败会让聚合失败，而不是被读成「没什么要检查的」。

## 考虑过的替代方案

- **继续每个 PR 都跑。** 否决：153 次里 1 次失败、且发生在 `main` 上，不足以支撑每个 PR 都用 Windows runner。
- **改成非阻塞（`continue-on-error`）。** 否决：非阻塞 job 照样消耗 runner，却完全不再为 `main` 把关。
- **只在与混沌相关路径有改动的 PR 上跑。** 2026-09-09 推迟，2026-11-05 采纳（见上方修订）：一次确定性的 store 回归进入了 `main`。**输入变了才跑对应检查**是更好的机制。
- **删掉混沌套件。** 否决：它抓到过真实缺陷（migration 失败时 SQLite 句柄未关闭，导致文件在 Windows 上被永久占用）。
- **改为把研究表征 job 挪走。** 不适用：它本来就是非阻塞的，而且 130 次里失败过 4 次。

## 验证

截至 2026-09-09 已验证：

- `chaos` job 声明了仅推送条件，PR 会跳过它。
- `all-checks-passed` 对 `chaos` 接受 `skipped`，于是 PR 仍报绿色，而 `main` 推送仍要求真实成功。
- `npm run test:chaos`、`verify:chaos` 与 `chaos` route 均未改动。

截至 2026-11-05（修订后）重新验证：

- `changes` job 从一次 diff 读出并发布 `code` 与 `store`；推送事件把两者都置为 `true`，所以 `main` 的行为不变。
- `store` 为 `true` 时运行 `chaos`；PR 这条路径由 truncated-WAL 修复本身验证——那次改动正好触及 `src/core/store/`。
- 纯文档 diff 选中 `docs` job 并跳过代码 job；只有 `code` 为 `false` 时 `all-checks-passed` 才接受代码 job 被跳过。
- `main` 没有分支保护，所以被跳过的 job 不可能阻塞合并；聚合结果是参考性的，真正报告的是上面那些 job。

## 未完成项

- 窗口只有 19 天、145 次运行。更长的窗口才能让 0.65% 这个数字更硬。

## 后果

- 除非触及 store 或混沌测试，PR 不再消耗 Windows runner。而在 `main` 上红了三天的那一类，现在会在引入它的 PR 上被抓住。
- 纯文档 PR 不再 build 产品、不再跑覆盖率套件；但它仍然跑完全部文档契约，所以文字改动不可能未经检查就进入。
- 代码改动的 PR 墙钟时间不变。各 job 并行，关键路径是 product job（70–108s），比 chaos（58–101s）更长。省下的是 **runner 分钟**，不是 PR 等待时间。
- PR 上的绿色 `All checks passed` 现在的含义是「这里**被要求**的检查都跑了且都过了」。要求什么由 scope job 决定，所以 scope 判断错了会显示在那个 job 的输出里，而不是靠猜。
