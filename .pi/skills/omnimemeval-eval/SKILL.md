---
name: omnimemeval-eval
description: Run OmniMemEval benchmark evals (LongMemEval 500, PersonaMem-v2 quick 60, LoCoMo) and no-regression verification against baselines. Use when the user says run the eval / benchmark, 跑评测, 防回退, no-regression, or names lme / pmv2 / locomo / LongMemEval / OmniMemEval.
---

# OmniMemEval 评测（LME / pmv2 / locomo）

评测的主流程、version 约定、防回退验证与踩坑清单。**目标是每次一遍过**——跑之前先读本 skill 核对参数，别边跑边发现。

## 0. 前置环境（每次确认）

**跑任何评测前先执行环境检查**（一键）：
```bash
bash evals/omnimemeval/check-env.sh   # GPU / CUDA torch / bge-server device / env / wrapper / 残留进程
```

- **bge-server**（embedding，8000 端口）必须活着：
  ```bash
  curl -s localhost:8000/health   # 期望 {"status":"ok","device":"cuda"}
  # 启动（用评测 venv 直接跑——别用 uv run 临时环境！）：
  cd evals/omnimemeval && ../../.benchmarks/omni-venv/Scripts/python.exe bge-server.py
  ```
  - **教训**：`uv run --with sentence-transformers...` 临时环境 = CPU torch + 每次重新解析/构建
    （还撞 cp313 无 cu121 wheel）——**浪费且慢**；`omni-venv`（评测 venv）**早有 CUDA torch**
    （2.13+cu132，cuda: True）——直接复用。fastapi/uvicorn 已补装到 omni-venv。

### uv / GPU 环境速查（"uv 跑过 GPU 为什么每次重搞"的答案）

- **GPU 检查用 nvidia-smi 一查就清楚**：
  ```bash
  nvidia-smi | grep "CUDA UMD"        # 驱动支持的 CUDA 版本（本机 13.3）
  nvidia-smi --query-gpu=name,driver_version --format=csv  # 3060 Laptop / 610.88
  ```
  → **torch 装 cuXX 要匹配驱动**（本机装 cu132，不是 cu121）——`torch.version.cuda` 应 ≤ 驱动 UMD。
- **uv 的现实**（uv 0.12+）：
  - `uv python find` → 默认 python **3.13.5**——**cu121 index 无 cp313 wheel**（torch 2.5 时代）——
    之前 `uv run --index cu121 --with torch` 解析失败就是这原因；cu132 才有 cp313 wheel。
  - `uv run --with` 是 **ephemeral 临时环境**（cache 里 `.tmpXXXX/`）——每次重建、每次重新解析；
    wheel 缓存持久（`uv cache dir`，archive-v0/ 里有 torch 2.13.0）但不自动复用（index 不同 → pypi CPU torch）。
  - **正解**：固定环境（omni-venv 或 `uv venv --python 3.12` + `uv pip install torch --index https://download.pytorch.org/whl/cu132`）——
    一次装好，之后直接 `.../Scripts/python.exe` 跑，不再每次 uv run。
- **env 文件**：`.env.nmg-bgefix`（OMNI_DIR 下，wrapper log 第 2 行 "Using env file:" 可确认实际加载路径）
  - LLM key：`ANSWER_API_KEY`/`EVAL_API_KEY`（bridge 的 LLM judge/answer 用）
  - **嵌入配置（语义检索必需，README §嵌入）**：
    - `NMG_EMBED_BASE_URL=http://127.0.0.1:8000/v1`——**必须带 `/v1`**（bge-server 监听 `/v1/embeddings`；缺 `/v1` → client 建不出 → 评测退化成纯词法，Dynamic Update 记忆永不召回）
    - `NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5`、`NMG_EMBED_PROFILE=bge-en`、`NMG_EMBED_API_KEY=dummy`
    - `NMG_QPP_SECOND_PASS=0`（评测关 secondPass）
  - **坑**：`OMNIMEMEVAL_ENV_FILE` 是坏路径（反斜杠丢失 `C:Documents...`）——无害但别修到依赖它；改嵌入配置后**必须验证语义生效**（见 §7 基建节）
  - 嵌入生效验证：重放 searchContext（打开 store + `createEmbeddingClientFromEnv`）——promotion 记忆应排第 0；或直接看评测 env 里 `load_dotenv` 后 `NMG_EMBED_BASE_URL` 是否含 `/v1`
