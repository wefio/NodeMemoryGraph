# MiniMind-NMG Encoder — 专用向量模型设计（历史归档）

[English](minimind-embedder.md) | [简体中文](minimind-embedder.zh-CN.md) · [术语](minimind-embedder.terms.yaml)

> **状态：未采用，相关实现已于 2026-07-29 从主仓库移除。**
>
> 这份文档保留一个曾经认真探索、但没有达到采用标准的设计。方案尝试为
> NMG 训练一个约 30M 参数的专用双向文本编码器，并通过 ONNX 在 Pi 插件进程内
> 推理。原型证明训练、导出和调用链路可以搭建，但没有证明它比现成的小型
> embedding 模型更适合 NMG。
>
> 停止该方向的原因：
>
> - 训练数据准备、负样本构造、多语言覆盖、蒸馏、评估和部署形成了一个独立的
>   模型项目，超出 NMG 作为轻量 Pi 长期记忆插件的核心边界；
> - 当时可用的算力、数据质量和模型训练能力不足，实验效果没有达到替代 BGE
>   等成熟 embedding 模型的程度；
> - 专用模型增加了 PyTorch、ONNX、Tokenizer 映射和模型文件的维护负担；
> - NMG 当前的主要不确定性在记忆写入、图组织、检索和 QPP，而不是 embedding
>   模型本身；继续优化编码器无法优先验证核心价值。
>
> 因此，NMG 保留通用 `VectorEmbedder` 边界，优先使用现成模型或兼容 API。
> 本文以下内容是历史设计记录，不代表当前实现、路线图或已验证性能；其中提到的
> `minimind/`、`minimind-nmg/`、ONNX 适配器和测试路径均已删除，必要时可从 Git
> 历史恢复。

## 核心判断与设计原则

MiniMind 对 NMG 的价值不在于"现在是好向量模型"，而在于：
- 足够小（可反复消融实验）
- 结构透明（causal → bidirectional，LM head → embedding heads）
- 完整训练链路（pretrain → SFT → RL 全流程代码）
- 小词表优势（不像 multilingual 模型把大量参数浪费在词嵌入）

三条设计原则（分别借鉴 FlashKDA、FlashMLA、DeepEP 的架构思路）：

1. **状态更新应有明确的自由度设计。** 每个"状态从旧到新"的转变都应显式建模：吸收多少、保留多少、衰减多快。
2. **存储和计算可以不对称。** 持久化维度 < 计算维度，存小算大。
3. **最小资源占用是核心竞争力。** 图侧的资源消耗必须远小于 LLM 推理，让真正的瓶颈拥有尽可能多的资源。

## 总览：三层架构

```
┌─ MiniMind-NMG Encoder (ONNX, PyTorch 训练, 部署时冻结) ──────────┐
│  text → 双向 Transformer → masked mean pool → L2 → Float32[256]  │
│  部署: onnxruntime-node（Node.js 进程内，无 HTTP/IPC）             │
│  训练: PyTorch 离线，Qwen3-0.5B 教师蒸馏                           │
└──────────────────────────────┬───────────────────────────────────┘
                               │  Float32[256] L2
┌─ DifferentiableAdapter (TypeScript autodiff, 可训练) ────────────┐
│  Linear(256→128) → L2 normalize                                  │
│  ~33K 参数，与 Controller 联合 backward，同一个 UOp DAG              │
└──────────────────────────────┬───────────────────────────────────┘
                               │  Float32[128] L2
         ┌─────────────────────┼─────────────────────┐
         ↓                     ↓                     ↓
   HA (Hierarchical    MGR (MemoryGraph      Differentiable
    Activation)          Reasoner)             Controller
   g₁/g₂/g₃ + h₁/h₂/h₃  traverse / whatIf    expand/stop/budget
```

适配层保留的原因：
```ts
// 一次 backward 同时更新适配层和 controller
L_total = L_retrieval + λ * L_contrastive
loss.backward();          // 同一个 UOp DAG
gradientStep(embedderParams, lr_e);
gradientStep(controllerParams, lr_c);
```

## 图侧决定编码器需求

Read the complete responsibility: [图侧决定编码器需求](minimind-embedder/encoder-requirements.zh-CN.md).

## 模型配置

Read the complete responsibility: [模型配置](minimind-embedder/model-configuration.zh-CN.md).

## 架构改造（相比原生 MiniMind）

### 必须改

```
1. causal mask → bidirectional attention（借 dLM 思路）
   取消因果掩码，每个 token 看完整序列

2. LM head → encoder heads
   embedding head：   Linear(hidden, 256) → L2Normalize
   activation head：  Linear(hidden, 1) → Sigmoid

3. max_position_embeddings: 32768 → 2048（覆盖 p99+ 的长文本，保留 YaRN 用于训练时外推）

4. CE loss → ranking + distillation loss
   InfoNCE + pairwise ranking + teacher score MSE
```

