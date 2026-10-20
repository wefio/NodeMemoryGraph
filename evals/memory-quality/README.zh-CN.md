# 记忆质量不变量套件

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

用以下命令运行：

```powershell
npm run eval:quality
```

这个确定性开发套件覆盖七个 P1 失败类别：时态状态、多记录聚合、冲突证据、多跳图可达性、精确冷细节、密钥拒绝，以及瞬时记忆污染。它在没有 LLM 的情况下测试机制与不变量，因此补充而不是替代 LongMemEval 与 Pi 端到端 agent case。
