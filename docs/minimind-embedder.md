# MiniMind-NMG Encoder — 专用向量模型设计 v2

## 1. 核心判断

```
直接取 MiniMind 最后一层做向量 → ❌ 不够（生成模型≠向量模型）
用 MiniMind 骨干改造成 NMG 专用编码器 → ✅ 适合
```

MiniMind 对 NMG 的价值不在于它"现在是好向量模型"，而在于：
- 足够小（可反复消融实验）
- 结构透明（causal → bidirectional，LM head → embedding heads）
- 完整训练链路（pretrain → SFT → RL 全流程代码）
- 小词表优势（不像 multilingual 模型把大量参数浪费在词嵌入）

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
│  #projection: Tensor([128, 256])   #bias: Tensor([128])          │
│  ~33K 参数                                                        │
│  训练: 与 Controller 联合 backward，同一个 UOp DAG                   │
└──────────────────────────────┬───────────────────────────────────┘
                               │  Float32[128] L2
         ┌─────────────────────┼─────────────────────┐
         ↓                     ↓                     ↓
   ANN (usearch)      Float32VectorCache      Controller (autodiff)
```

三层职责分明：

| 层 | 运行环境 | 可训练 | 输入→输出 | 说明 |
|----|---------|--------|-----------|------|
| MiniMind-NMG Encoder | ONNX Runtime (Node.js 进程内) | 否（部署时冻结） | text → 256-dim L2 | 语义编码，离线蒸馏 |
| DifferentiableAdapter | Node.js / UOp autodiff | **是** | 256-dim → 128-dim L2 | 与 Controller 联合训练 |
| ANN + Controller | Node.js | Controller 可训 | 向量 → 检索/路由 | 图操作 |

**为什么保留适配层？**

适配层不是简单的降维，它是 UOp autodiff 图中的可训练组件：

```ts
// 一次 backward 同时更新适配层和 controller
L_total = L_retrieval + λ * L_contrastive
loss.backward();          // 同一个 UOp DAG
gradientStep(embedderParams, lr_e);
gradientStep(controllerParams, lr_c);
```

- 适配层约 33K 参数，TypeScript autodiff 完全能处理
- Controller 的路径偏好（哪些维度重要）可以反向塑造适配层的投影
- MiniMind 编码器作为 ONNX 冻结，不参与梯度——语义提取和策略投影职责分离

**为什么两边都是 L2？**

可微计算图（router.ts、Float32VectorCache、ANN usearch）全部基于 L2 归一化向量和余弦相似度。编码器输出 L2、适配器输出 L2，中间不破坏归一化。

## 3. 模型配置

### 3.1 推荐：Small（甜点位）

```
参数量：     ~30M
层数：       6
hidden：     448 或 512
heads：      8 (q_heads=8, kv_heads=4, GQA)
ffn：        1280～1536
max_length： 192 tokens
输出维度：   256
activation： 1 个标量
```

原因：
- NMG 节点文本通常 32～256 tokens，不需要长上下文
- 100 万节点 × 256 维 × FP16 ≈ 512 MB，可接受
- 6 层 + 双向 attention 语义容量充足
- 比 BGE-small (~118M) 轻 4 倍，比 Qwen3-0.5B (~500M) 轻 16 倍

### 3.2 可选档位

| 档位 | 层数 | hidden | 输出 | 参数量 | 用途 |
|------|------|--------|------|--------|------|
| Tiny | 4 | 384 | 128 | ~15M | 粗召回 / 极低延迟 |
| **Small** | **6** | **448-512** | **256** | **~30M** | **主模型** |
| Medium | 8 | 512 | 256 | ~55M | 质量兜底 |

### 3.3 为什么不用完整 MiniMind-3 (64M)

- 64M 参数中去掉 LM head（6400×768 ≈ 5M）后主体约 59M
- 生成模型为 next-token prediction 优化，encoder 不需要这个复杂度
- 6 层 + 双向 attention 对短文本编码通常够用
- 小 batch 推理延迟更重要：batch=1 和 batch=16 都要快

## 4. 架构改造（相比原生 MiniMind）

### 4.1 三处必须改

```
1. causal mask → bidirectional attention（借 dLM 思路）
   取消因果掩码，每个 token 看完整序列
   这对否定、转折、关系表达至关重要

2. LM head → multi-head
   embedding head：   Linear(hidden, 256) → L2
   activation head：  Linear(hidden, 1) → sigmoid
   （后续扩展 Q/K/V heads）

