# CI 覆盖率检查认领归档运行目录

[English](2026-09-19-acknowledge-archived-run-directories.md)

**Status:** implemented
**Approved:** explicit

## 问题

`npm run ci:uncovered-tests` 会对每个"没有 CI job 覆盖、且不在已认领根之下"的 `.test.ts` 让
"Static and package contracts" 这个 job 变红。归档的运行目录不是套件：
`docs/experiments/execution/archive/ooo-arms-2026-09-19/` 保存的是那次实验被裁定所依据的候选树，
其中包含 `.test.ts`，因为这棵树就是那次运行的证据。5 个这样的文件让整个 job 变红，于是必需检查
报出的是假阳性，而不是真正的漂移。

## 决策

`tools/ci-uncovered-tests.ts` 的 `ACKNOWLEDGED_ROOTS` 增加
`docs/experiments/execution/archive/`，理由写在列表旁边：归档的运行目录保存的是它被裁定所依据的
候选树，是证据，不是任何人维护的套件。认领刻意采用前缀规则；将来的归档只有落在该根之下才自动
继承这条认领。

## 考虑过的替代方案

- 把归档文件放进某个 CI job：它们的 fixture 属于一次已结束实验中被否决的候选，job 会去断言一个
  已不存在于工作集里的树。
- 把归档挪到 `evals/` 之下：那是靠命名巧合获得认领，而工具自己的注释明确禁止这样做。
- 删掉归档里的 `.test.ts`：它们正是那次实验被裁定所依据的记录。
- 让扫描器单独跳过归档：同一个结果造出第二套"不算套件"的概念，而工具本来就有已认领根机制，
  并且要求写明理由。

## 后果

这个 job 之后只会因为真正落在所有 CI job 之外的文件而失败，这正是这条认领有价值的原因。放在
`docs/experiments/execution/archive/` 之外的归档仍需自己的条目，而保留它的理由就留在列表处，不必
去翻提交信息。
