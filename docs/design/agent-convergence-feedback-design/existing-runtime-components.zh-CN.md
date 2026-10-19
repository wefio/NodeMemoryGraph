# 系统已经具备的东西

[English](existing-runtime-components.md) · [术语](existing-runtime-components.terms.yaml)

**Status:** draft
**Authority:** [上层范围](../agent-convergence-feedback-design.md)。

## 系统已经具备的东西

### NMG 记忆（STG/LTG、Task Board）

在模型中的角色：**状态持久化**，即"错误不是吸收态"这一前提——失败的会话可以从已记住的状态恢复，证据能跨越会话边界存活。它同时是**跨会话目标连续性**的天然载体：一个活过单次会话的目标，正是"从下一条提示重新推导意图"与"继续某个方向"之间的差别。

已具备：LTG/STG 分离、取代（supersession）、真值状态治理、带 claim 与 TTL 的 Task Board 协调。

缺口：经外部批准的长期任务**不是一等记忆公民**。看板条目是临时协调（带 TTL、会过期），不是持久任务存储。

### RCP（Repository Control Plane）

在模型中的角色：**外部验证者**——昂贵、稀疏、无偏的纠正。contract 声明意图；observe 度量现实；reconcile 检出漂移（变更路径、contract 与现实之间的诊断）；receipt 是不可变检查点；authority（plan/apply）决定步幅大小。

已具备：contract/observe/reconcile、幂等的重新观察、changedPaths、失败即关闭的终止、receipt。

部分接线：显式 CLI opt-in 会把新记录的 receipt 作为有界反馈送入具名会话的 AG（见上面的实现边界）。通用的漂移/生命周期流式传输、重试重放与跨会话记忆准入仍未完成。持续观察被推迟，直到其需求被度量。

### AG（会话 Active Graph 运行时）

在模型中的角色：**会话内闭环**——工作记忆层，纠正在这里发生而不触碰持久真值。

已具备：带**有界冷却集**的任务帧（状态能活过一次任务切换，返回时不必从对话记录重建——即可恢复驱逐性质）、带父链的不可变投影修订（检查点序列 + 归因），以及 `observe()` 对工具观察、看板投影和显式提供的推理产物的准入（临时、去重、受预算约束）。类型化边层阻止激活/推理悄悄强化语义真值。条目类型为 `semantic_memory | tool_observation | board_projection | reasoning_artifact | working_state`；语义记忆与受维护的工作状态分别通过各自路径进入。自动 MGR 准入仍被推迟。

部分接线：RCP receipt 可经由显式的可选客户端 bridge 到达 `observe()`。外部文件片段不是一等 AG 内容类型：`observe()` 也接受显式提供的 `reasoning_artifact` 条目，但定位书签（[定位书签（tesserae）](#定位书签tesserae)）——外部 snippet 加路径——本身不能作为内容加入。自动 MGR 准入仍被推迟。当一个 memory 以 `semantic_memory` 条目进入 AG 时，只有它的 `statement` 随行（它的定位书签不会同行）。合并预算（AG 蓝图 §4.3）是部分的。把外部文件内容加入 AG 属于 AG 的能力；为此不需要任何其他新概念。

### 定位书签（tesserae）

在模型中的角色：把记忆指向某个源文件位置，并尝试解析已存储内容片段的组件。在有 project root 时，当前重定位先在存储路径查找该 snippet，再使用文件指纹限制后备扫描范围；它可以返回第一个匹配行，但重复片段并不能确立唯一位置。在可访问视图和有界流程内，解析未命中可以把定位书签标为 stale；这不能证明文本在任何地方都不存在。没有 project root 时，服务不会执行这项读取检查，因此没有 stale 标记并不能证明内容仍新鲜。仅当文件在写入时可读，写入时文件指纹才锚定文件基线；若指纹缺失，后来根据当前字节补算也不能证明原始写入时内容。

定位书签同时是**AG 应当能够摄入的内容**：它把一个外部片段（snippet 文本 + 路径）带入会话工作记忆。AG 是容器；定位书签是可摄入内容。这种摄入今天并未发生：memory 条目进入 AG 时并不带它们的定位书签。

已具备：在记忆时写入的 `{path, snippet, label}` 记录；两级重定位（先精确匹配，再由指纹限制的恢复）。漂移恢复使用目标文件的可选 64-bit SimHash 指纹（`file_simhash`）。相关[定位书签设计](../memory-tesserae-design.md#33-tesserae-are-content-anchored-not-line-anchored)记录了较早的 5–60 KB 仓库文件样本中 Hamming ≤ 6 的阈值，以及报告的 100% 召回与 0.24% 假阳性；该设计没有重新核验底层样本与比率，这些也不是普遍保证或 snippet 指纹的测量。**SimHash 是定位书签组件内部的漂移检测技术，不是独立的系统组件。**

缺口：定位书签尚不能作为外部文件内容摄入 AG。当前指纹针对文件，不是任意 snippet 的指纹。把"固定基线并度量漂移"的思路用于其他被摄入内容（一份 contract、一个期望的最终形态）是复用定位书签方法的设计提议，并非现有能力。
