# 固定可信基线验证

[English](trusted-baseline-verification.md) · [使用的术语](trusted-baseline-verification.terms.yaml)

**Authority:** [所属范围](../repository-control-plane.zh-CN.md).

## Fixed trusted baseline verification

需要用已审阅的固定规则验证候选 commit 时，使用本节的显式本地命令。普通
`reconcile` / `agent:verify` 不自动获得这种基线隔离保证。本节与
[RCP 决策](../../../decisions/implemented/2026-08-29-repository-control-plane.md)
共同拥有此选择；普通轻量门的选择规则另见
[gate 规则](lightweight-verification.zh-CN.md)及其
[决策](../../../decisions/implemented/2026-09-07-rcp-lightweight-verification-default.md)。

### 安装前确认输入与目录

操作者先明确审阅一个包含本功能和验收策略的 commit，再安装该版本。安装不自动提交
工作区，也不自动信任候选。

命令中的占位符须替换为实际路径或 commit：`<repository>` 是提供已审阅基线的仓库；
`<reviewed-commit>` 是该固定版本；`<new-external-directory>` 是新的外部安装目录。
该目录的父目录必须存在，目标目录必须不存在，且目标必须位于候选仓库之外。

安装只接受普通文件，拒绝 symlink 和 submodule；读取 Git 的输出上限为 256 MiB。
这些限制不满足时，不能把缺少安装环境当作验证通过。

### 安装或升级可信基线

```text
npm run rcp -- trust-install <repository> <reviewed-commit> <new-external-directory>
```

安装读取固定 Git commit。存在 lockfile 时，自动运行
`npm ci --ignore-scripts --no-audit --no-fund`，不运行安装生命周期脚本。
依赖安装失败即失败，不降级。验收若需要 native 安装脚本或生成产物而无法运行，
对应义务失败，不因缺少环境而豁免。

升级时，对新的外部目录重复安装命令，再显式选择新入口。不覆盖旧安装。

### 检查策略是否允许候选变更

验证策略 `.rcp/trusted-policy.json` 来自已审阅基线：

- `candidateRoots` 声明可变产品目录。
- `obligations` 必须非空；每项有唯一 ID、具名主张、明确的 `tests/*.test.ts` 路径和超时。

当前策略只允许 `src` 产品修改。其他路径变化，包括测试、测试 helper、工具、策略、
根 package/lock/config 和文档，均返回 `blocked`，要求独立审批。
即使位于允许目录内，package/lock/tsconfig 也不能作为普通产品变更修改。

新增义务、修改测试或依赖时，先按独立规则变更审阅并安装新基线；不能与普通产品变更
一起放行。遇到策略阻塞，不应通过扩大候选权限来让当前候选自证合格。

### 从外部安装验证候选快照

`<candidate-repository>` 和 `<candidate-commit>` 分别指定候选仓库及要验证的版本。
使用外部安装目录中的源文件启动，不使用候选仓库的验证器：

```text
node --experimental-strip-types <new-external-directory>/src/rcp/trusted.ts verify <candidate-repository> <candidate-commit>
```

验证一次解析候选 commit，并以该 commit 和 Git 内容摘要确定身份；不读取
dirty/untracked 工作区，也不自动 commit。随后把候选快照展开到临时目录。

测试和 helper 与基线逐字节匹配。它们的相对 import 指向临时目录中的候选产品，
不是安装目录中的旧产品。候选修改的 `src/rcp` 可以作为被测物，但不能替换外部裁决程序。
依赖来自安装目录，候选依赖定义不得变化。

验证在运行前后复核安装源码的全量摘要；已有快照文件在运行后变化则失败。
输出或测试环境的对抗性伪造不在本地信任边界内。

### 判断结果与失败

全部义务都执行，不复用历史结果。每项义务依据 Node test runner 的 TAP 完成计数判定：
退出码为 0、测试数非零、全部通过，且 fail、cancelled、skipped、todo 均为零。
缺失测试、没有完成报告、异常、超时或任一义务失败，都不能通过。

| 退出码 | 含义 |
| --- | --- |
| 0 | passed |
| 1 | failed 或输入异常 |
| 2 | policy blocked，须按上文处理独立审批或基线更新 |

JSON 结果绑定 invocation、候选 commit/content、基线 commit/content、策略摘要、
验证器摘要和 Node 版本，并包含实际具名主张及结果。下游只能引用这些具名义务，
不能将结果扩大为所有设计已经实现。

输出不是第三方签名证明，不自动写 RCP receipt，也不推进 `implemented` 或合并状态。
一次 JSON 自洽检查不能认证历史执行。

### 信任与证明边界

本流程是在固定规则下重新运行测试，不是密码学 succinct argument，也不是形式验证。
它针对普通 Agent 的误改、自报完成和检查削弱，不防同权限恶意进程、管理员、
被污染的 Node/Git/npm 或依赖，也不保证测试规格完整。

测试代码和产品代码在同一进程执行；缺少权限隔离，不能宣称可以抵抗恶意代码。
对抗回归由 `tests/rcp/trusted.test.ts` 拥有。普通 full gate 通过，也不等于证明本设计
或验证器正确。
