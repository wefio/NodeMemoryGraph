# LongMemEval 重跑：recall-header 精化只涉及格式

[English](lme-recall-headers-2026-08-04.md) | [简体中文](lme-recall-headers-2026-08-04.zh-CN.md) · [术语](lme-recall-headers-2026-08-04.terms.yaml)

证据边界（2026-10-17 文档审阅）：本文是历史实验记录。下文的配置、测量、实现描述和后续建议均限于当时实验。本轮未重跑实验，也未独立复核原始产物；这些内容不是当前测试回执、默认策略决定或通用保证。

2026-08-04 的报告比较了 recall-header 精化改动之后的检索指标。改动包括（`819bd53`、`25a410f`、`1a6210b`：用 `matches=` 锚点代替机制描述，加入 event time 与 expiry 字段，精简的 `AG activeGraphId` 行，一行式字段图例）。报告在下文所述 bridge 路径上记录了不变的检索指标。run 时的 commit 为 `82ec4c7`；manifest 位于 `results/lme/nmg-lme500_bgefix_header_20260804/experiment_manifest.json`。

## 设置

- 配置：`.env.nmg-bgefix`（固定 top-20，`NMG_QPP_SECOND_PASS=0`，`NMG_EMBED_PROFILE=bge-en`，BGE-small 走离线 server）。
- 全流程 run（ingest → search → answer → judge）走新的 `evals/omnimemeval/run-lme.sh` 流程，`--workers 1`（并行的 bridge worker 会在 embedding-cache schema 锁上竞争），`--llm-workers 6`。
- embedding cache `1e9807091681`（bge-en）：复用 245,947 个 document 与 500 个 query；无需调用 server。

## 相对基线的结果（n=498 已判定；基线 n=500）

| metric | 08-03 基线 | 本次 run | delta |
|---|---|---|---|
| any-evidence recall | 94.15% | 94.15% | 0.00 |
| evidence recall（总体） | 87.95% | 87.95% | 0.00 |
| all-evidence recall | 82.67% | 82.67% | 0.00 |
| answer accuracy | 81.2% | 82.33% | +1.13 |

报告记录的检索指标逐位一致；其描述的 eval bridge 路径通过 `projectMemoryContext`（bridge.ts）构造上下文，不读取扩展的 `formatSearchHeaders` 输出。该对比没有执行或验证改动后的 Pi header renderer。answer accuracy 的差异不能归因于该 renderer；这次非配对运行也无法单独估计 LLM／API 波动。

## 途中落地的流程加固

- `evals/omnimemeval/run-lme.sh`：preflight（清理残留进程、固定环境变量、cache 覆盖检查）、带 version-keyed store 警告的 `--skip-ingest` 守卫、`--from-step` 断点续跑、`--prune-stores`（用户 store 以 `sha256(userId)` 为 key，而 userId 内嵌 version label，因此每次 run 都会留下约 500 个约 12 MB 的新 store；prune 将 eval 目录从 59 GB 降到 7.3 GB）、为 nltk 设置 venv PATH。
- `evals/omnimemeval/embedding-cache.ts`：在并行 bridge worker 引发的瞬时 SQLITE_BUSY 上重试 init DDL。
- `evals/omnimemeval/experiment-manifest.mjs`：每次 run 的 manifest，含 commit、prompt 模板哈希（retrieval guidance、LME answer／judge prompt、NMG policy 扩展）、runtime env 与 temperature、dataset sha256，以及带失败样本的 results。