3. CE loss → retrieval + ranking + distillation loss
   InfoNCE + pairwise ranking + teacher score MSE
```

### 4.2 三处尽量保留

```
RMSNorm  — 比 LayerNorm 更快
RoPE     — 相对位置编码，YaRN 外推保留
GQA      — 8 q_heads / 4 kv_heads，推理更快
SwiGLU   — 比 ReLU FFN 更好
Pre-Norm — 训练更稳定
```

### 4.3 Pooling 选择

不推荐 last-token pooling（decoder-only 最后一个 token 有位置偏差）。

推荐实验：
- **masked mean pooling**（默认首选）
- attention pooling（可学习权重）
- 多层加权混合（不是只用最后一层）

MiniMind-O 的经验：中间层可能保留比最后一层更合适的语义（最后一层更贴近 next-token prediction）。

```
h = Σ α_l · Pool(H_l),  l ∈ {2, 4, 6}
```

### 4.4 Q/K/V 多向量（后续版本）

```
query  = W_q h    # 这个节点倾向寻找什么
key    = W_k h    # 这个节点容易被什么激活
value  = W_v h    # 被激活后传播什么信息
```

边权不再只靠对称余弦相似度：

```
e_ij = (q_i^T k_j) / sqrt(d)
```

天然有向（e_ij ≠ e_ji），匹配 NMG 的有向记忆关系。

## 5. Tokenizer 策略

### 5.1 不推荐完整 Qwen 词表

Qwen3 词表约 152k。hidden=384 时：
```
152064 × 384 ≈ 58.4M 参数（仅 embedding 层）
```
而骨干本身只有 ~25M——大部分参数浪费在永远不会用的 token 上。

### 5.2 不推荐 MiniMind 原始 6.4k 词表

太小，技术词（SQLite、AG、STG/LTG）被切太碎，影响：
- 推理速度（序列变长）
- 技术词表示质量
- 与 Qwen 教师蒸馏难度

### 5.3 推荐：Qwen 兼容裁剪词表（20k～40k）

从 NMG 真实语料统计 Qwen token 频率：
```
NMG 历史节点 + 用户查询 + 工具调用 + 代码/配置 + 技术文档
```

保留高频 token，裁剪到 20k～40k。

不同规模的代价（hidden=384, FP16）：

| 词表 | Embedding 参数 | 约占内存 |
|------|--------------|---------|
| 6,400 | 2.5M | 5 MB |
| 16,000 | 6.1M | 12 MB |
| 24,000 | 9.2M | 18 MB |
| 32,000 | 12.3M | 25 MB |
| 64,000 | 24.6M | 49 MB |
| 152,064 | 58.4M | 117 MB |

**第一版建议：先用完整 Qwen tokenizer 验证蒸馏效果，确认有效后再裁剪到 24k～32k。**

Tokenizer 与模型分开，ONNX 模型只收 `input_ids` + `attention_mask`。

## 6. 训练策略

### 6.1 教师：Qwen3-0.5B

已验证 Qwen3-0.5B > bge-small。不蒸馏"通用语义"，而是蒸馏"Qwen 在 NMG 上的排序行为"。

### 6.2 训练数据：NMG 真实检索轨迹

每次检索保存：
```
query
候选节点列表
Qwen3 分数
最终进入 AG 的节点
后续真正被使用的节点
未被使用的高相似节点
```

构造：
```
query → positive node（进入 AG 且被使用）
query → hard negative node（高分但未被使用）
```

### 6.3 损失函数

不要只复制 Qwen 向量，优先复制它的**排序**：

```
L = α·L_contrastive + β·L_rank + γ·L_teacher + δ·L_behavior
```

| 损失 | 公式 | 目的 |
|------|------|------|
| InfoNCE | 标准对比损失 | 语义区分 |
| Pairwise Ranking | max(0, m - s(q,p+) + s(q,p-)) | 排序一致性 |
| Teacher MSE | (s_student - s_teacher)² | 分数校准 |
| Behavior | 交叉熵（是否被使用） | NMG 行为拟合 |

### 6.4 训练流程

```
步骤 1：MiniMind 预训练权重 → 改成双向 attention → MLM/去噪适配
步骤 2：加入 embedding head → 对比学习 + 教师排序蒸馏
步骤 3：加入 activation head → 多任务训练
步骤 4：导出 ONNX → Node.js 部署
```

### 6.5 消融实验矩阵（第一批）

| 版本 | Attention | 层数 | 输出 | 目的 |
|------|-----------|------|------|------|
| A | causal | 原配置 8 | 256 | 最小修改基线 |
| B | bidirectional | 8 | 256 | 测双向收益 |
| C | bidirectional | 6 | 256 | 测缩小后质量 |
| D | bidirectional | 4 | 128 | 测极限轻量 |

统一使用同一批训练样本、hard negative、教师分数、测试 query。

## 7. 部署：ONNX Runtime Node.js

### 7.1 导出接口

```python
# PyTorch → ONNX
torch.onnx.export(
    model,
    (input_ids, attention_mask),
    "minimind_nmg_encoder.onnx",
    input_names=["input_ids", "attention_mask"],
    output_names=["embedding", "activation"],
    dynamic_axes={"input_ids": {0: "batch"}, ...}
)
# embedding: [batch, 256] L2-normalized
# activation: [batch, 1]  sigmoid
```

### 7.2 Node.js 调用

```ts
// ONNX 编码器 → L2 向量
const encoded = tokenizer.encodeBatch(texts);
const outputs = await session.run({
  input_ids: encoded.inputIds,
  attention_mask: encoded.attentionMask
});
// outputs.embedding: Float32Array[batch * 256] L2
// outputs.activation: Float32Array[batch * 1]

