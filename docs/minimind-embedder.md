# MiniMind-NMG Encoder — 专用向量模型设计（历史归档）

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

## 1. 核心判断与设计原则

MiniMind 对 NMG 的价值不在于"现在是好向量模型"，而在于：
- 足够小（可反复消融实验）
- 结构透明（causal → bidirectional，LM head → embedding heads）
- 完整训练链路（pretrain → SFT → RL 全流程代码）
- 小词表优势（不像 multilingual 模型把大量参数浪费在词嵌入）

三条设计原则（分别借鉴 FlashKDA、FlashMLA、DeepEP 的架构思路）：

1. **状态更新应有明确的自由度设计。** 每个"状态从旧到新"的转变都应显式建模：吸收多少、保留多少、衰减多快。
2. **存储和计算可以不对称。** 持久化维度 < 计算维度，存小算大。
3. **最小资源占用是核心竞争力。** 图侧的资源消耗必须远小于 LLM 推理，让真正的瓶颈拥有尽可能多的资源。

## 2. 总览：三层架构

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

## 3. 图侧决定编码器需求

编码器输出被三个消费者使用，它们都依赖 L2 归一化向量：

```
编码器输出: Float32[256] L2
         │
         ├─→ HA (HierarchicalActivation)
         │     query·candidate cosine → g₁ cross-attention
         │     7-way blended scoring → nodeScores
         │     ★ 基础信号是余弦相似度，编码器质量决定一切下游
         │
         ├─→ MGR (MemoryGraphReasoner)
         │     g = σ(v^T @ q + b)    gate 依赖 v^T @ q
         │     q' = g·v + (1-g)·q   残差混合
         │     r = q'^T @ v          局部相关性
         │     ★ gate 门控依赖余弦相似度，编码器偏了 gate 就偏了
         │
         └─→ DifferentiableController
               node/edge/control/budget heads
               ★ 不直接消费编码器输出，消费 HA 的 nodeScores
```

**结论**：编码器只有一个核心任务——**把语义相近的文本映射到相近的 L2 方向**。
所有"选择性关注"、"多尺度聚合"、"时序记忆"都在图侧完成。
编码器越简单，越容易验证、导出、加速。

### 3.1 Attention 最终选择：双向 Full Attention

| 方案 | 判定 | 原因 |
|------|------|------|
| **双向 Full Attention** | ✅ 选定 | 每条 token 看全序列，ONNX 友好，Flash Attention 原生支持 |
| KDA 式状态化 | ❌ | 跨节点状态 = MGR gate biases + h₁ EMA 职责，冗余且冲突 |
| MLA 式压缩 | ❌（Phase 6） | 存储压缩的价值在百万节点后才明显，先做正确再做省 |
| 稀疏 Attention | ❌ | 编码器输出单一向量，不需要 token 级稀疏选择 |
| causal Attention | ❌ | 生成模型的遗产，对编码是纯负债（前向 token 看不到后文） |

### 3.2 真实数据分布（4 个 benchmark, 5732 条消息）

```
p50:    359 tokens
p75:    951 tokens
p90:   1180 tokens
p95:   1318 tokens
p99:   1657 tokens

< 500 tokens:  53%
≥ 500 tokens:  47%
≥ 1000 tokens: 21%
```

接近一半的消息超过 500 tokens。文本分布有三类：
短查询/摘要（50-200 tokens）、中长证据/对话（200-800 tokens）、长文档/轨迹（1000-5000+ tokens）。

## 4. 模型配置

### 4.1 Phase 1 基线：Dense Small

```
参数量：     ~30M
层数：       6
hidden：     512
heads：      8 (q_heads=8, kv_heads=4, GQA)
head_dim：   64
ffn：        1536 (SwiGLU)
max_length： 2048 tokens（需覆盖 p99+ 的长文本）

编码器输出：  256-dim L2 → 适配层 → 128-dim L2 → HA / MGR / Controller
activation： 1 个标量（节点激活先验，可选）
```

