# autodiff 自动算子优化：设计 + 调研记录

日期：2026-08-10
状态：②④ 已实现并验证（l2 backward 1.8×）；① 融合经实证回退（见 §8）；③ CSE 暂缓
范围：`src/lab/autodiff.ts` + 可选 GPU 实验（`src/lab/gpu/`，不碰生产路径）

## 1. 背景与定位

`src/lab/autodiff.ts` 是一个 TinyGrad 风格的惰性 UOp 图（CPU 标量 Float32Array 引擎），被
`src/lab/differentiable-controller.ts` 与 `src/core/hierarchical-activation.ts`（生产）使用。
后者是**单样本在线训练**（train(sample) → 一次 backward → 一次 gradientStep），每步计算
≈ O(D·n)（D=embedding 维、n=候选数），个位数~几十微秒级。属**延迟敏感、非吞吐敏感**。

生产侧真正算量大的负载（ANN 向量索引）已交给 `usearch` 原生库（SIMD，含 CUDA 变体），
无天然空缺的 GPU 负载。这是 CPU 定位的根因。

## 2. 调研结论（工业 + 学界前沿）

### 2.1 学界：最优图优化是 NP 完备的 → 只能用启发式
- **arXiv 2506.17521 (2025)**：Structural Optimal Jacobian Accumulation（Jacobian 乘法数最小）
  与 Minimum Edge Count（计算图边数最小）在 vertex elimination 下**均 NP-complete**
  （解开 1993/2005 开放问题）；ETH 下无次指数算法（精确 O*(2^n) 本质最优）。
- 实践含义：**不做"最优消除/最小图"规划**，只用结构启发式（Markowitz 度 = in-degree × out-degree 一类）。

### 2.2 工业参照：TinyGrad（本引擎的直接参照系）
- **UOpMetaClass hash-consing 去重**：UOp 构建时按结构驻留 —— 即 CSE 的参考实现。
- **化简是声明式 PatternMatcher**（`tinygrad/uop/symbolic.py`，已抓源码）：`x+0→x`、`x*1→x`、
  `(x^y)^y→x`、`x%x→0`、常量折叠 `fold_const_alu`（const 单/双目直接求值）、commutative
  翻转规范化操作数顺序（让 CSE 能匹配 `a+b` 与 `b+a`）。分 phase（symbolic_simple 通用规则 /
  symbolic 深层规则），规则是数据（UPat+lambda），新 op 加新规则而非改机制。
- **`x*0→0` 有 NaN/Inf 守卫**（源码注释 `can be wrong if x is nan or inf`）：0 乘可能为
  inf/NaN 的值不能无条件折 0。**本方案砍掉 `x*0` 折叠**，只做安全规则。
- 编译管线 `full_rewrite_to_sink`（rewrite + simplify + 线性化）对 CPU 小图不适用——只取
  图重写层，不建 codegen/线性化器。

### 2.3 JS typed-array / 最小 AD 引擎经验（避免走弯路）
- **gl-matrix issue #358**：每次新建小 Float32Array 比普通对象慢 ~3×（不可复用中间量）
  → 印证融合/减少逐 op 分配是正确主攻。
- **micrograd-rs**：重度向量/堆分配拖慢 Rust 版 → 同样的教训。
- **TVM PR #18961**：在 per-dispatch closure 外预分配 typed-array 视图 + ArrayBuffer，消除
  分配 → 支持分配复用方向。
- **Bernstein 自动向量化 micrograd**（`+`/`*` 节点优化成 `Dot`）：图级 strength-reduction /
  融合的标准做法，PyTorch/TF 编译器同款，确认路径正确。
- 本引擎已是 Float32Array 全程（避免 f64↔f32 转换开销），缺的是**分配复用/融合**。

### 2.4 AD 文献
- **Activity analysis**（Clad 等，有 context/flow-sensitive 对比）：静态识别 active/passive 变量、
  跳过死 adjoint 代码 —— 即本方案的 ④，学界当正规优化而非技巧。
