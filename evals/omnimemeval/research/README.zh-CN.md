# OmniMemEval 研究工具

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

这些文件是诊断或假设检验工具。它们不定义公开的 benchmark 执行路径、官方 prompt 或 NMG 运行时默认值。可复现的 suite 执行请使用父目录的 `run.ts`、`benchmark.config.json`、`bridge.ts` 与
`README.md`。

## 布局

- `audits/`——检视已完成的结果工件、检索覆盖、QPP 信号与排序分布。除非它们自己的命令如此声明，否则不调用答案模型。
- `probes/`——针对检索、HyDE、渐进披露、MGR 与答案行为的有界机制检查。把结果当作实验证据。
- `ablations/`——配对的反事实臂，例如反向检索、分页与 PersonaMem 变体。它们不得静默变成产品策略。
- `polarity/`——离线抽取、规范化、校验与 BEAM 专属极性实验。

仓库级脚本有意只通过 `package.json` 暴露受维护的审计与消融入口。只有在复现拥有它的那个实验时才直接运行未列出的文件，并把结论记录在
`docs/experiments/` 里，而不是把该脚本提升成第二条 benchmark 流水线。

## 前缀缓存假 API

`probes/fake-cache-api.ts` 是一个独立的、OpenAI 兼容的测试端点。把一个 benchmark 的 chat base URL 指向它，并保持该 benchmark 的请求路径不变。该端点返回一个固定的兼容完成；它不调用 NMG、tokenizer 或模型。

对每个真实的 UTF-8 请求体，该端点在固定字节边界上计算链式 SHA-256 检查点。只保留
`(cumulative length, hash, arrival
time)`。匹配的哈希只在长度相等时比较，因此最后一次匹配估计的是理论最长公共字节前缀，误差小于一个块。prompt 文本在哈希后即丢弃，永不进入报告。

```powershell
node --experimental-strip-types `
  evals/omnimemeval/research/probes/fake-cache-api.ts
```

把 `http://127.0.0.1:8788/v1` 用作 chat base URL。从
`GET /__cache/report?profile=normal-cloud` 读取估计值，或用
`POST /__cache/reset` 清空内存中的 trace。默认块为 512 字节，可用
`CACHE_PREFIX_BLOCK_BYTES` 更改。内置的 `local`、`normal-cloud` 与
`slow-cache` 画像估计队列、网络、缓存构建与过期成本。

这测量的是序列化字节前缀潜力，不是 provider 的 token 缓存语义。provider 可能规范化消息、以不同方式分词，或使用未文档化的最小缓存块。用它来在不付费调用的情况下比较请求顺序与布局；provider 报告的缓存命中／未命中 token 仍是计费的真理来源。