- 适配层 Linear(256→128) 约 33K 参数，TypeScript autodiff 轻量可控
- 比 BGE-small (~118M) 轻 4 倍，比 Qwen3-0.5B (~500M) 轻 16 倍

### 4.2 Phase 2 对比：MoE

```
参数量：     ~45M total / ~18M active
层数：       6
hidden：     512
experts：    4, top-1 routing
max_length： 2048 tokens

编码器输出：  同 Dense
```

MoE 的价值在于长文本（≥500 tokens）上不同 expert 可能按文本类型/长度分化。
Phase 2 在 Dense 基线稳定后做对比实验：
- 测试数据：benchmark 中长文本子集
- 决策指标：长文本 recall 提升 > 10% 且 batch=1 延迟 < 3ms → 选 MoE
- 风险：routing collapse、ONNX 导出兼容性

### 4.3 可选档位

| 档位 | 层数 | hidden | 类型 | 参数量 | 用途 |
|------|------|--------|------|--------|------|
| Tiny | 4 | 384 | Dense | ~15M | 粗召回 / 极低延迟 |
| **Small** | **6** | **512** | **Dense** | **~30M** | **Phase 1 基线** |
| Small-MoE | 6 | 512 | 4 experts | ~45M/18M active | Phase 2 对比 |
| Medium | 8 | 512 | Dense | ~55M | 质量兜底 |

### 4.4 完整结构

```
MiniMind-NMG Encoder (Dense 版本)
├── Token Embedding (Qwen vocab, 初始完整, 后续裁剪至 24-32k)
├── 6× Transformer Block
│   ├── RMSNorm (pre-norm)
│   ├── Bidirectional Full Attention (GQA: 8 q_heads / 4 kv_heads)
│   │   ├── Q/K/V projections (no bias, Qwen3 style)
│   │   ├── QK RMSNorm (Qwen3 style)
│   │   ├── RoPE (max 2048)
│   │   └── Flash Attention / manual softmax (ONNX 兼容)
│   ├── Residual
│   ├── RMSNorm (pre-norm)
│   ├── SwiGLU FFN (gate + up + down, no bias)
│   └── Residual
├── Final RMSNorm
├── Masked Mean Pooling (over valid tokens, ignoring padding)
├── Embedding Head: Linear(hidden, 256) → L2Normalize
└── Activation Head (v2): Linear(hidden, 1) → Sigmoid
```

## 5. 架构改造（相比原生 MiniMind）

### 5.1 必须改

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

### 5.2 尽量保留

```
RMSNorm  — 比 LayerNorm 更快
GQA      — 8 q_heads / 4 kv_heads，推理更快
SwiGLU   — 比 ReLU FFN 更好
Pre-Norm — 训练更稳定
QK Norm  — Qwen3 风格，训练更稳定
no bias  — Qwen3 风格，参数更少
```

### 5.3 Pooling

- **masked mean pooling**（默认）：对有效 token 求均值，忽略 padding
- attention pooling（可选实验）：可学习权重
- 多层加权混合（可选实验）：如第 2、4、6 层的加权和

不推荐 last-token pooling：decoder-only 的最后一个 token 有位置偏差。

## 6. Tokenizer 策略

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

## 7. 训练策略

### 7.1 数据策略：三阶段，零 benchmark 泄漏

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

### 7.2 教师：Qwen3-0.5B（仅 Phase 2）

已验证 Qwen3-0.5B > bge-small。Phase 2 中 Qwen3 仅用于计算 NMG 已有节点间的相似度，
不接触 benchmark。不蒸馏"通用语义"，而是蒸馏"Qwen 在 NMG 节点上的相似度排序"。

### 7.3 损失函数

```
Phase 1: L = L_contrastive + β·L_rank
Phase 2: L = L_contrastive + γ·L_teacher
Phase 3: L = L_contrastive + δ·L_behavior

L_contrastive: InfoNCE（used / similar > unused / dissimilar）
L_rank:        pairwise margin ranking
L_teacher:     MSE（student score ≈ Qwen3 score）
L_behavior:    交叉熵（预测"是否被使用"）
```

