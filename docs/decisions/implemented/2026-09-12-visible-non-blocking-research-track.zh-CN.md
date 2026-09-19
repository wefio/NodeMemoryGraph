# 非阻塞的轨道也必须可见

[English](2026-09-12-visible-non-blocking-research-track.md)

**Status:** implemented
**Approved:** unrecorded
Date: 2026-09-12
Branch: feat/ci-visible-research-track

## Problem

`research-tests` 这个 job 带 `continue-on-error: true`，设计文档（`docs/design/ci-cd-and-quality.md`）把它描述为
非阻塞的研究/benchmark 表征轨道。**故意非阻塞**没有问题。问题在于 `continue-on-error` 同时让这个 job **永远显示绿色**：
研究验证可以一直失败而没有任何人被告知，而且任何一次运行的结果都无法与"这个 job 从未执行"区分开。
这与我此前修的复杂度门（打印 `no changed files` 然后退出 0）是同一类缺陷：一个无法区分"检查过且干净"和"从未看过"的信号。

同一次复查还发现第二处更安静的同类缺口：CI 运行哪些测试是**手工维护的 glob 列表**（写在 npm scripts 里），
于是套件可以整体落在任何 job 之外。已经有一例：`evals/ooo-execution/*.test.ts`（12 个文件）没有任何 job 运行；
另有一处在 `tests/lab/` 下正以同样方式漂移。

## Decision

非阻塞是**分支保护**的属性，不是 workflow 的属性。因此：

- `research-tests` 保持非阻塞——它仍然不在 `all-checks-passed` 里，而后者仍是唯一被聚合的必需检查——但去掉
  `continue-on-error`，于是它的真实结果会以红色 check 出现在 PR 上，而必需的聚合检查仍然绿。
- 一个必需检查（`npm run ci:uncovered-tests`，放在 `static` job 内）从各 job **实际调用**的 glob 推导出
  "没有任何 job 覆盖的测试文件"。`evals/` 下（研究 harness）可以按需保留；其余一律失败关闭并指名文件，
  直到被覆盖或被**显式登记**（理由写在工具里）。
- 未覆盖套件由独立 workflow 按需运行（`.github/workflows/on-demand-suites.yml`，仅 `workflow_dispatch`），
  在 Linux 与 Windows 上以 `--test-concurrency=1` 跑，并把 TAP 逐字记录作为 artifact 上传。

## Alternatives considered

- **保留 `continue-on-error` 并加 warning annotation。** 否决：注解只存在于运行内部，job 在每一份检查清单里仍然是绿的。
  要点就是：只看检查清单的人不该被告知假话。
- **把研究轨道改成必需检查。** 否决：它表征的是 benchmark adapter，可能慢且依赖环境；既有的"保持非阻塞"决定仍然成立。
  把它变成阻塞，只是把一种假话（永远绿）换成另一种（一个说"不要合并"的红色必需检查，而它并不是合并阻塞项）。
- **把研究 job 拆进独立 workflow。** 否决：是否必需由 `all-checks-passed` 与分支保护决定，所以在现有文件里就能得到
  "可见但不必需"的同样结果，且机械更少。
- **用扩大研究 job glob 的方式处理未覆盖套件。** 否决：OoO 套件会驱动真实 worktree、真实子进程与真实多进程黑板，
  且是跨平台的；目前观察到的两次 flake 都是加载敏感的。把它们混进表征 job 只会让两条轨道的失败信号都更浑浊。
- **每晚定时跑未覆盖套件。** 操作者否决：按需触发足够，而一个没人看的定时任务只是又一个"看起来是绿的"的非信号。

## Consequences

- 研究轨道的失败现在在 PR 上可见，而可合并性不变。
- 测试套件不再能悄悄掉出 CI：要么有 job 覆盖它，要么覆盖检查失败并指名它，要么它位于 `evals/` 下
  （已登记，理由在工具里）。
- `tests/lab/relevance-model.test.ts` 是在它**还未提交**时被这个检查发现的，这也是覆盖检查只评判**已跟踪**文件的原因：
  在飞的改动还不算仓库的一部分。
- 未覆盖套件只在有人触发 workflow 时才被测量。这是一个真实的限制：按需产物是"某次运行"的证据，不是常备保证。