// 适配层投影 → 图空间
const graphVector = adapter.project(outputs.embedding);
// Float32Array[128] L2 → 进入 ANN / VectorCache / Controller
```

### 7.3 DifferentiableAdapter 接口

```ts
// src/core/differentiable-embedder.ts

class DifferentiableAdapter {
  readonly inputDim: number;   // 256（编码器输出）
  readonly outputDim: number;  // 128（图空间）

  // 可训练参数（UOp autodiff）
  readonly #projection: Tensor;  // [128, 256]
  readonly #bias: Tensor;        // [128]

  // 前向推理（无梯度）
  project(encoderOutput: Float32Array): Float32Array;
  // → Linear(256→128) → L2 normalize → Float32Array(128)

  // 训练（有梯度，与 Controller 同一个 DAG）
  train(batch: AdapterBatch, learningRate?: number): TrainingResult;

  // 序列化
  toJSON(): DifferentiableAdapterState;
  static fromJSON(state: DifferentiableAdapterState): DifferentiableAdapter;
}
```

### 7.4 多输出头（后续版本）

```text
embedding       [batch, 256]  L2  → 进入适配层
graph_vector    [batch, 128]  L2  → 适配层输出（等价于 embedding + adapter）
activation      [batch, 1]    sigmoid
```

Q/K/V 多向量（后续）：
```text
q               [batch, 64]   L2
k               [batch, 64]   L2
v               [batch, 128]  L2
```

第一版先做 embedding + activation，后续再加 Q/K/V。

### 7.4 性能优化顺序

```
双向小 Encoder
→ 固定 max_length (192)
→ 动态批处理（微批窗口合并）
→ ONNX Runtime Node.js
→ FP16 / INT8 量化
→ 缓存不变节点向量（最大优化）
```

**缓存节点向量是最重要的优化**：NMG 中绝大部分长期节点不会变化，每轮只需编码当前 query + 新增/修改节点。

### 7.5 批处理策略

Agent 单轮常见场景：
```
batch=1:  当前 query
batch=4:  query + 3 个候选节点
batch=16: query + 15 个新增节点
```

确保 batch=1 和 batch=4 延迟不成为瓶颈。可在同一事件循环内做极短批合并。

## 8. 评价指标

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

## 9. 五种 MiniMind 变体的取舍

| 变体 | 对 NMG 的价值 | 取什么 | 舍什么 |
|------|--------------|--------|--------|
| **dLM** | ⭐⭐⭐ 最高 | 双向 attention、mask corruption 训练、AR→dLM 权重迁移 | 多步去噪、扩散生成、词表级输出头 |
| **主线 Dense** | ⭐⭐⭐ 主体 | RMSNorm、RoPE、GQA、SwiGLU、完整训练链路 | causal mask、LM head、CE loss |
| **V (视觉)** | ⭐⭐ | Projector 思想：不同模态→统一隐空间 | 视觉编码器本身 |
| **O (Omni)** | ⭐⭐ | 共享主干+多头、中间层桥接 | 语音/视觉模块 |
| **Linear** | ⭐（后续） | 长序列/流式状态更新思路 | 不用于节点编码（短序列下 full attention 更快） |

## 10. 与现有系统的对接

### 10.1 替换路径

```
现有：OpenAIEmbeddingClient → Qwen3-0.6B（HTTP API）
                    ↓
