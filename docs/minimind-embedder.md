# MiniMind-NMG Encoder — 专用向量模型设计 v3（最终）

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
| **双向 Full Attention** | ✅ 选定 | 短序列（32-256 tokens），每条 token 看全序列，ONNX 友好 |
| KDA 式状态化 | ❌ | 跨节点状态 = MGR gate biases + h₁ EMA 职责，冗余且冲突 |
| MLA 式压缩 | ❌（当前） | 存储压缩的价值在百万节点后才明显，先做正确再做省 |
| 稀疏 Attention | ❌ | 256 tokens 全 attention = 64K 次比较，完全不需要稀疏 |
| causal Attention | ❌ | 生成模型的遗产，对编码是纯负债（前向 token 看不到后文） |

## 4. 模型配置

### 4.1 推荐：Small（甜点位）

```
参数量：     ~30M
层数：       6
hidden：     512
heads：      8 (q_heads=8, kv_heads=4, GQA)
head_dim：   64
ffn：        1536 (SwiGLU)
max_length： 256 tokens（NMG 节点短文本绰绰有余）

编码器输出：  256-dim L2 → 适配层 → 128-dim L2 → HA / MGR / Controller
activation： 1 个标量（节点激活先验，可选）
```

- NMG 节点文本通常 32～256 tokens，不需要长上下文
- 适配层 Linear(256→128) 约 33K 参数，TypeScript autodiff 轻量可控
- 比 BGE-small (~118M) 轻 4 倍，比 Qwen3-0.5B (~500M) 轻 16 倍

### 4.2 可选档位

| 档位 | 层数 | hidden | 编码器输出 | 适配层输出 | 参数量 | 用途 |
|------|------|--------|-----------|-----------|--------|------|
| Tiny | 4 | 384 | 128 | 64 | ~15M | 粗召回 / 极低延迟 |
| **Small** | **6** | **512** | **256** | **128** | **~30M** | **主模型** |
| Medium | 8 | 512 | 256 | 128 | ~55M | 质量兜底 |

### 4.3 完整结构

```
MiniMind-NMG Encoder
├── Token Embedding (Qwen vocab, 初始完整, 后续裁剪至 24-32k)
├── 6× Transformer Block
│   ├── RMSNorm (pre-norm)
│   ├── Bidirectional Full Attention (GQA: 8 q_heads / 4 kv_heads)
│   │   ├── Q/K/V projections (no bias, Qwen3 style)
│   │   ├── QK RMSNorm (Qwen3 style)
│   │   ├── RoPE (max 512, 不需要 YaRN 长文本外推)
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

3. max_position_embeddings: 32768 → 512（不需要长文本外推）

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

### 7.1 教师：Qwen3-0.5B

已验证 Qwen3-0.5B > bge-small。不蒸馏"通用语义"，而是蒸馏"Qwen 在 NMG 上的排序行为"。

### 7.2 训练数据：NMG 真实检索轨迹

每次检索保存：
```
query
候选节点列表
Qwen3 分数
最终进入 AG 的节点
后续真正被使用的节点
未被使用的高相似节点（hard negative）
```

### 7.3 损失函数

```
L = α·L_contrastive + β·L_rank + γ·L_teacher + δ·L_behavior

L_contrastive: InfoNCE（used > unused）
L_rank:        pairwise ranking loss（保留 Qwen 的排序）
L_teacher:     MSE（student score ≈ teacher score）
L_behavior:    交叉熵（预测"是否被使用"）
```

### 7.4 训练流程

```
步骤 1：MiniMind 预训练权重 → 改成双向 attention → MLM/去噪适配
步骤 2：加入 embedding head → 对比学习 + 教师排序蒸馏
步骤 3：加入 activation head → 多任务训练
步骤 4：导出 ONNX → Node.js 部署
```

### 7.5 消融实验矩阵

| 版本 | Attention | 层数 | 输出 | 目的 |
|------|-----------|------|------|------|
| A | causal | 8 | 256 | 最小修改基线 |
| B | bidirectional | 8 | 256 | 测双向收益 |
| C | bidirectional | 6 | 256 | 测缩小后质量 |
| D | bidirectional | 4 | 128 | 测极限轻量 |

## 8. 部署：ONNX Runtime Node.js

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

  train(batch: AdapterBatch, learningRate?: number): TrainingResult;
  // 与 Controller 同一个 DAG 的 backward

  toJSON(): DifferentiableAdapterState;
  static fromJSON(state: DifferentiableAdapterState): DifferentiableAdapter;
}
```

### 8.4 性能优化顺序

```
双向小 Encoder
→ 固定 max_length (256)
→ 动态批处理（微批窗口合并）
→ ONNX Runtime Node.js
→ FP16 / INT8 量化
→ 缓存不变节点向量 ★ 最大优化
```

**缓存节点向量**：NMG 中绝大部分长期节点不会变化，每轮只需编码 query + 新增/修改节点。

### 8.5 批处理策略

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

## 13. 文件规划

```
minimind-nmg/                       # Python 训练侧
  model/
    minimind_encoder.py             # 双向 MiniMind Encoder
    pooling.py                      # masked mean / attention / 多层混合 pooling
    heads.py                        # embedding / activation heads
  trainer/
    train_encoder.py                # 训练主脚本
    data.py                         # NMG 轨迹 → 训练样本
  export/
    export_onnx.py                  # PyTorch → ONNX
  tokenizer/
    prune_qwen_vocab.py             # Qwen 词表裁剪工具

src/core/
  minimind-embedder.ts              # ONNX 推理 + 适配层（实现 VectorEmbedder）
  minimind-embedder.test.ts         # 测试
  differentiable-embedder.ts        # DifferentiableAdapter（UOp autodiff）
  differentiable-embedder.test.ts   # 测试（含联合 backward 验证）

docs/
  minimind-embedder.md              # 本文档
  hierarchical-activation.md        # HA + MGR 推演设计
```

## 14. 实施路线

```
Phase 1 ─ 结构验证（当前）
  □ 从 MiniMind-dLM 提取双向 attention 实现
  □ 搭建 PyTorch 训练脚本：6 层 + hidden 512 + 输出 256
  □ 从 MiniMind-3 预训练权重初始化 + MLM 适配
  □ causal vs bidirectional 消融实验

Phase 2 ─ 教师蒸馏
  □ Qwen3-0.5B 标注 NMG 检索排序
  □ ranking loss + InfoNCE + teacher MSE
  □ 与 bge-small 基线对比

Phase 3 ─ ONNX 部署
  □ PyTorch → ONNX 导出
  □ onnxruntime-node 集成
  □ batch=1/4/16 延迟测试

Phase 4 ─ 训练闭环
  □ NMG 检索轨迹自动收集
  □ activation head 多任务训练
  □ 适配层 + HA + Controller 联合训练

Phase 5 ─ Tokenizer 裁剪
  □ NMG 语料 token 频率统计 → 裁剪至 24k-32k

Phase 6 ─ 高级特性（按需）
  □ Q/K/V 多向量、多类型节点 Projector、int8 量化
```
