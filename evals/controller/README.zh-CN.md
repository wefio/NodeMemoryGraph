# 可微控制器评测

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

本实验把检索控制与答案生成隔离开。它使用 LoCoMo 与 BEAM 提供的官方证据标识符，
并且不进行任何模型 API 调用。

```bash
npm run eval:controller -- locomo 4
npm run eval:controller -- beam 4
```

对每个用例，runner：

1. 把原始 benchmark 轮次导入全新的 NMG 存储；
2. 执行一次确定性的 `searchContext` 检索；
3. 把检索到的记忆与官方证据 ID 求交；
4. 把完成的轨迹转换成带版本的 32 特征协议；
5. 在每个类别中除最后一条之外的用例上训练；
6. 在同一批留出候选与 Top-N 预算上比较确定性有用性排序与学习到的节点排序。

报告把候选召回与排序召回分开。这个区分是本质性的：候选生成从未返回的证据项，
控制器无法把它找回来。

报告使用两个独立闸门：

- `controllerGate` 检查带标注训练量、留出召回的精确率不退化，以及有界的推理
  成本；
- `retrievalGate` 检查上游候选召回是否至少为 0.8。

通过 controller gate 即使候选生成仍弱，也允许 shadow 评测。Active/默认 Pi 资格
要求两个闸门都通过。runner 报告这些状态，但从不改动 Pi 扩展的配置。

## 结果政策

历史上的临时 BGE 与哈希运行已从本文件中移除，因为它们使用了变化的样本、提示词与
语料重建策略。它们不是可复现的能力证据。

新的控制器结果必须来自当前 runner，保留其 `sampleFingerprint`，使用官方 benchmark
证据 ID，分别报告候选闸门与控制器闸门，并为随机 reader 模型包含重复试验。原始
结果留在被忽略的本地目录中。
