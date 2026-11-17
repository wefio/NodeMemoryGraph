# OmniMemEval 集成

[English](README.md) · [术语](README.terms.yaml)

OmniMemEval 的用户记忆评测通过 NMG 适配器向 NMG HTTP 服务发送 Add 和 Search 请求。数据集解析、生成答案、评分、检查点和报告由 OmniMemEval 负责。[NMG HTTP 服务部署](../../onlion/README.zh-CN.md)

## 通过 NMG HTTP 运行 LongMemEval

首次安装时，在配有 Node.js、Git、uv 和 Python 3.12 的 Bash 环境中，从 NMG 仓库根目录开始。初始化命令检出固定版本的上游套件，并为官方评分器另建 Python 3.11 环境。下面的 Python 3.12 环境供上游套件使用。

```bash
npm run benchmark:setup
npm run benchmark:install:omni-adapter
cd .benchmarks/official/OmniMemEval
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install -r requirements_user_memory.txt
```

已有准备好的检出时，从 NMG 根目录运行 `npm run benchmark:install:omni-adapter` 即可更新适配器。
Windows 上使用 WSL 里的 Bash 和 Python。按固定版本的上游 README 准备数据集，在 OmniMemEval 检出目录创建私有的 `.env.aml`，配置答题和评分模型。通过进程环境提供 `NMG_OMNI_API_TOKEN`。

```bash
export NMG_OMNI_API_URL=https://your-memory-service.example
export NMG_OMNI_API_NAMESPACE="omni-lme-$(date -u +%Y%m%dT%H%M%SZ)"

bash scripts/run_lme_eval.sh --lib nmg --env .env.aml \
  --version "$NMG_OMNI_API_NAMESPACE" --clear 0 --streaming 0
```

示例会运行完整套件，结果写入 `results/lme/nmg-<version>/`。仅执行 Add 和 Search 时，加上 `--to-step 2`。其他参数见上游脚本的 `--help`。每次独立实验使用新的命名空间。续跑 HTTP 实验时沿用该次运行的命名空间、版本、端点和数据集设置，并使用上游的检查点选项。

适配器支持非流式 Add 和 Search。自动删除及 HaluMem 操作级评分目前不可用，因此保留 `--clear 0` 和 `--streaming 0`。测试数据会留在所选的 NMG HTTP 服务上。

## 集成边界

安装器向 OmniMemEval 注册 `nmg` 客户端，并随客户端安装共享的时间展示策略。[安装器](install-adapter.ts)

客户端要求 HTTPS，回环地址可用于本地测试。它拒绝重定向，并在评测用户 ID 前加上 `NMG_OMNI_API_NAMESPACE`。Add 发送由内容生成的请求 ID，并核验同步回执和原样返回的标识。Search 保留服务排序、遵循 `top_k`，并为上游答题模型渲染文本。记忆抽取、检索和向量配置由 NMG HTTP 服务负责。[HTTP 客户端](nmg_client.py)

Add 保留消息源和会话时间。Search 使用 `event_time` 展示时间，只有字段缺失时才读取兼容别名 `created_at`。显式 null 表示时间未知，已展示的前缀不会重复。结构化响应保留原字段和未渲染的证据。[共享时间证据策略](../../docs/design/design/progressive-retrieval.zh-CN.md#时间证据展示)

传输错误包含请求关联信息、耗时、HTTP 状态和限长的响应体，服务令牌会被脱敏。[HTTP 传输合同测试](../../tests/evals/omnimemeval-http-client-contract.py)

## 历史评测结果

反向检索、BGE、PersonaMem v2、LoCoMo 和 BEAM 等本地 SQLite 测量使用了归档中的实现。与 NMG HTTP 结果比较时，以记录中的运行设置和证据为准。[评测结果](../../docs/experiments/benchmark-results.zh-CN.md) · [归档评测指南](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/omnimemeval/README.zh-CN.md)

要诊断已经完成的评测，使用[研究工具](research/README.zh-CN.md)。匹配无记忆基线用于内部对照，严格证据审计单独报告精确文本覆盖率。
