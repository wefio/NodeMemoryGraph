# 完整验证预算余量——2026-10-09

[English](full-gate-margin-2026-10-09.md) · [术语](full-gate-margin-2026-10-09.terms.yaml)

## 范围与先前证据

在 `eb093bf6a492d81d782d2a31ef1f26e80893fcf5` 上原有九路径 clean 验证两次超出未改动的
150,000 ms 总期限。该范围没有 authored RCP contract，走直接 full plan 而非串行 RCP
provider。既有[原子检查](full-gate-atomic-checks-2026-09-23.zh-CN.md)与
[并行静态检查](full-gate-parallel-static-2026-09-23.zh-CN.md)优化仍在；
新检查此前未列入获准并发集合。

不重新引入固定分区：[分区 probe](product-file-partitions-2026-09-23.md#limits-and-next-decision)
记录了复现失败与候选移除。

## 产品阶段比较

同一原始源码、Node v24.19.0、Windows、同一 1,675 项产品测试 inventory。
普通四 worker 命令以 101.625 秒通过；只把 Node 文件 worker 上限改为八后，以
58.799 秒通过。Node 自报分别为 100.657、58.704 秒。
四 worker 走 npm，八 worker probe 直接调用 Node，外层耗时有不同启动开销。
两者的失败、取消、跳过、todo 均为零；不删除测试、编译范围、断言或清理。
它们是工作站上串行执行的阶段样本，不是隔离 CPU benchmark 或整轮性能保证。

## 候选

- 保留完整验证成员与 150,000 ms watchdog／期限。
- 把只读 `check:tests`、`mutation:anchors`、`check:policy-words` 加入既有相邻静态
  batch，最多三个异步检查。
- 产品测试使用八个 Node 文件 worker，glob 完全不变；coverage 仍用两个 worker、
  同一文件 inventory。
- 保留 build／package／product 屏障、逐项失败归因与声明顺序结果；
  RCP／narrow 执行策略不变。
- 聚焦契约验证准确批准集合、有界执行、无 writer 重叠、结果／失败完整、
  product／coverage 范围一致。

## 整轮证据

完整候选通过全部 16 个 blocking 检查与 1,678 个产品测试（原 1,675 加三项新契约）。
外层 npm、watchdog、worker 与 receipt 共 **129.072 秒**，
在未改动的 150 秒期限内剩 20.928 秒。worker receipt 从
2026-10-09T15:25:25.214Z 到 15:27:32.662Z；
run ID 为 `a30e1e55-b00a-4de3-8ba4-33bdfc888f2c`。

这是基于 `eb093bf6` 的 dirty pre-commit 运行，覆盖原九路径与八个自有实现／文档路径，
不是 clean receipt。该轮 product 为 75.731 秒而非独立阶段的 58.799；
静态竞争时 `check:tests`、lint、format 分别为 16.574、14.630、14.539 秒。
各项有重叠，不能相加为 wall time；配对阶段结果不能隔离每项优化对整轮的贡献。
research／chaos 与原命令一样，除显式要求外仍为 advisory 且跳过。

独立全量 mutation sweep 在 22/22 targets 上捕获 110/110 mutants，各目标逐字节还原，
退出零且无 mutation lock。[机器可读观测](full-gate-margin-2026-10-09.json)保留阶段耗时、
代码 hash 与 mutation 结果。post-commit clean 证据归其准确 HEAD 与范围，
在交付 PR 中和 forge CI 观测分别报告；此 dirty 报告不能代替这些回执。

## 限制

时间只适用于该机器与工作负载，不是任意负载或硬件的最坏情况保证。不使用缓存跳检、
测试分区、impact 子集、减少断言、放宽期限或削弱门禁。
官方 benchmark／provider／云工作负载不属于本实验。
