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

- [ ] `npm run verify:static` 通过（build / package:check / check / check:lock / lint / format:check / docs:check / agent:context:check / complexity:gate / verify:packages）
- [ ] `npm run test:product` 通过（或按改动路由跑 `npm run agent:verify -- <路径>`）
- [ ] 改了依赖或 lockfile 时：`npm run check:lock` 通过、根 `package-lock.json` 已同步、`npm audit --omit=dev --audit-level=high` 无漏洞
- [ ] 改了子包（`dsh/dsh-nmg` 等）时：`npm run verify:packages` 通过（frozen-lockfile install + build），`pnpm-lock.yaml`/lockfile 随 package.json 同步
- [ ] 文档改动跑过 `npm run docs:check`；决策/设计改动遵循 doc-maintenance 规范
- [ ] 新代码方法圈复杂度不超阈值（CodeFactor / `npm run complexity:gate`）
- [ ] 未提交可再生产物：`dist/`、`dsh/dsh-nmg/lib/`、`src/prompts/nmg-prompts.generated.ts`、`.nmg-search-scope` 不入库（见 `docs/decisions/rejected/2026-09-02-track-build-artifacts-in-git.md`）

### RCP（Repository Control Plane）

<!-- 逐项给出可执行命令：模板是操作层检查表，照命令跑完即完成该项自证。
     命令细节见 skills/repo-development/SKILL.md 的
     "Repository Control Plane beyond agent:verify" 节。 -->

- [ ] 首个实质写入前已在 `repo-development` 黑板登记 in-flight goal：
      `nmg board put repo-development "goal=…; approach=…; scope=…" --agent <id> --kind goal`（已 resolve）
- [ ] 改动路由的 reconcile 已通过并写入证据：
      `npm run agent:verify -- <改动路径>`（或 `nmg-rcp reconcile <contract> --apply --workspace-ready`）
      → `.nmg/verification/latest.json` 覆盖改动路由
- [ ] CI 全绿是用 RCP 观察确认的，不是人肉轮询：
      `nmg-rcp forge-status --pr <PR号>` 的 checks 全为 SUCCESS
- [ ] 只提交本 PR 拥有的文件；未吞并行 Agent 的暂存/工作树改动
      （`git status --short` 核对无他人文件）

### CI 完成确认

<!-- 用 RCP/forge 观察确认，不逐个 job 轮询。RCP 节的
     `nmg-rcp forge-status --pr <PR号>` 是权威读法；下面两项是其补充。
     CI 从 push 到全部检查完成通常约一分半，可稍等后 `nmg-rcp forge-status --pr <PR号>` 复查，
     不要按固定时长人工反复轮询或把“看起来在跑”当作“已通过”。 -->

- [ ] `nmg-rcp forge-status --pr <PR号>` 的 `All checks passed` 为 SUCCESS
      （或 CI Status Snapshot `.nmg-ci/status.json`：`conclusion: "success"` 且 `failures: []`）
- [ ] CodeFactor 通过
- [ ] Static job 通过（含 `verify:static` 全部子检查 + Dependency audit；audit 因上游新 advisory 失败时，先 `npm audit fix` 再更新 `package-lock.json` 提交，不要改 audit 门槛）

> CI Status Snapshot 是 GitHub 状态的只读观察（`authority: observation-only`），
> 不是授权或合并决定；合并仍需显式操作。