- **分配/间接开销是反向 AD 已知痛点**（LAGrad/MLIR、FastAD/向量化+紧凑布局、tape prefetching）
  —— 印证 ① 融合的价值定位（减少分配与内存扫描）。

### 2.5 不适用项
- TVM/XLA/torch.compile 的融合为省 **GPU kernel launch 开销**；本引擎是 CPU 标量小图，
  无 kernel launch。只取图层面（hash-consing + 构建期化简 + 一次全局 pass）与 activity analysis。

## 3. 可扩展性契约（用户决策：往上加要不要继续调整？）

**答案：加"内容"（图更深/批量更大/头更多）机制零调整；加"算子种类"是 O(1)/op 的数据行成本。**

三条原则：
1. **op 无关的机制**：CSE（结构去重）、activity analysis（图级数据流）、通用 elementwise 融合
   （见下）都对 op 语义无感 —— 新算子自动白拿。
2. **每 op 最小数据行**：新算子 = Op 枚举一项 + `evaluate()` 一个 case + `localGradients()` 一个
   case + 声明式元数据表一行（`isElementwise` 等）。这是"加一个算子"的定义成本，常数、不滚雪球。
3. **融合必须通用，不许逐算子手写**：通用 elementwise 融合调度器（任何连续 elementwise 链
   自动融成一个 kernel），只对结构性非 elementwise（matmul+bias、softmax 族）保留手写特例。
   否则每加一个激活函数就要手写一条融合规则（TinyGrad #3679 与 Korch 批评 greedy fusion 的教训）。

## 4. 实现方案

按依赖顺序（每步测试护航，`npm run bench:autodiff` 前后对比）。

### 4.1 ② 代数化简（构建期局部规则，最安全）
`add`/`multiply`/`negate` 等 builder 内联折叠：
- `x * 1 → x`、`x * (-1) → negate(x)`（已存在）、标量×标量 → 标量
- `x + 0 → x`、标量+标量 → 标量
- `negate(negate(x)) → x`、`reciprocal(reciprocal(x)) → x`
- 效果：梯度图变小（sigmoid/reciprocal/sqrt 的局部梯度链显著收缩），反向更省。

### 4.2 ④ activity analysis（死路径剪枝）
`computeGradients` 加"可达 Parameter"记忆化 DFS：只沿能到达 Parameter 的路径构建/累积梯度，
跳过只通向常量的子树（其梯度永远不会被 `backward()` 读取）。图级、op 无关、一遍遍历。

### 4.3 ③ CSE / hash-consing（TinyGrad 核心机制）
- 给 UOp 加稳定 `id`；中间算子（Add/Multiply/Matmul/…）按
  `(op, shape, arg, sourceIds)` 结构驻留（Map 缓存），重复子图共享同一对象、只算一次。
- **常量/参数不驻留**（数据可变：Parameter 被 `gradientStep` 修改），保持独立对象。
- 图大小收缩 + 求值去重。

### 4.4 ① 通用 elementwise 融合（求值器层）
- 引入 `fusedRead(node)`：elementwise 链递归合成一个 `{length, read(i)}` 访问器，**不物化中间数组**；
  顶层一次性分配 + 一遍扫描。
- elementwise op 集合（声明式元数据）：Add/Multiply/Negate/Broadcast/Exp/Log/Reciprocal/
  Sigmoid/Sqrt（Broadcast.read(i)=源[0]，顺带消灭 broadcast 全填充）。
- 非 elementwise（Matmul/Sum/SumN/Index/Scatter/Transpose/Softmax/L2Normalize 及两个
  Gradient op）走现有 materialize 路径。
- 效果：`log∘sigmoid∘(matmul+bias)` 整链从 N 次分配+扫描 → matmul 一次 + 一次融合结果。
  controller 的 BCE 链收益最大。
