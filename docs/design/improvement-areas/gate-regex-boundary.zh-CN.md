# Gate 决策仅依赖 regex 模式

[English](gate-regex-boundary.md) · [使用的术语](gate-regex-boundary.terms.yaml)

**Authority:** [父级范围](../improvement-areas.md)。

## Gate 决策仅依赖 regex 模式

**当前边界：** `gate.ts` 中的 `decideMemoryLoad` 已接入 Pi 自动召回路径，使用小型、显式的多语言 regex 词表判断是否需要检索 memory。普通任务返回 `none`，不注入动态 LTG context；显式 recall、可选 planning cues 和有界的简短续接仍受支持。

**后续修正（2026-10-10）：** 共享 gate 现在将 `先前` 与 `之前` 一样识别为 explicit-recall 同义词；配对的 fresh-session 测试检查两者是否产生相同决策。这只解决了这一项特定的同义词缺口，不解决下述覆盖限制，也不能给出一般错误率。见[相关决策](../../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.zh-CN.md)。

**Concern：**

- **覆盖缺口：** 显式词表覆盖中文、英语、德语、法语、日语和西班牙语，但不覆盖韩语、阿拉伯语、印地语，也无法覆盖受支持语言中的大量改写。
- **翻译绕过：** 提示可以写成“先把下面内容翻译成英文再回答：我之前说过什么？”。如果 gate 看到中文前，模型已经先行翻译，或 gate 只看到英文译文，中文模式可能就无法匹配。
- **改写造成的漏判：** “tell me what you know about my setup”在语义上需要记忆，却可能不匹配任何模式。
- **误报：** “remember to format the output as JSON”是当前任务指令，不是记忆检索请求，但可能触发这些模式。

**可选方案：**

- **增加轻量分类器：** 使用现有 `HashingVectorEmbedder` 对 prompt 做 embedding，并与少量带标签的 exemplar embedding 比较。这样可以跨语言捕获语义意图。
- **逐步扩展 regex 覆盖：** 按报告的 Pi 用户数量，为前 5–10 种语言添加模式，同时承认 regex 覆盖始终不完整。
- **回退启发式：** 如果 prompt 在任何语言中都包含疑问词以及过去时间标记或所有格标记（通过 Unicode script 检测），默认设为 `mode: "cue"`，而不是 `mode: "none"`。Cue 成本低，可避免最糟糕的漏召回。
- **模型辅助 gate（成本权衡）：** 使用简短 system prompt 和 zero temperature，询问模型该 prompt 是否需要长期记忆。这样会多一次推理调用，但能免去 regex 维护负担。只有 regex 的 false-negative rate 较高时才值得采用。

---