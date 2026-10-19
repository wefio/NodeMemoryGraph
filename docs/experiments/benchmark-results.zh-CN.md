# NMG Benchmark 结果

[English](benchmark-results.md) | [简体中文](benchmark-results.zh-CN.md) · [术语](benchmark-results.terms.yaml)

## 阅读历史快照

这是保留的部分实验快照，不是当前后端排行榜或新的复现。BEAM 版本标签含 `20260820`，
链对比标为 2026-08-16。本轮未重开运行产物、核实可变的官方结果 URL、测量 provider
成本或续跑。下述 embedding 守卫源码视图与这些历史分数分开。

NMG 在 [OmniMemEval](https://github.com/MemTensor/OmniMemEval) 用户记忆 benchmark 套件上的结果，按官方
[结果快照](https://github.com/MemTensor/OmniMemEval/blob/main/docs/user_memory/results.md)
的同一格式记录，使各行的结构可比。

记录中的状态：**partial**。BEAM 100K 被报告为在所列版本完成，其余套件保留下表的 checkpoint 状态。本轮文档审阅未重新确立当前进度、checkpoint 兼容性或精确续跑行为。

## 评测设置

| 组件 | 配置 |
| --- | --- |
| Benchmarks | BEAM 100K（已完成）；LongMemEval、LoCoMo、PersonaMem v2、HaluMem（进行中） |
| Answer model | `deepseek-v4-flash`（OpenCode Go），关闭 thinking，`max_tokens=1000` |
| Judge model | `deepseek-v4-flash`（与 answer 相同——见注意事项） |
| Memory embeddings | `BAAI/bge-small-en-v1.5`（本地服务）+ 内置 `nmg-hashing-v1` |
| Retrieval | Progressive `searchContext`，top-k 20，仅评测用的逻辑链注入，idtime 渲染（`<A:short-id> [time]` 行） |
| Primary metric | BEAM 使用 Nugget score；其他套件使用 LLM-as-a-judge 准确率 |

**可比性注意事项。** 官方 OmniMemEval 快照用 `gpt-4.1-mini`（answer）+ `gpt-4o-mini`（judge）复现所有 backend。NMG 的 run 使用另一对 answer／judge 模型，因此 NMG 各行不得被读作与官方表格的正面对比；它们是历史跟踪数字，不是模型／prompt／题目／成本均配对的比较。同模型回答／判定不提供独立验证。设置表中两个 embedding 名称也不证明逐输入路由或自动 provider 兜底。

## 结果汇总

| Backend | LoCoMo | LongMemEval | BEAM 100K | BEAM 10M | PersonaMem v2 | HaluMem |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **NMG（本次 run）** | pending | pending | **66.57 +/- 39.51** | - | in progress | pending |
| MemOS（官方参照） | 88.83 | 89.20 | 66.87 | 56.75 | 40.58 | 80.91 |
| Hindsight（官方参照） | 81.99 | 72.20 | 70.22 | 59.75 | 37.98 | 83.99 |
| Mem0（官方参照） | 77.68 | 56.00 | 70.41 | 43.33 | 36.76 | 73.64 |

官方参照行是在 gpt-4.1-mini／gpt-4o-mini 下复现的，仅用于标示数值量级，不作为直接对比（judge 模型不同）。

## BEAM 100K

所列 run 版本被报告为完整，本轮未在当前 checkout 重跑。BEAM 使用 nugget score（1.0 完全覆盖／0.5 部分／0.0 错误或缺失）。

- Version：`nmg_beam100k_full_curlogical_20260820`
- 问题数：400（20 段对话，每段约 128K tokens）
- 部署：local／self-hosted

### 复现结果

此处重复汇总表中的同一次历史运行，不是独立重复。本记录未定义 `+/-` 的统计量／聚合单位，
不得默认为置信区间。

| Backend | 部署 | 100K Nugget Score | 100K Context Tokens |
| --- | --- | ---: | ---: |
| NMG | local/self-hosted | 66.57 +/- 39.51 | n/a（未记录） |

### 维度细分

| 维度 | n | Nugget |
| --- | ---: | ---: |
| preference_following | 40 | 92.50 |
| instruction_following | 40 | 88.12 |
| information_extraction | 40 | 87.92 |
| summarization | 40 | 69.74 |
| contradiction_resolution | 40 | 66.25 |
| multi_session_reasoning | 40 | 64.32 |
| temporal_reasoning | 40 | 61.25 |
| abstention | 40 | 60.00 |
| knowledge_update | 40 | 55.00 |
| event_ordering | 40 | 20.61 |

### 链注入 A／B（同一 harness，2026-08-16 的 run）

在同一批 store 与参数上做仅评测用的逻辑链注入：

| 注入 | Nugget Score | event_ordering |
| --- | ---: | ---: |
| none | 65.68 +/- 39.34 | 18.92 |
| temporal | 67.55 | 21.73 |
| **logical（默认）** | **68.67** | 23.79 |
| both | 56.24 | 2.69（上下文膨胀） |

说明：
- 表中的 logical／默认标签是历史评测选择（相对 none 总体约 +3.0pp），不建立当前 bridge 或产品默认值。所读 bridge 仅在显式 `NMG_CHAIN_INJECTION=logical` 时选择逻辑注入，否则为 none；temporal／both 是旧试验行，不是当前入口选项。
- 表中 temporal 的 `event_ordering` 为 21.73，无注入为 18.92，所以“不能使它变化”并非表中数字的字面描述。这些运行不单独建立普适的叙事重建上限，也不证明时间信息冗余。原先理由还引用渲染实验（6 种模式，2026-08-16）与逐行 `[time]` 标签；这些分别的观察不是受控因果分解。原记录未继续追该方向；本轮不为 both 行的 `context bloat` 解释建立因果证明。A／B 样本量及可比离散度估计未提供。
- `summarization` 的 46.52 → 69.74 来自不同运行集合（2026-08-16 无链基线与本次完整 run），同时改动了注入与检索代码，不是单独的链效果。A／B logical 的 68.67 与完整运行的 66.57 是分开的读数，本轮未将其对账为重复实验。原记录仍认为在主张该增益前应重复确认；本轮既不提供该确认，也不授权执行。

## 进行中的套件

下表是报告中的 checkpoint 状态，不是新检查的续跑回执。本地 ingestion／search 仍消耗计算／存储，并可能调用已配置的 embedding provider；本地不保证货币零成本，answer／judge 阶段也需要各自的 LLM 预算：

| 套件 | 进度 | 续跑方式 |
| --- | --- | --- |
| LongMemEval（500 问） | ingestion+search 已完成（本地） | `run_lme_eval.sh --from-step 3` |
| LoCoMo（1,540 问） | 未开始 | `run_locomo_eval.sh`（先本地 ingest／search） |
| PersonaMem v2（1,315 问） | ingestion+search 已完成；113 个答案已 checkpoint | `run_pmv2_eval.sh --from-step 3` |
| HaluMem（Medium） | 仅有先前的试跑（2026-08-11） | 完整 run 待做 |

## 复现

保留的 shell 块是历史记录，不是当前 NMG 的常规入口。获授权的新运行／续跑须先遵循
[配置驱动工作流](../../.pi/skills/omnimemeval-eval/SKILL.md)，由其拥有 checkpoint／配置
检查及 runner 入口。下列命令可能执行付费 answer／judge 阶段；本轮文档审阅不授予运行
预算，也未执行其中任何命令。

```bash
# BEAM 100K (complete result above)
cd .benchmarks/official/OmniMemEval
PYTHONUTF8=1 NMG_CHAIN_INJECTION=logical \
  bash scripts/run_beam_eval.sh --lib nmg --env .env.nmg-opencode \
  --version <version-label>

# Remaining suites share the same entry points
./scripts/run_lme_eval.sh   --lib nmg --env .env.nmg-opencode --from-step 3
./scripts/run_locomo_eval.sh --lib nmg --env .env.nmg-opencode
./scripts/run_pmv2_eval.sh  --lib nmg --env .env.nmg-opencode --from-step 3
./scripts/run_halumem_eval.sh --lib nmg --env .env.nmg-opencode
```

NMG adapter bridge 位于 `evals/omnimemeval/bridge.ts`；每用户 store 在 `.benchmarks/omnimemeval-nmg/` 下，共享 embedding cache 为 `.benchmarks/shared-embedding-cache.sqlite`。

### Embedding 可用性契约

共享 cache 是加速层，不是 provider 的兜底。当配置的 embedding 服务离线时，一次精确 cache 命中仍可能成功，因此「部分行成功、部分行 `fetch failed`」的混合**并不**证明该服务在一次 run 中途才失败。在所读 [`runPlan()` 入口](../../evals/omnimemeval/run.ts)中，配置了 provider 时，入口在启动 runner 前尝试以一个 query 调用一次 `embedQueries`；客户端配置无效可在 provider I/O 之前失败。Cache-only 模式或未配置 provider 时跳过。探测成功只建立该时点的可用性，不保证整次运行健康，也不能假设每条历史上直接调用上游 shell 的命令都经过此守卫。

`NMG_EMBED_CACHE_ONLY=1` 是显式的离线例外。它禁用 embedding-provider I/O，只提供声明的 model／预处理 `indexId`、输入种类及文本哈希下的缓存向量。第一个必需 document／query 缺失会以 `embedding cache-only miss` 错误 fail closed；覆盖范围须包含该次运行需要的输入。部分 checkpoint 不是完整 benchmark 结果。这仅是 embedding 离线模式，不保证 answer／judge 或整次评测均无网络调用。