- **matmul+bias 特例**：`add(matmul, broadcast(bias))` 中 broadcast 不物化（bias 标量直接读），
  无需单独 kernel 就拿到大部分收益。

### 4.5 验证
- `npm run test:cg`（autodiff + differentiable-controller 等）必须全绿（数值不变）
- 完整套件 `node --experimental-strip-types --test "tests/**/*.test.ts"`
- `npm run bench:autodiff` 前后对比（期望 controller_train 1.5–2.5×）
- 每类优化补 op 存在性/数值断言测试
- ESLint + `npx tsc --noEmit`

## 5. GPU 实验（可选、独立模块，不碰生产）

- 栈：**in-process WebGPU（`webgpu@0.4.0`，Dawn native）** —— 本机已实测跑通
  （RTX 3060 Laptop，adapter=nvidia/ampere，WGSL matmul 数值正确）。
  选它因为**进程内**、能真正嵌入训练循环（非浏览器 IPC）。
- 定位：UOp op 集的 WGSL kernels 做成 `Tensor` 可选后端（`src/lab/gpu/`）；用生产真实形状
  跑 CPU 现状 / CPU 优化后 / GPU（含完整往返）三方基准，产出 **crossover 曲线**。
- 诚实边界：当前生产形状（每步 O(D·n) ~几十µs）GPU 必输（launch+搬运 ~50–200µs）。
  GPU 主场是**批量/离线训练**（一次 backward 上千样本）；crossover 曲线把"何时该用 GPU"
  用数据钉死。

## 6. 预期收益与风险

| 项 | 预期 | 风险 |
|---|---|---|
| ② 化简 | 梯度图收缩，反向 1.2–1.8× | 低（局部规则，数值有测试） |
| ④ activity | 图构建分配减少（小） | 低（图级分析，证明见 §4.2） |
| ③ CSE | 图去重，配合 ① | 中（改全局构造，需保 Parameter/Constant 语义） |
| ① 融合 | controller_train 1.5–2.5× | 中（求值器重构，数值一致性靠测试） |
| GPU | crossover 数据 + 可选后端 | 中（依赖机器 GPU，仅实验模块） |

## 8. 实证结果与决策框架（什么时候做 + 做的思路）

### 8.1 实测结果（2026-08-10，`npm run bench:autodiff`，3 次取中）

| 基准 | 基线 | 现状（②④） | 说明 |
|---|---|---|---|
| l2_normalize_backward_128 | ~14.8µs | **~8µs（1.8×）** | 化简 + activity + eval 微优化 |
| controller_train_f32_b32 | ~91–98µs | ~91–97µs | 中性（回基线） |
| matmul_forward | ~79–82µs | ~73–82µs | 中性 |

- ②（化简）+ ④（activity）对 **backward 重**的负载（l2）真实受益：梯度图变小 + 死路径剪枝。
- ①（通用闭包融合）**实测为负优化**（controller 105–113µs）后回退：`read` 闭包占 profile
  38.8%；5 层链 × L 元素 = 5L 次 ~50ns 闭包调用，任何数组尺寸下都比内联逐 op（5 次循环 + 小分配）贵。
  小数组下分配可忽略，闭包开销反而主导 → 融合不适用本引擎当前尺寸。
- profile 揭示 controller 真实瓶颈是 `evaluate` 解释器本身（55.5%：Map 缓存 + 分派 + `.map` 闭包），
  而非分配——这是后续若做 controller 优化的正确方向（解释器/调度优化），且因负载非瓶颈而暂缓。

### 8.2 决策框架（先 profile，再选技术；技术有适用窗口；测完不对就回退）

**判断"什么时候做"的三个问题：**
1. 这个负载是不是瓶颈？（非瓶颈 → 不做；controller 是周期性训练，非瓶颈）
2. 时间花在哪？（必须 profile，不预设；controller 花在解释器，不是分配）
3. 这技术针对的是不是那个瓶颈？（融合针对分配，而瓶颈不是分配 → 不做）