- **不要直接跑官方脚本**——只通过 wrapper（固化 PYTHONUTF8/PYTHONIOENCODING/NMG_ROOT/kill_strays）：
  - LME：`bash evals/omnimemeval/run-lme.sh`
  - pmv2：`bash evals/omnimemeval/run-pmv2-quick.sh`
  - locomo：`bash evals/omnimemeval/run-locomo.sh`；halumem：`bash evals/omnimemeval/run-halumem.sh`
  - 直接跑官方 `run_*_eval.sh` 会丢 PYTHONUTF8 → rich emoji 打印 GBK 崩溃（Windows）

## 1. Version 约定（最容易踩——漏前缀 = 废结果）

**version 决定 store 的 userId label 和结果目录名**。防回退重跑必须与基线**完全一致**：

1. 先找基线目录：`ls .benchmarks/official/OmniMemEval/results/lme/`
2. **核对基线 VERSION**：`cat results/lme/<基线目录>/experiment_config.sh`（如 `VERSION="lme500_bgefix_header_20260804"`——**含 lme500 前缀**）
3. 原样复制：`--version lme500_bgefix_header_20260804`

漏前缀（如传 `bgefix_header_20260804`）→ store 不匹配 → search evidence 全空 → **recall 0 的废结果**，且写到错误目录（`nmg-bgefix_...` vs `nmg-lme500_...`）。

## 2. 防回退流程（LME）

```bash
# 1) 备份基线（结果会被覆盖）
cp -r .benchmarks/official/OmniMemEval/results/lme/nmg-lme500_bgefix_header_20260804 \
      .benchmarks/official/OmniMemEval/results/lme/_bak_bgefix_header_20260804
# 2) 同 version 重跑（--skip-ingest 复用 store；answer/judge 断点续跑）
bash evals/omnimemeval/run-lme.sh --env-file .env.nmg-bgefix \
  --version <与基线一字不差的 version> --skip-ingest --llm-workers 16
# 3) 对比 manifest
python -c "import json; m=json.load(open('.benchmarks/official/OmniMemEval/results/lme/<基线目录>/experiment_manifest.json',encoding='utf-8')); print(m['results'])"
```

**判定标准**：
- recall 三项（any/evidence/all_evidence）**必须逐位一致**——检索无回退的硬标准
- answer_accuracy **±2pp 内 = judge 波动**（实测同 answer 重判 28/498 = 5.6% 判定翻转）

### 断点续跑机制（官方自带）
- `nmg_lme_responses.json`（answer 500 全 → 跳过）；`nmg_lme_judged.json`（judge 已判定 → 跳过）
- 失败重跑会重跑 search（~2 分钟）但 answer/judge 只补缺的
- **输出确认**：日志出现 `Skipping N already-evaluated users` + `Generating responses 500/500` 才是 resume 成功

## 3. 跑得慢？先查 dump（性能修复后 ~200 倍）

**历史**：answer 500 问 3 小时 → 54 秒；judge 152 问 13 秒。真凶不是 429（16 并发实测 9.3 req/s 零错误）而是：
- `scripts/longmemeval/lme_responses.py` + `lme_eval.py`：每完成一问就 `atomic_json_dump` 全量重写结果文件（873KB+ fsync）
- 修复已推送到 fork 分支 `fix/eval-checkpoint-batching`（`5b6c0d9`）：批量 checkpoint 25 问一次
- 若重跑变慢：确认 fork 的该分支代码在位（`grep CHECKPOINT_EVERY scripts/longmemeval/lme_eval.py`）

