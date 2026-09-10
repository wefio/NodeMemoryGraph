# Windows 混沌测试只在推送到 main 时运行

[English](2026-09-09-chaos-tests-on-main-pushes.md)

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

## 考虑过的替代方案

- **继续每个 PR 都跑。** 否决：153 次里 1 次失败、且发生在 `main` 上，不足以支撑每个 PR 都用 Windows runner。
- **改成非阻塞（`continue-on-error`）。** 否决：非阻塞 job 照样消耗 runner，却完全不再为 `main` 把关。
- **只在与混沌相关路径有改动的 PR 上跑。** 推迟。**输入变了才跑对应检查**是更好的机制，如果真有混沌回归漏到 `main`，这就是天然的升级方向。
- **删掉混沌套件。** 否决：它抓到过真实缺陷（migration 失败时 SQLite 句柄未关闭，导致文件在 Windows 上被永久占用）。
- **改为把研究表征 job 挪走。** 不适用：它本来就是非阻塞的，而且 130 次里失败过 4 次。

## 验证

截至 2026-09-09 已验证：

- `chaos` job 声明了仅推送条件，PR 会跳过它。
- `all-checks-passed` 对 `chaos` 接受 `skipped`，于是 PR 仍报绿色，而 `main` 推送仍要求真实成功。
- `npm run test:chaos`、`verify:chaos` 与 `chaos` route 均未改动。

## 未完成项

- 窗口只有 19 天、145 次运行。更长的窗口才能让 0.65% 这个数字更硬。
- 受影响路径触发未实现。

## 后果

- PR 不再消耗 Windows runner。但混沌回归现在可能在被发现之前就进入 `main`，`main` 可能在合并后变红；真发生的话，受影响路径触发就是要补的缓解措施。
- PR 的墙钟时间不变。各 job 并行，关键路径是 product job（70–108s），比 chaos（58–101s）更长。省下的是 **runner 分钟**，不是 PR 等待时间。
- PR 上的绿色 `All checks passed` 现在的含义是「这里**被要求**的检查都跑了且都过了」。这个聚合在 PR 上比在 `main` 上弱——在 `main` 上混沌仍是必需项。