### 尽量保留

```
RMSNorm  — 比 LayerNorm 更快
GQA      — 8 q_heads / 4 kv_heads，推理更快
SwiGLU   — 比 ReLU FFN 更好
Pre-Norm — 训练更稳定
QK Norm  — Qwen3 风格，训练更稳定
no bias  — Qwen3 风格，参数更少
```

### Pooling

- **masked mean pooling**（默认）：对有效 token 求均值，忽略 padding
- attention pooling（可选实验）：可学习权重
- 多层加权混合（可选实验）：如第 2、4、6 层的加权和

不推荐 last-token pooling：decoder-only 的最后一个 token 有位置偏差。

## Tokenizer 策略

| 阶段 | 方案 | 词表 | 说明 |
|------|------|------|------|
| Phase 1 | 完整 Qwen tokenizer | ~152k | 最快验证蒸馏效果 |
| Phase 2 | Qwen 兼容裁剪 | 24k-32k | 统计 NMG 语料 token 频率后裁剪 |

不同规模的代价（hidden=512, FP16）：

| 词表 | Embedding 参数 | 约占内存 |
|------|--------------|---------|
| 6,400 (MiniMind) | 3.3M | 6.5 MB |
| 24,000 | 12.3M | 24 MB |
| 32,000 | 16.4M | 32 MB |
| 152,064 (Qwen) | 77.9M | 156 MB |

Tokenizer 与模型分开部署——ONNX 只收 `input_ids` + `attention_mask`。

## 训练策略

### 数据策略：三阶段，零 benchmark 泄漏

```
Phase 1 ─ 标准公开数据集打底（不接触任何 benchmark）
  AllNLI (SNLI + MultiNLI): ~1M entailment pairs
  MS MARCO:                ~500K query-passage pairs
  DuReader / mMARCO-zh:    ~200K 中文 pairs
  → 纯对比学习：InfoNCE + pairwise ranking loss

Phase 2 ─ NMG 已有记忆库自监督（不碰 benchmark）
  从 SQLite 读取所有活跃节点
  Qwen3-0.5B 编码 → 相似度矩阵 → positive pairs (cos > 0.85)
                                 → hard negative pairs (0.6 < cos < 0.85)
  → 几百对，对 Phase 1 模型做 ranking distillation

Phase 3 ─ 真实轨迹积累后微调
  NMG 使用中自然产生检索反馈
  → 积累到几百条 used/unused 后做微调
```

### 教师：Qwen3-0.5B（仅 Phase 2）

已验证 Qwen3-0.5B > bge-small。Phase 2 中 Qwen3 仅用于计算 NMG 已有节点间的相似度，
不接触 benchmark。不蒸馏"通用语义"，而是蒸馏"Qwen 在 NMG 节点上的相似度排序"。

### 损失函数

```
Phase 1: L = L_contrastive + β·L_rank
Phase 2: L = L_contrastive + γ·L_teacher
Phase 3: L = L_contrastive + δ·L_behavior

L_contrastive: InfoNCE（used / similar > unused / dissimilar）
L_rank:        pairwise margin ranking
L_teacher:     MSE（student score ≈ Qwen3 score）
L_behavior:    交叉熵（预测"是否被使用"）
```

### 消融实验矩阵

| 版本 | Attention | 层数 | 输出 | 目的 |
|------|-----------|------|------|------|
| A | causal | 8 | 256 | 最小修改基线 |
| B | bidirectional | 8 | 256 | 测双向收益 |
| C | bidirectional | 6 | 256 | 测缩小后质量 |
| D | bidirectional | 4 | 128 | 测极限轻量 |

## 部署：ONNX Runtime Node.js

Read the complete responsibility: [部署：ONNX Runtime Node.js](minimind-embedder/onnx-deployment.zh-CN.md).

## 评价指标

不只记录通用 Recall@K，记录 NMG 专用指标：

```
Recall@K / MRR / NDCG
AG 最终有效节点召回率
无效节点注入率
重复检索率
平均编码延迟（batch=1, 4, 16, 64）
峰值内存
每秒编码节点数
```

最关键指标：**在固定上下文预算下，进入 AG 的节点中最终真正被使用的比例。**

## MiniMind 变体取舍

| 变体 | 取什么 | 舍什么 |
|------|--------|--------|
| **dLM** | 双向 attention、mask corruption 训练、AR→dLM 权重迁移 | 多步去噪、扩散生成 |
| **主线 Dense** | RMSNorm、RoPE、GQA、SwiGLU、完整训练链路 | causal mask、LM head、CE loss |
| **V (视觉)** | Projector 思想：不同模态→统一隐空间 | 视觉编码器 |
| **O (Omni)** | 共享主干+多头、中间层桥接 | 语音/视觉模块 |
| **Linear** | 长序列/流式状态（Phase 6 考虑） | 不用于当前节点编码 |