### 7.5 消融实验矩阵

| 版本 | Attention | 层数 | 输出 | 目的 |
|------|-----------|------|------|------|
| A | causal | 8 | 256 | 最小修改基线 |
| B | bidirectional | 8 | 256 | 测双向收益 |
| C | bidirectional | 6 | 256 | 测缩小后质量 |
| D | bidirectional | 4 | 128 | 测极限轻量 |

## 8. 部署：ONNX Runtime Node.js

**历史原型（已删除）。** 原型曾通过 `src/core/onnx-minimind-embedder.ts`
提供进程内推理：

```ts
import { OnnxMiniMindEmbedder } from "../src/core/onnx-minimind-embedder.ts";
const e = await OnnxMiniMindEmbedder.create(modelPath, mappingPath);
// Token IDs（由外部 tokenizer 产生）→ L2 向量
const emb = await e.embed(tokenIds, masks);  // Float32Array[batch*dim]
// 加载 ~370ms, 推理 ~7ms/text (batch=5, seq=64, RTX 3060)
```

关键决策：**Tokenizer 与 ONNX 分离**
- Tokenizer 薄层（Python / WASM / 预 tokenize），不跟 ONNX runtime 耦合
- ONNX 进程内 `onnxruntime-node`，Float32Array 零拷贝
- 已验证：Node.js vs Python ONNX 输出 bit-exact 一致 (max diff = 0)

### 8.1 导出接口

```python
# PyTorch → ONNX
torch.onnx.export(
    model,
    (input_ids, attention_mask),
    "minimind_nmg_encoder.onnx",
    input_names=["input_ids", "attention_mask"],
    output_names=["embedding", "activation"],
    dynamic_axes={"input_ids": {0: "batch"}}
)
# embedding: [batch, 256] L2-normalized
# activation: [batch, 1]  sigmoid
```

### 8.2 Node.js 调用

```ts
// ONNX 编码器 → L2 向量
const encoded = tokenizer.encodeBatch(texts);
const outputs = await session.run({
  input_ids: encoded.inputIds,
  attention_mask: encoded.attentionMask
});

// 适配层投影 → 图空间
const graphVector = adapter.project(outputs.embedding);
// Float32Array[128] L2 → 进入 HA / MGR / Controller
```

### 8.3 DifferentiableAdapter 接口

```ts
class DifferentiableAdapter {
  readonly inputDim: number;   // 256（编码器输出）
  readonly outputDim: number;  // 128（图空间）

  readonly #projection: Tensor;  // [128, 256]
  readonly #bias: Tensor;        // [128]

  project(encoderOutput: Float32Array): Float32Array;
  // → Linear(256→128) → L2 normalize → Float32Array(128)

  // 训练态：构建 UOp 节点，参与 autodiff DAG
  forward(encoderOutput: Float32Array): Tensor;
  // → UOp[128] L2，梯度可回传至 #projection / #bias

  train(batch: AdapterBatch, learningRate?: number): TrainingResult;
  // 与 HA / Controller 同一个 DAG 的 backward

  toJSON(): DifferentiableAdapterState;
  static fromJSON(state: DifferentiableAdapterState): DifferentiableAdapter;
}
```

### 8.4 精度与缓存

```
FP16 作为生产默认：
  总模型: ~60 MB（Dense 30M, 每层约 5M 参数 × 2 bytes = 10 MB/层）
  逐层推理：每层权重 10 MB，典型 L3 cache (16-32 MB) 可以常驻
  FP32 → FP16 质量损失通常可忽略，ONNX Runtime 一行转换
```

| 精度 | 总大小 | 每层 | L3 适配 | 说明 |
|------|--------|------|---------|------|
| FP32 | 120 MB | ~20 MB | 勉强 | 可能跨层 evict |
| **FP16** | **60 MB** | **~10 MB** | **舒适** | 生产默认 |
| INT8 动态 | ~35 MB | ~5 MB | 绰绰有余 | 需验证质量 |

