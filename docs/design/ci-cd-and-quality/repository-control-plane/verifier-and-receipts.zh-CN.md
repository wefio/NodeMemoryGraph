# Verifier 与收据

[English](verifier-and-receipts.md) · [使用的术语](verifier-and-receipts.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.zh-CN.md)。

## Verifier 与收据

解释验证收据、查找来源或判断它能支持什么结论时，使用本参考。
Verifier 在 Agent 变更后独立运行，至少检查结构、行为、边界和来源四类问题。
收据是经 sink 追加写入的记录，不是操作日志，也不是自然语言完成声明。

### 识别结果背后的输入

以下片段只说明身份关系，不是可直接通过校验的完整收据。sink 还会提供规范化的
`receiptId`、gate/work-order gate 绑定与 harness 状态；不能把占位摘要提交为证据。

```json
{
  "receiptSchema": "repository.receipt/v1alpha1",
  "contractId": "rcp-001",
  "contractDigest": "sha256:...",
  "observedRevisionBefore": "sha256:...",
  "observedRevisionAfter": "sha256:...",
  "commit": "git-sha",
  "invocationId": "...",
  "verifier": { "id": "verify:product-ci", "digest": "sha256:..." },
  "workOrder": {
    "id": "wo-...",
    "routeDigest": "sha256:...",
    "routes": ["repository-control-plane"],
    "verificationChecks": ["check"],
    "budget": { "maxAttempts": 1, "timeoutMs": 1800000 }
  },
  "scope": { "declared": ["src/**"], "actual": ["src/**"], "matched": true },
  "checks": [{ "name": "...", "status": "passed", "evidence": "..." }],
  "decision": "verified"
}
```

规范收据绑定不可变的输入/输出身份。gate 必须与 work order 和 `fullGateRun` 一致。
`verified` 要求 scope 匹配、harness 完成，以及非空且全部通过的检查集；绑定 forge 的收据
还必须把 commit 绑定到 forge head。规范化自哈希由
[`validateReceipt`](../../../../src/rcp/receipt.ts) 检查。
这些检查通过只说明内部自洽，不认证历史执行。

### 区分收据与恢复状态

`FileReceiptSink` 在 Git 忽略的 `.rcp/receipts/` 中追加收据；其 `inflight/` 子目录保存
中断 attempt 的标记，不是收据或证明。正常终态处理会清除标记。遇到中断时，使用
[显式恢复路径](run-to-completion-cli.zh-CN.md#恢复时不重放-harness)，不要把标记当作成功，
也不要自动重放 mutation。

`npm run agent:verify` 同时写入 `.nmg/verification/latest.json`。唯一 authored Contract
完整覆盖所选 scope 时，它使用 workspace-ready RCP 验证。没有适用 authored Contract 时，
narrow 合成内存 Contract 并记录收据；full 执行普通 route 计划，不产生 RCP 收据。
多个 authored Contract 都完整覆盖时，先消除 intent 歧义，否则失败关闭。
检查选择由 [gate 规则](lightweight-verification.zh-CN.md)拥有。

### 区分本地审计与外部信任

收据用于本地幂等、恢复与操作者审计，不随 PR 传播；文件不是不可篡改的，也不能单独充当
第三方可验证证明。自哈希、文件名和确定性检查自洽，不认证来源，不证明执行确实发生。

GitHub required checks 接受受信 verifier 的结果。PR 正文与评论解释结果，不是唯一机器状态。
收据存储可以扩展索引或外部 artifact/attestation provider，但外部 provider 延后到确有跨机器
独立复核需求时再加入。

NMG 可以把收据作为来源引用，但不会自动写入 LTG；只有经独立 `remember` 路径接入、
可归因且可复用的经验才成为持久记忆。