## 与现有系统的对接

### 替换路径

```
现有：OpenAIEmbeddingClient → Qwen3-0.6B（HTTP API）
                    ↓
过渡：OpenAIEmbeddingClient → localhost（MiniMind ONNX 兼容格式）
                    ↓
最终：onnxruntime-node → Encoder → Adapter → 128-dim L2 → HA/MGR/Controller
```

### 接口兼容

```ts
class MiniMindNMGEmbedder implements VectorEmbedder {
  readonly dimensions = 128;  // 适配层输出 = 图空间维度
  readonly model = "minimind-nmg-v1";

  embed(text: string): readonly number[] {
    const l2_256 = session.run(...);              // ONNX → 256-dim L2
    const l2_128 = adapter.project(l2_256);       // Linear → 128-dim L2
    return l2_128;
  }
}
```

### 联合训练

```ts
const encoderVec = session.run(...);              // Float32Array[256] L2，不参与梯度
const adapterOut = adapter.forward(encoderVec);   // UOp[128] L2，参与梯度
const haOutput = ha.propagate(adapterOut, ...);
const loss = controller.computeLoss(haOutput, labels);

loss.backward();  // 梯度流过 adapter + HA + controller
gradientStep(adapter.params, lr_a);
gradientStep(ha.params, lr_ha);
gradientStep(controller.params, lr_c);
```

## 不在第一版做的

- ❌ Tokenizer 裁剪（先用完整 Qwen 验证效果）
- ❌ Q/K/V 多向量（先验证 embedding + activation）
- ❌ 多类型节点 Projector（先用统一文本编码）
- ❌ Linear Attention（短序列 full attention 更快更简单）
- ❌ int8 量化（先 FP16 验证质量）
- ❌ MLA 式存储压缩（先做正确）

## 文件规划

```
minimind-nmg/                       # Python 训练/导出侧
  model/
    minimind_encoder.py             # ✅ 双向 MiniMind Encoder (6L/512h, FlashAttn)
    pooling.py                      # ✅ masked mean / attention pooling
  trainer/
    train_encoder.py                # ✅ 训练主脚本 (AMP, TF32, pre-tokenize)
    generate_synthetic.py           # ✅ 从本地文本生成训练对
    prepare_data.py                 # ✅ Phase 1 数据加载器
    data.py                         # NMG 轨迹 → 训练样本
  export/
    export_onnx.py                  # ✅ PyTorch → ONNX (dynamic batch)
  server/
    embed_server.py                 # ✅ 轻量 HTTP 服务 (调试用，生产不用)
  tokenizer/
    prune_qwen_vocab.py             # ✅ ID 映射生成（不修改 tokenizer）
  out/tokenizer/
    old_to_new.json                 # ✅ 151k→32k ID 映射表

src/core/
  onnx-minimind-embedder.ts         # ✅ ONNX 进程内推理
scripts/
  test-onnx.ts                      # ✅ 原始 ONNX runtime 测试
  test-embedder.ts                  # ✅ Embedder 封装 + Python 对比测试

docs/
  minimind-embedder.md              # 本文档
  hierarchical-activation.md        # HA + MGR 推演设计
```

## 实施路线

```
✅ Phase 0 ─ 管线验证
  ✅ 训练脚本 + 合成数据 (5877 对, 5 epoch)
  ✅ 词表裁剪 (151k→32k, ID remap)
  ✅ ONNX 导出 + FP16
  ✅ Node.js 进程内推理 (onnxruntime-node)
  ✅ BEAM benchmark 验证 (nmg-graph 0.66)

□ Phase 1 ─ 标准数据打底
  □ 加载 AllNLI + MS MARCO + DuReader（零 benchmark 接触）
  □ max_length=512/2048 训练（需更大 GPU 或 cloud）
  □ 更多 epoch + 更大 batch

□ Phase 2 ─ NMG 记忆库自监督蒸馏
  □ Qwen3-0.5B 编码所有活跃节点 → 相似度矩阵
  □ 自动生成 contrastive pairs
  □ teacher MSE + ranking distillation

□ Phase 2b ─ MoE 对比
  □ 4 experts, top-1, ~45M total / ~18M active
  □ 长文本 recall 对比

□ Phase 3 ─ 训练闭环 + 联合优化
  □ activation head 多任务训练
  □ 适配层 + HA + Controller 联合训练

□ Phase 4 ─ Tokenizer 进一步优化
  □ NMG 语料 token 频率统计 → 调整 ID 映射

□ Phase 5 ─ 高级特性（按需）
  □ Q/K/V 多向量、int8 量化、MLA 存储压缩
```