### 8.5 性能优化顺序

```
双向小 Encoder
→ 固定 max_length (2048)
→ FP16 精度（每层 ~10 MB，L3 cache 常驻）
→ 动态批处理（微批窗口合并）
→ ONNX Runtime Node.js
→ 缓存不变节点向量 ★ 最大优化
```

### 8.6 编码器与可微图的缓存边界

```
              ┌─── 缓存在 256 侧 ─────────────────────┐
              │  Float32VectorCache(256-dim, FP16)     │
              │  百万节点 ≈ 512 MB                     │
              │  适配层重训 → 缓存不失效                │
              └────────────┬──────────────────────────┘
                           │ 缓存命中: 直接取
ONNX Encoder (冻结) ───────┴─→ Float32[256] L2 ──→ Adapter (autodiff) ──→ Float32[128] L2
     ↑  缓存未命中: 重新编码         ↑                              ↑
     训练时不变                      训练时参与梯度                   进入 HA/MGR/Controller
```

**为什么缓存 256 而不是 128：** 适配层是 autodiff 可训练参数，重训后 128 维空间变化，
存 256 维编码器输出不随适配层重训失效。每次查询只需 adapter.project() ——
Linear(256→128) → L2，一次 matmul + add + normalize，图侧几乎不可感知。

```ts
// 推理态
const enc256 = cache.get(nodeId) ?? encoder.encode(text);  // 缓存命中 or ONNX
const vec128 = adapter.project(enc256);                     // Float32Array[128] L2
ha.propagate(query128, [{ nodeId, vector: vec128 }], ...);  // 进入图

// 训练态
const query128 = adapter.forward(encoderVec);               // UOp[128] L2, 参与梯度
const loss = ha.propagate(query128, ...).contrastiveLoss;
loss.backward();                                            // 梯度流过 adapter + HA
gradientStep([adapter.#projection, adapter.#bias], lr);     // 只更新适配层
// ONNX 编码器始终不参与梯度
```

### 8.7 批处理策略

Agent 单轮常见场景：
```
batch=1:  当前 query (~1-3ms)
batch=4:  query + 3 个候选节点
batch=16: query + 15 个新增节点
```

小 batch 延迟是关键——不要只测 batch=200。

## 9. 评价指标

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

## 10. MiniMind 变体取舍

| 变体 | 取什么 | 舍什么 |
|------|--------|--------|
| **dLM** | 双向 attention、mask corruption 训练、AR→dLM 权重迁移 | 多步去噪、扩散生成 |
| **主线 Dense** | RMSNorm、RoPE、GQA、SwiGLU、完整训练链路 | causal mask、LM head、CE loss |
| **V (视觉)** | Projector 思想：不同模态→统一隐空间 | 视觉编码器 |
| **O (Omni)** | 共享主干+多头、中间层桥接 | 语音/视觉模块 |
| **Linear** | 长序列/流式状态（Phase 6 考虑） | 不用于当前节点编码 |

## 11. 与现有系统的对接

### 11.1 替换路径

```
现有：OpenAIEmbeddingClient → Qwen3-0.6B（HTTP API）
                    ↓
过渡：OpenAIEmbeddingClient → localhost（MiniMind ONNX 兼容格式）
                    ↓
最终：onnxruntime-node → Encoder → Adapter → 128-dim L2 → HA/MGR/Controller
```

### 11.2 接口兼容

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

### 11.3 联合训练

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

## 12. 不在第一版做的

- ❌ Tokenizer 裁剪（先用完整 Qwen 验证效果）
- ❌ Q/K/V 多向量（先验证 embedding + activation）
- ❌ 多类型节点 Projector（先用统一文本编码）
- ❌ Linear Attention（短序列 full attention 更快更简单）
- ❌ int8 量化（先 FP16 验证质量）
- ❌ MLA 式存储压缩（先做正确）

## 13. 文件规划

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

## 14. 实施路线

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