**各技术的适用窗口（when）：**
- 融合：分配/启动开销占主导 → **大数组、大批量、GPU**。小 CPU 数组下是负优化。
- 化简：梯度图构建/求值占主导 → backward 重负载（l2）。
- activity analysis：存在死常量分支 → 部分负载（l2）。
- CSE：图很大、重复子树多 → 大模型/长序列；小图下 intern key 构建开销 > 收益。
- 解释器优化：图小但反复求值 → 本引擎 controller 的真瓶颈，因非瓶颈负载暂缓。

**执行纪律：** 每项优化 profile → 实施 → 前后对比 → 回归就回退。证据 > 假设。

### 8.3 编译模式（结构复用）实证（2026-08-10，`NMG_AUTODIFF_COMPILE=1`）

实现 §9 的范式：controller 图拓扑跨步稳定 → 首次 backward 把 forward+backward 图都编译成
扁平 tape（预分配缓冲、共享执行内核 `executeFlatOp`、forward 中间值按位置供 backward tape 读），
后续每步只 rebind 叶子数据 + 顺序执行两条 tape，跳过 computeGradients 与 Map 缓存求值。
默认关闭（env 门控），开启时：

| 基准 | 基线 | 编译模式 | 说明 |
|---|---|---|---|
| controller_train_f32_b32 | ~90–105µs | **~44–46µs（2.2×）** | forward+backward 都走 tape，跳过 computeGradients |
| matmul_forward | ~73–78µs | ~73µs | 中性 |
| l2_normalize_backward | ~7.4–10µs | ~7.8–9.7µs | 中性（L2Normalize 不编译，回退解释器） |

- 纯 tape 执行：49 节点 forward 图 **1.5µs/run**（~30ns/op，比解释器约快 50×）；`bwdCompiles=1`
  证明 backward 只编译一次、后续全复用。
- **正确性**：编译模式全局开启时 665/665 测试全过（含精确梯度 `<1e-7`）；参数身份守卫保证
  同结构不同模型不会串用缓存梯度。
- **关键设计教训**（两次失败后才收敛）：
  - ① 字符串结构签名 + 每步重算 → 每步 2 次 O(V) 遍历，缓存簿记开销吃掉全部收益（净回归）；
    → 改为单槽会话 + 一次 rebind 遍历（结构不符即回退），不再算签名。
  - ② data getter 曾负责建会话 → 被 `gradientStep` 的 `parameter.data` 叶读取冲掉，导致 backward
    每步重编译；→ 会话只归 backward() 拥有，data getter 只复用、永不替换。
- **与 §9 预估（~20–30µs）的差距**：透明 hook 每步仍付一次 rebind（对新图做 O(V) 结构校验）+
  forward 跑两次（scalarValue + backward）。要打满需「compile-once」控制器 API——只 trace 一次、
  每步直接填输入缓冲跑 tape，零结构校验。当前负载（非瓶颈训练）下 2.2× 已足够，不追天花板。

### 8.4 SIMD 候选核验（2026-08-28）

本轮针对 `evaluateMatmul` 试验了依赖无关的 4 列循环展开，并用现有
`matmul_forward_f32_1x128_128x200` 基准比较。基线中位数为 `84.88µs/op`，展开版本为
`84.65µs/op`，约 `0.3%` 的差异落在多轮波动范围内；未保留该实现。矩形 `2x3 · 3x5`
的前向值与两侧梯度测试已加入，用于保护未来真正的向量化实现及非向量宽度尾部。

这里的循环展开不等于硬件 SIMD。若改用 WASM SIMD，还需承担 JS/WASM 调用边界、内存复制或
共享内存布局、额外二进制与构建链成本。当前图控制器以几十到几百元素的小张量为主，既有编译
模式已将控制器训练降至约 `44–46µs`，此时优先优化调度和结构复用，收益高于局部算术内核。