**judge 崩溃修复**：`scripts/utils/nlp_metrics.py` 的 `extract_label_json` 曾要求 `}` 紧跟 label 值——LLM 返回 `{"label":"WRONG","reason":...}` 多字段时 2/500 失败——现容忍多字段/代码块/单引号。

## 4. 坑表（Windows + 官方评测）

| 坑 | 现象 | 解法 |
|---|---|---|
| GBK 崩溃 | `UnicodeEncodeError: 'gbk' codec`（rich emoji） | 只走 wrapper（PYTHONUTF8 已设）；直接跑官方脚本必崩 |
| version 漏前缀 | recall 0、目录错乱 | 跑前 `cat experiment_config.sh` 核对 |
| 全量误跑 | pmv2 跑 5000 问（每问跨 ~94 行 JSON 引号字段） | 截断 csv 按问题切分（`run-pmv2-quick.sh` 已做）；`--end-idx` 仅流式生效 |
| SQLite 锁 | `database is locked` / `WinError 5 os.replace`（~0.4%/3200 并发） | 自动重试 3 次（wrapper 已做）；跑前 kill_strays 清锁 |
| --lib nmg 缺失 | `Error: --lib is required` | normal mode 必须传 `--lib nmg` |
| 结果目录混淆 | `nmg-bgefix_` vs `nmg-lme500_` | version 一字不差；误跑目录删除（rm -rf） |
| judge 判崩 | `could not extract judge label` | 提取器已修（容忍多字段） |

## 5. pmv2 速跑（60 问验证）

```bash
bash evals/omnimemeval/run-pmv2-quick.sh   # 已固化：截断 csv + 重试 + trap 恢复
```
- 60 问波动 ±5% 正常（选项设计 + LLM 随机）；泄漏指标 0-4/11 不可靠——**定案基于语义不基于泄漏数字**
- forget 渲染定案：`[forget] (content withdrawn)` + 完整元数据（id/node/type/matches/time）；不给 statement 原文；nmg_get 主动查询仍返回原文

## 6. locomo（2026-08-05 实测完成）

```bash
# 全量跑（10 对话样本 ≈ 1540 问——ingest+search+answer+judge 一体，~4 分钟）
bash evals/omnimemeval/run-locomo.sh --env-file .env.nmg-bgefix --version locomo_bgefix_20260805 --llm-workers 16
# 分析已有跑（search evidence audit——官方口径）
bash evals/omnimemeval/run-locomo.sh --analyze <results-dir>
```

- 数据：`data/locomo/locomo10.json` = 10 对话样本 ≈ **1540 问**（不是 233！）
- 无截断问题（10 样本全量）；其余坑同第 4 节表（--lib nmg/GBK/锁）
- 官方脚本 `scripts/run_locomo_eval.sh`（steps 1-6 同 LME）；wrapper 见 `evals/omnimemeval/run-locomo.sh`
- **实测（2026-08-05，version `locomo_bgefix_20260805`，commit 66e4555）**：
  - 全流程 ~4 分钟（1540 问 search/answer/eval 全 success 零失败）；context tokens avg 1723
  - **LLM-as-Judge 0.7110**（分类：single hop 0.769/841、temporal 0.707/321、multi hop 0.599/282、open domain 0.542/96）
  - **检索（audit-locomo-official.py 官方口径）**：any 72.7% / overall 56.7%（records 模式 k20）——
    对比旧 records_k20（68.6%/53.0%）：**+4.1pp——无回退且改进**
- **WinError 5 重试**：locomo answer 阶段撞过一次（os.replace 被 Defender 锁）——
  已在 fork 的 `scripts/utils/checkpoint.py` 加 `_replace_with_retry`（5 次退避）——**治本**
- **判定**：检索缺失型（cannot determine）是 NMG 真正负责的部分；judge 波动 ±0.05-0.08 算噪声
- 新基线：`results/locomo/nmg-locomo_bgefix_20260805/`（后续改动对比这个）