过渡：OpenAIEmbeddingClient → localhost（MiniMind ONNX 兼容 /embeddings 格式）
                    ↓
最终：onnxruntime-node → MiniMind-NMG Encoder
         → DifferentiableAdapter.project()  → 128-dim L2
         → ANN / VectorCache / Controller
```

### 10.2 接口兼容

```ts
// 对外暴露 VectorEmbedder 接口
// 内部串联 ONNX 推理 + 适配层投影
class MiniMindNMGEmbedder implements VectorEmbedder {
  readonly dimensions = 128;  // 适配层输出 = 图空间维度
  readonly model = "minimind-nmg-v1";

  #encoder: OnnxSession;              // onnxruntime-node
  #adapter: DifferentiableAdapter;    // autodiff 可训练参数

  embed(text: string): readonly number[] {
    const l2_256 = this.#encoder.encode(text);   // ONNX → 256-dim L2
    const l2_128 = this.#adapter.project(l2_256); // Linear → 128-dim L2
    return l2_128;
  }
}
```

### 10.3 联合训练流程

```ts
// 适配层和 Controller 在同一个 UOp DAG 中
// 这是保留适配层作为独立组件的核心原因

const encoderVec = session.run(...);       // Float32Array[256] L2，不参与梯度
const adapterOut = adapter.forward(encoderVec);  // UOp[128] L2，参与梯度
const routeScores = controller.route(adapterOut); // UOp
const loss = controller.computeLoss(routeScores, labels);

loss.backward();  // 梯度流过 adapter.#projection 和 adapter.#bias
gradientStep(adapter.#projection, lr_e);
gradientStep(adapter.#bias, lr_e);
gradientStep(controller.params, lr_c);
```

### 10.4 索引迁移

旧索引（Qwen3 或其他维度）与新索引（MiniMind-NMG 128 维）不兼容，需要重建。
通过 `scripts/index-qwen3.ts` 同样的流程，指向新模型 + 适配层即可。

## 11. 不在第一版做的

- ❌ Q/K/V 多向量（先验证 embedding + activation 足够）
- ❌ 完整联合训练（先独立训练 encoder，再联合 controller）
- ❌ Linear Attention（短序列下 full attention 更快更简单）
- ❌ 多类型节点 Projector（先用统一文本编码）
- ❌ Tokenizer 裁剪（先用完整 Qwen tokenizer 验证效果）
- ❌ int8 量化（先 FP16 验证质量）

## 12. 实施路线 v2

```
Phase 1 ─ 结构验证（1-2 周）
  □ 从 MiniMind-dLM 提取双向 attention 实现
  □ 搭建 PyTorch 训练脚本：6 层 + hidden 448 + 输出 256
  □ causal vs bidirectional 消融实验
  □ 用 NMG 真实数据跑第一轮对比学习

Phase 2 ─ 教师蒸馏（1-2 周）
  □ Qwen3-0.5B 作为教师，标注 NMG 检索排序
  □ 实现 ranking loss + InfoNCE + teacher MSE
  □ 与 bge-small 基线对比
  □ 确定最终模型配置（层数、hidden、输出维度）

Phase 3 ─ ONNX 部署（1 周）
  □ PyTorch → ONNX 导出
  □ onnxruntime-node 集成
  □ Tokenizer 独立部署（JS 侧）
  □ batch=1/4/16 延迟测试

Phase 4 ─ 训练闭环（2-4 周）
  □ NMG 检索轨迹自动收集
  □ 在线 hard negative mining
  □ activation head 多任务训练
  □ 周期性重训练流程

Phase 5 ─ Tokenizer 裁剪（1 周）
  □ NMG 语料 token 频率统计
  □ Qwen 词表裁剪到 24k～32k
  □ 质量/速度对比
  □ 最终词表确定

Phase 6 ─ 高级特性（按需）
  □ Q/K/V 多向量编码
  □ 多类型节点 Projector
  □ 与 Controller 联合训练
  □ int8 量化
  □ Linear Attention 长序列分支
```

## 13. 文件规划

```
minimind-nmg/                       # Python 训练侧
  model/
    minimind_encoder.py             # 双向 MiniMind Encoder
    pooling.py                      # mean / attention / 多层混合 pooling
    heads.py                        # embedding / activation / QKV heads
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
  differentiable-embedder.ts        # DifferentiableAdapter（UOp autodiff 可训练层）
  differentiable-embedder.test.ts   # 测试（含联合 backward 验证）

docs/
  minimind-embedder.md              # 本文档
```
