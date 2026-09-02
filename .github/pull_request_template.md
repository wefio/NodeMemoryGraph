## 变更描述

<!-- 用一两段说明这个 PR 改了什么、为什么改。遵循 ci-cd-and-quality.md 的
     Proof before trust：PR 文本不是修改成立的证据，检查清单与 CI 才是。 -->

**What**（改了什么）：

**Why**（为什么改 / 解决什么问题）：

**Changes**（关键改动点，按文件或模块列出）：

---

## 完成检查项

<!-- 合并前逐项核对。GitHub 拥有 PR/CI 状态；本清单只是让提交者自己先过一遍。 -->

### 本地质量检查

- [ ] `npm run verify:static` 通过（build / package:check / tsc / lint / format:check / docs:check / agent:context:check / complexity:gate）
- [ ] `npm run test:product` 通过（或按改动路由跑 `npm run agent:verify -- <路径>`）
- [ ] 文档改动跑过 `npm run docs:check`；决策/设计改动遵循 doc-maintenance 规范
- [ ] 新代码方法圈复杂度不超阈值（CodeFactor / `npm run complexity:gate`）

### RCP（Repository Control Plane）

- [ ] 首个实质写入前已在 `repo-development` 黑板登记 in-flight goal（条目已 resolve）
- [ ] `npm run agent:verify -- <改动路径>` 跑过 reconcile，`.nmg/verification/latest.json` 覆盖改动路由
- [ ] 只提交本 PR 拥有的文件；未吞并行 Agent 的暂存/工作树改动

### CI 完成确认

<!-- CI 完成后无需逐个 job 轮询：读 CI Status Snapshot 即可确认。 -->
- [ ] CI Status Snapshot（`.nmg-ci/status.json`）结论为 `workflow.conclusion: "success"` 且 `failures: []`
      —— 或 `gh pr checks <PR> | Select-String "All checks passed"` 出现且为 pass
- [ ] CodeFactor 通过

> CI Status Snapshot 是 GitHub 状态的只读观察（`authority: observation-only`），
> 不是授权或合并决定；合并仍需显式操作。