## 7. HaluMem（2026-08-05 实测完成）

```bash
# 小批量试坑（截断 jsonl 前 N 条——trial 粒度：1 条 ≈ 164 问）
# 全量（20 persona ≈ 3467 问，GPU 下 ~40 分钟：answer 5m54s + judge 15m46s）
bash evals/omnimemeval/run-halumem.sh --env-file .env.nmg-bgefix --version halumem_20260805 --workers 2 --llm-workers 16
```

- 数据：`data/halumem/HaluMem-Medium.jsonl` **当前是单 persona（164 问，trial 截断遗留）**；全量 20 persona ≈ 3467 问在 `HaluMem-Medium.jsonl.bak`（每行一个 persona，`total_question_count` 合计 3467）。trial 用当前 medium（1 条），全量需先 `cp .bak` 恢复（或直接跑 long 变体）；另有 long 变体
- **测什么**：操作级幻觉（记忆提取/更新/QA 三操作 + 干扰内容鲁棒性）——与我们 forget/脱敏工作相关（Memory Boundary/Conflict 题型）
- 产物前缀 `nmg_hm_*`（hm 不是 halumem！）；`--variant medium|long` 默认 medium
- **trial（164 问）**：一次跑通零新坑（wrapper 复用成型）；截断 jsonl 前 N 条做 trial（备份 .bak 恢复）；无 audit 脚本——看官方 exp_report.md
- **全量（3467 问，version `halumem_20260805`）**：QA Accuracy **0.6873** 全 success 零失败——
  题型：Memory Boundary **0.981**（828——最强，印证元数据/边界语义）/ Conflict 0.875 / Generalization 0.530 /
  Basic Recall 0.503 / Multi-hop 0.429 / **Dynamic Update 0.239**（180——最弱，记忆更新场景可挖）；难度 easy 0.733 / medium 0.624 / hard 0.684
- 对比：trial 0.750（164 问）vs 全量 0.687——小样本虚高规律
- 新基线：`results/halumem/nmg-halumem_20260805/`（后续改动对比这个）

### 评测基建优化（2026-08-07，supersession 线验证）

- **judge 降频**：bridge 只对强候选（`DuplicateCandidate.priority ∈ {transition,polarity}`）调 LLM judge——单条 ingest 2min（vs 10min）；弱 token 候选大多是 keep。强候选 = 转换结构/极性 flip——恰是动态更新场景
- **前缀稳定**（LLM 上下文缓存）：answer 拆 `HM_ANSWER_SYSTEM`（固定前缀）+ `HM_ANSWER_USER`（context/question）——DeepSeek 缓存命中 system 前缀（ANSWER cache-hit **39%**，2.9M→1.15M cached）
- **缓存字段**：DeepSeek 返回 `input_tokens_details.cached_tokens`（Responses 兼容）——**不是** OpenAI chat 的 `prompt_cache_hit_tokens`（读错 = 0）
- **完成检测**：`judged.json` **分批写**——中途出现 ≠ 完成——应数 judged 问数达到全量（3467）再判完成；`--from-step 4` 可 resume judge
- **全量结果（supersession_trial11）**：0.687 → **0.734**（+0.047 无回退）——Dynamic Update +0.122（0.239→0.361）、Multi-hop +0.146、Basic +0.129、Generalization +0.095；Memory Conflict -0.074（supersession 过滤旧值 → Conflict 题缺旧值信息，整体净提升可接受）
- **单条 2 分钟（trial10）**：降频后单条（164 问）约 2min 完成——快速试坑优先单条，全量最后确认
- **嵌入修复（2026-08-07，trial16）**：OMNI_DIR/.env.nmg-bgefix 的 `NMG_EMBED_BASE_URL` **缺 `/v1`**（README 663 行是对的）→ 评测一直跑**纯词法**（promotion 词法 0 永不进候选——halumem 历史分数 0.687/0.734 全是纯词法）。加 `/v1` 后 `createEmbeddingClientFromEnv` 建出 client（重放 promotion 排第 0）。**注意**：bridge 检索还带 `sourceActor=prefersAssistantEvidence(q)?undefined:"user"`——user 过滤下 promotion 可能仍被挤出 top-k（2026-08-07 待定位）

