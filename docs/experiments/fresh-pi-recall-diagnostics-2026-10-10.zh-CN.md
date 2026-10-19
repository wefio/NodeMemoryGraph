# Fresh Pi 召回：匹配问题与准备阶段时序

[English](fresh-pi-recall-diagnostics-2026-10-10.md) | [简体中文](fresh-pi-recall-diagnostics-2026-10-10.zh-CN.md) · [术语](fresh-pi-recall-diagnostics-2026-10-10.terms.yaml)

## 范围

本实验诊断 2026-10-09 的 fresh-Pi smoke 对照，并检查[召回修复](../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.zh-CN.md)。它不测量最终 provider 传输、模型成本或任务连续性。

## 历史对照

普通 discovery prompt 使用 `先前提出过哪些实现约束`；显式 NMG prompt 使用 `之前提出过哪些实现约束`。在基线 revision `e1a3e20681f77adf07965db3d5b518e36ffd0a2e` 上，共享 gate 对前者选择 `none`，对后者选择 `retrieve`。因此 0 对 5 个候选并不是受控的扩展发现对比。`tests/core/gate.test.ts` 的回归测试使用同一个问题，只改变这个同义词。

两个历史模型都完成并结算，但工具报告了 timeout。日志显示首条模型消息前分别约有 152 秒和 97 秒；这不是测得的关闭时长。没有记录内部阶段，因此原因仍未知。

## 通过原生 SDK 进行受控准备

环境：Windows、Node v24.19.0、已安装 Pi 1.1.0。使用基线 revision 加上验证 run `0d293ecc-8ed8-4434-9377-b2c570130603` 记录的限定修复。复用了现有 shared daemon 和数据库；未修改 Pi 安装文件。

两种 discovery 模式均使用以下完全相同的问题：

> 用户对 NodeMemoryGraph 的 AG 状态与可见内容改进，先前提出过哪些实现约束？请仅报告本轮自动召回的候选，不把候选当已核实事实。

公开 SDK 调用序列为：使用批准 trust-resolution callback 的 `DefaultResourceLoader.reload`；用内存 session 和 `noTools: "all"` 调用 `createAgentSession`；接着 `bindExtensions`，再调用 `emitBeforeAgentStart`。Theme 初始化未启用 watcher。准备阶段收到有效 system-prompt options，包括 `cwd`；结果从 `messages` 与 `systemPromptOptions` 读取。

| 观察项 | 普通 discovery | 仅显式 NMG |
|---|---:|---:|
| Resource loading | 1779.846 ms | 218.233 ms |
| Session creation | 47.320 ms | 42.245 ms |
| Extension binding | 1070.608 ms | 22.312 ms |
| Recall preparation | 853.368 ms | 647.928 ms |
| Candidate rows | 5 | 5 |
| Load／handler errors | 0 | 0 |
| NMG policy present | yes | yes |
| Model calls | 0 | 0 |

Candidate 数量只计候选行，不计 `fields: memory=id` 格式图例。两个 surface 都暴露了 lexical degradation，原因是 `embedding_unavailable`，没有显示 provider quota／response body。每个 probe 都通过普通 RPC 释放自己的 runtime session、dispose SDK session、让共享 daemon 保持运行，并避开 shutdown archive hook。没有插入测试 memory 或 session archive。

这些样本证明准备阶段经过了已安装的原生 hooks。它们不能证明后续真实模型请求会包含该消息、排序随时间稳定，或每个 host extension 在每个 turn 中都无害。先前的显式 NMG 模型 read-back 属于另一份独立证据。

## 确定性生命周期与渲染检查

Archive regression 发现写入已 resolve 后仍遗留一个活动 `Timeout`；失败 run 保留了五秒 deadline。修复后的 helper 会释放该资源，而 write 卡住时仍会暂存 archive。现有自有 daemon 关闭集成测试覆盖成功、失败与 daemon 已退出的 archive 路径。这不构成 Pi 进程必然退出的完整保证。

渲染回归保持原有 frozen provider diagnostic 不变，将 429／503 映射为有界 cause codes，保护旧的 raw compact DTO，并在结果为空时仍保留 health。已有 code/index reason codes 保持稳定；未知 provider 文本不会进入 model-facing text。

首次直接产品调用输出了 1681 个通过测试，但外层工具 timeout。随后 canonical `agent:verify` 记录所有 blocking 命令（包括 `test:product`）均以 exit code 0 结束。报告有意区分测试摘要与可观察的进程／检查退出。

## 证据与局限

本地 JSON／日志 artifacts 位于 `.nmg/verification/`；它们是可选加速材料，不是第二份契约。共享 gate、renderer、archive 代码、回归测试和所链接的决策记录保留了可恢复的发现。

没有要求新的 live LLM response 或 benchmark。自动准备使用 daemon 配置的检索路径；这不是 embedding-budget 研究。历史长启动时间以及完整 CLI／模型／退出边界仍未验证。未来真实回合复现可使用现有 opt-in `/nmg-latency on` observer，无需修改 Pi 或替换其 transport。