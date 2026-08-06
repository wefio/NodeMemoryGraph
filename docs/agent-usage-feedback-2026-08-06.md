# NMG agent 侧使用反馈（2026-08-06）

来源：Kimi harness 下一个真实使用 NMG 的 agent 的一手反馈。背景是会话中实测
`nmg_search`（中英混合查询）、`nmg_remember`，并完成 `nmg inspect` TUI 的
一整天协作。

## 1. 写入靠自觉，记忆就漏（最重要）

记忆系统对 agent 的价值取决于"不用想也会写"。当前写入完全依赖 agent/harness
主动调 `nmg_remember`：一次长时间会话中的关键决策（技术选型理由、踩过的坑、
用户偏好）如果没人主动记，库里就是空的。实测：一整天 inspect 开发后检索
相关决策，零命中——因为一条都没写过。

- pi 侧已有 hook 机制：可配置关键词（commit、"完成"等信号）触发写入提醒。
- Kimi harness 目前没有等价物。可考虑：harness 层的 stop-hook / 关键词监听；
  或 NMG 侧提供"会话结束时一键总结写入"的工具（输入 transcript，LLM 提取
  候选记忆让人/agent 确认）。
- 短期缓解：在 nmg 工具返回文案里加入轻量写入引导（类似 search 结果里
  "call nmg_get once" 的提示风格），在适当时机提醒 agent 落库。

## 2. 中英混合查询召回偏弱

查询同时含中文和英文术语时，命中的是"话题相邻"而非"内容相关"的记录。
根因已知：`memory_fts` 用 unicode61 分词，不切中文（inspect 的搜索层已为此
做了 CJK → LIKE 回退，见 `src/cli/inspect-data.ts`）。检索主路径值得同样
处理：

- 检测 CJK 查询走子串/逐字匹配兜底；或
- 换支持中文的分词器（jieba 类、fts5 trigram）；或
- 依赖向量召回补足（但 hashing embedder 对中文同样弱）。

## 3. header 预览截断太狠

`nmg_search` 的 statement 预览约 80 字符，长句从中间硬断，agent 经常被迫
追加一次 `nmg_get` 才能判断相关性。建议：预览长度翻倍，或按句号/换行等
语义边界断句。token 成本的增加远小于多一次工具往返。

## 4. nodeName 靠现场编，图会碎

写入时 nodeName 由 agent 即兴命名，同一主题跨会话容易起不同名字，节点图
随之碎片化（merge 是事后补救）。建议：搜索零命中或写入时，返回"现有相近
节点名"提示（向量近邻 top-3 节点即可），引导复用而非新建。

## 附：做得好的地方

- 本地、离线、低延迟（~15ms），perf 行透明；
- 渐进披露（header → nmg_get）对 token 友好，引导文案清晰；
- `nmg_remember` 参数面收敛得当。
