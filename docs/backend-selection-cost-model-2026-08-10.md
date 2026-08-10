# 批量训练负载 + 自动后端选择（cost model）实证 — 2026-08-10

承接 docs/autodiff-operator-optimization-2026-08-10.md（§8.3 编译模式、§9 HPC 范式）。本探索把
"编译一次+复用"范式推广到**批量训练**，并把 §8.2 的定性"适用窗口"落成**可自动执行的 cost model**
（`src/lab/backend-selection.ts`）。

## 1. 批量负载的两种形态

- **stacked（堆叠）**：B 个样本合成 [B,D] 矩阵，`X·W` → [B,1]。**数组变大、图保持 ~8 节点**。
- **loop（循环）**：B 个单样本子图求和。**图膨胀 O(B)（~6·B 节点）、数组保持标量**。
  （controller 现网就是 loop 形态：`#batchedBinaryLoss` 只对 ≥8 样本走批量，其余逐样本。）

测量：一步训练（forward + backward + gradientStep），参数持久（真实训练循环），
解释器 vs 编译 tape（`NMG_AUTODIFF_COMPILE=1`），网格 D∈{16,128} × B∈{1,4,16,64,256,1024}，
`tools/batch-backend-bench.ts`，7 轮取中位。

## 2. 实测结果（µs/step，中位数）

### 2.1 表示法选择 >> 后端选择（最重要的发现）

| 形态×后端 | B=1024, d=16 | B=1024, d=128 |
|---|---|---|
| loop 解释器 | 8047 | 11287 |
| loop 编译tape | 3049 | 4652 |
| stacked 解释器 | 397 | 2738 |
| stacked 编译tape | 316 | 2202 |

**同后端下 stacked 比 loop 快最多 9.6×**（d=16,B=1024：397 vs 8047µs）。loop 图膨胀 O(B)、
逐样本解释开销主导；stacked 把工作压进 matmul，图保持恒定。→ **批量训练应优先选 stacked 形态**，
这比后端选择的影响大一个数量级。

### 2.2 编译 tape 在可复用训练循环里普遍赢（1.3–3×）

| 形态 | 全网格 on/off 比值 |
|---|---|
| stacked | 0.49–0.80（1.25–2× 快） |
| loop | 0.32–0.74（1.35–3× 快） |

大图（loop 高 B）收益最大（2.6–3×），因为编译 tape 消掉了逐节点解释开销。**前提**：
结构稳定 + 参数持久（真实训练循环）。单发/每步重建参数的图，编译不适用（编译成本 O(V) 无法摊还）。

### 2.3 编译模式的已知低效：双重 forward

`loss.scalarValue`（data getter → 跑一次 forward）后再 `loss.backward()`（runCompiledBackward →
**再跑一次 forward**）。probe 实测（loop d=16, B=1024）：

- 编译 tape：withScalar 3236µs vs noScalar（forward 只跑一次）1908µs → **双重 forward 多花 ~40%**
- 解释器：7936 vs 7163µs（~10%）

→ 编译模式追天花板（compile-once API：backward 复用 forward 结果）在大数组批量下可再省 ~1.7×。
小数组（controller 49 节点）影响 ~3–5%，不显著。

### 2.4 GPU 档（provisional）

最大的实测 CPU matmul（[1024,128]×[128,1] ≈ 0.26M flop，compiled 2202µs/step）仍 CPU 更快；
GPU 的赢点在 kernel 启动 + DRAM 往返（MLX: 4k×4k 17× 是访存比），小 kernel 必输。因此 GPU
阈值暂定 matmul ≥ 8M flop（Trueno-DB MIN_DATA_SIZE 式规则），**未校准**，待 WGSL 后端落地后重标。

## 3. Cost model：`src/lab/backend-selection.ts`

纯决策模块（UOp-free，可测）：

```
pickTier(metrics, context) →
  GPU:   gpuAvailable && matmulFlops ≥ 8M   → "gpu-wgsl"（uncalibrated）
  编译:   reusable && expectedRuns ≥ 3      → "compiled-tape"
  否则:                                       → "interpreter"
```

`estimateGraphMetrics(nodes)`：从 MetricNode 描述符求 nodeCount / totalBytes / matmulFlops。
每个决策带 `reason`（可审计）。

**验证**（`.validate-selection.mjs`，全过）：
- 实测 24/24 可复用单元 compiled 更快 ↔ pickTier 24/24 判 compiled-tape ✓
- 单发 / expectedRuns<3 → interpreter（编译成本无法摊还）✓
- GPU 分支：0.26M flop → compiled-tape；≥8M → gpu-wgsl ✓

## 4. 什么时候用（触发条件）

- **表示法**：B ≥ ~8（现网 `BATCH_THRESHOLD` 已如此）应走 stacked 批量；loop 只适合极小 B。
  这是免费的（改批量损失构造即可）。
- **后端**：训练循环（结构+参数稳定）自动走编译 tape；单发走解释器。`NMG_AUTODIFF_COMPILE` 目前是
  全局 env 开关；后续可改为按图 `pickTier` 的 auto 模式（每次训练循环自动判定）。
- **GPU**：待 WGSL 后端 + 批量/离线训练出现（当前生产在线单样本 CPU 必赢）。

## 5. 后续

- compile-once API：消除双重 forward（§2.3 实测 ~1.7× 空间），大数组批量下值得
- 把 `pickTier` 接入执行路径的 auto 模式（替换全局 env 开关）
- WGSL 后端落地后重标 GPU 阈值并测 crossover