### opencode 接入 + 编组批量（2026-08-08，supersession_trial19 验证）

- **V4 思考模式坑（必须显式关）**：DeepSeek V4（deepseek-chat / opencode deepseek-v4-flash）**默认思考**——不显式关，每个请求先出 `reasoning_content`，content 可能为空（解析失败）+ 慢。关法：
  - python openai 库：`extra_body={"thinking": {"type": "disabled"}}`——**直接传 `thinking=` 参数会 TypeError**（openai 库不认扩展参数）
  - TS judge-provider：thinking=false 时也要**显式** `body.thinking = {type:"disabled"}`（V4 服务端默认开；只加 enabled 不关 = 慢）
- **opencode 接入**：`OMNI_DIR/.env.nmg-opencode`（含 OPENCODE key，**本地不提交**——gitignore `.env.*`）：`ANSWER_BASE_URL=https://opencode.ai/zen/go/v1` + `ANSWER_MODEL=deepseek-v4-flash`（EVAL 同）——覆盖全部 3 个 LLM 点（bridge judge fallback 链 + answer + eval）
- **judge 加速**：HM_JUDGE_PROMPT 只输出 `{"label":...}`（去掉 "explanation + label" 句——extract_label_json 只取 label，安全）+ `max_tokens=128`（label ~20 token，128 留余量防模型多写被截断）
- **自适应并发**：`llm_client.py` 的 `AdaptiveConcurrency`（429→并发×0.7 最小 1；连续 20 成功→+1 恢复 max）替换 `asyncio.Semaphore`（hm_responses/hm_eval）——opencode 量大用满、429 自动降
- **编组批量**（`evals/omnimemeval/run-halumem-batch.sh`）：20 user 分批（默认 2 user/批）ingest+search，search 结果**追加聚合**（读旧文件 + update 合并——同 version 累积），最后统一 answer/judge（checkpoint resume 幂等）。参数 `--users/--start-user/--batch-size/--start-batch/--ingest-only`；中途 Ctrl-C 可停，`--start-batch N` 续跑
  - **step markers 坑**：官方脚本每 step 写 `.step_N_done`——分批跑 batch 2+ 会被 "already done, skipping" 直接跳过（0s 白跑）。批量脚本每批必须 `--from-step 1`（清 markers 强制重跑 step 1-2；start-user 偏移保证不重复 ingest）
- **全量真值（supersession_trial19，嵌入生效 + supersession + 时间排序）**：QA Accuracy **0.7352**（3467 问/20 user，search/answer/eval 全 success 零失败）——**与纯词法 0.734 持平**（嵌入全量无显著提升但无回退）；Dynamic Update **0.444**（supersession 最强项，比 trial11 0.361 高）；Memory Boundary 0.984；t16 的 0.823 是小样本虚高
- **全量耗时**：~44min（ingest ~34min + search ~3min + answer 8min + judge 9min，opencode 关思考）——比 trial18（60min 还 6/20 失败）**快且稳**；Add latency avg 3.0s（LLM judge 强候选仍主导）、Search 88ms（GPU 本地嵌入）

## 8. 结果与判定速查

- LME 基线（2026-08-04，commit 82ec4c7）：94.15 / 87.95 / 82.67 / answer 82.33
- LME 防回退（2026-08-05，commit bbbeb32）：recall 三项逐位复现；answer 80.8（-1.53pp，judge 波动内）→ **无回退**
- 结果目录：`.benchmarks/official/OmniMemEval/results/lme/nmg-lme500_bgefix_header_20260804/`（备份 `_bak_bgefix_header_20260804`）
- 文档配套：`docs/lme-eval-notes-2026-08-05.md`、`docs/pmv2-eval-forget-design-2026-08-05.md`