只有同时满足以下条件才重启 SIMD 工作：

1. profile 显示 matmul 或其他逐元素算术成为端到端主瓶颈；
2. 真实工作负载稳定落入足以摊薄调用和复制成本的尺寸区间；
3. benchmark 覆盖小矩阵交叉点、常见矩阵和非向量宽度尾部，并给出稳定的端到端收益；
4. 实现可作为可选 kernel 后端，不把 WASM 构建要求扩散到 NMG Core 的默认安装路径。

## 9. 本约束下的 HPC 手法（深调研结论）

约束画像：CPU/JS(V8)、小数组（几十~几百元素）、动态 UOp 图每步重建、逐步在线训练、
实测瓶颈 = 解释器(55%) + 图构建 + Map 缓存 + 每步分配。

**核心范式：不是微优化解释器，而是换执行模型——“每步构建+解释” → “编译一次+复用”。**
（torch.compile FXGraphCache / MLX compile-and-cache / JAX jit / jax-js 全部收敛于此；
MLX issue #1828 也反面印证：惰性图在小 kernel 高频调用下反而更慢。）

适用本引擎的技法（按 ROI 排序）：
1. **结构缓存/编译模式**：controller 图拓扑跨步稳定（仅数据变）→ 首步 trace 成扁平 op-list +
   固定节点索引；后续每步只填数据缓冲 + 顺序执行扁平 tape。消除 UOp 构建、Map 缓存、分派、
   每步分配，直接打中测量的 55% 解释器成本。预计 controller ~95µs → ~20–30µs。
2. **按节点索引缓存中间缓冲 + 缓冲池复用**（anneal node-indexed cache、cudagraph_trees
   pool 共享）→ 消除 3.6% GC + 每步分配。
3. **扁平 tape 执行**（oximo tape、PyTorch eager 减支）：树递归 + Map<UOp,Float32Array>
   → 线性指令表 + 索引数组。
4. **V8 循环卫生**（v8.dev elements-kinds）：永不越界读（有 6× 性能悬崖案例）、保持 packed、
   避免元素类型迁移、热路径只用 typed array、热函数单态。当前 evaluate 已满足（`i < arr.length`、
   Float32Array、packed）——守住即可，勿破坏。
5. **codegen 单函数**（JAX jit / aesara→C）：`new Function` 每图发一个融合 JS 函数，零分派。
   最深但带 CSP/deopt/生成函数 GC 风险；仅当前 1–3 不够时用。

**when（什么时候做）**：1–3 是改执行模型，收益大、风险中。按 §8 框架，当前 controller/activation
是非瓶颈周期性训练 → 触发条件是 (a) 训练量上规模（批量化/离线/多头）或 (b) 进查询热路径。
**已实证（§8.3）**：以 `NMG_AUTODIFF_COMPILE=1` 编译模式落地，controller ~2.2×（90→45µs），
665/665 全过，env 门控默认关。训练一旦成瓶颈或规模化，直接开该模式即可；若追天花板再上
compile-once 控制器 API（省掉每步 rebind 校验 + 双重 forward）。

## 10. 后续

- ~~controller 若成瓶颈：优化 evaluate 解释器~~ → **已落地为编译模式**（§8.3，`NMG_AUTODIFF_COMPILE=1`）：
  forward+backward 双 tape + 结构缓存 + rebind，controller ~2.2×；env 门控，默认关。
- 若训练规模化/成瓶颈：启用编译模式；追天花板再做 compile-once 控制器 API（每步零结构校验）
- GPU 后端在训练改批量/离线时启用（大数组窗口，融合/向量化才成立）
- CSE 在大图负载出现时再评估
- 高节点数场景（如需要）再评估 matmul 内核微优化（Markowitz 式启示：先图结构后局部 kernel）
