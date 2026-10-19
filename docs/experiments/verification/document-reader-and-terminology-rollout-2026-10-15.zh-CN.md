# 读者指引与分布式术语推广

[English](document-reader-and-terminology-rollout-2026-10-15.md) · [使用的术语](document-reader-and-terminology-rollout-2026-10-15.terms.yaml)

下列数字属于各自具名的历史检查点。[非临时文档轮次](#非临时文档组与词形键)已取代每个术语另编
ID 的旧要求。早期检查通过不覆盖后续改动，也不完成全仓正文审稿。

## 范围与来源

基线：`0ff7a8f85dd7d3dd6507b58a28032f254b3a1424`。本地分支为
`feat/documentation-writing-rollout`；工作不包含 push、merge、真实模型调用或外部 benchmark。

最初批次实际修改正文：双语任务型文档入口、CI/RCP 阅读路径、术语查询与失败处理、生命周期
及术语决策、维护工作流。删除了重复的事故复盘提醒，没有删除事故分流义务。

14 个流程术语由手工 v1 索引迁入 3 个主题自有的 v2 来源，保留原有 3 个治理词条，共 17 词。
定义区分 contract/work order、assertion/check、kind/stage、assertion context/session context，
以及收据自检/认证执行。完整行为合同仍在各自 owner。

结构卫生按角色发现活跃 design 与 Skill Markdown，包括 Skill references，同时保留 3 个必需
工作流文件。该轮没有把 archive 或原始实验数据准入机械检查；检查引用标题不代表 reference
新增了 Skill 入口字节上限。

## 读者审稿与守恒

这是作者审稿，不是独立语义审稿：

| 读者问题 | 修改的入口与边界 |
| --- | --- |
| 从哪里开始，哪些文字可以改？ | 两版 docs 索引区分任务入口和文档权威，指南不重定义设计。 |
| 流程词是什么意思？ | CI/RCP 路由到主题 YAML；当时名称、别名及稳定 ID 可解析到定义和独立行为 owner。 |
| 查询未命中或有歧义怎么办？ | 治理说明局部/扩大查询；未命中有界，候选须消歧，错误 catalog 先修复。 |
| 文档绿灯证明什么？ | CI 表区分已准入结构、角色预算、告警和未自动化的语义审稿。 |
| 名称没变是否意味着查询输出没变？ | 迁入的 v2 保留首行三列，追加定义元数据及主题 namespace；存在 v1 来源时旧读取仍兼容。 |

守恒检查读取
`git show 0ff7a8f85dd7d3dd6507b58a28032f254b3a1424:docs/glossary.yaml`，解析 YAML，再对
原规范词形和别名逐个调用 `queryTerms`。46 次查询全部唯一命中；`term`、完整 `aliases`、
`owner`、`anchor`、`status` 与原 14 行一致。当时每个迁移词条有作用域 ID 和定义。
这验证查询身份，不是一般语义等价证明。

136 个活跃设计文件相对基线保留显式或缺省生命周期。标题检查在 155 个 tracked 活跃设计/Skill
Markdown 中未发现缺陷；这是结构覆盖，不表示 155 篇均已改稿或完成读者审稿。

剩余 v1 文件名出现在迁移/兼容说明，或已否决决策的历史示例中，不把那些历史记录改成现行
指令。审批示例指向可检查的术语元数据，不表示机器认证词义。

## 已执行检查

- 目标测试 72 pass、0 fail，覆盖标题解析、文档 verifier 和 glossary resolver。
- 写入本报告前 docs 检查 432 篇，0 error/warning。
- glossary 检查：3 个 v2 来源、17 词、0 error。
- 6 个相关 TS/MTS 代码/测试文件 LSP 0 诊断。
- complexity gate 通过，相关代码格式化，`git diff --check` 通过。
- 3 个文档查询示例实际成功：限定目录的 `收据`、
  `repository.verification.assertion-context` 和限定 namespace 的 `术语定义`。

最初目标测试对新增 design/Skill 缺陷、空语料和仅 v2 来源发现实际报红。实现后，还需更新
旧 pilot-only 预期及正文为空的生命周期 fixture。最终 72 项通过，归档/原始证据的机械豁免和
缺少必需文件的拒绝仍受测试保护。

提交前完整 run `7ba146a5-71c5-48d4-8cca-e7f86ae3f727` 从
`2026-10-15T05:06:28.510Z` 至 `2026-10-15T05:08:10.413Z`，记录 16 个 blocking check 实际
通过、子进程原生退出 0，含产品测试。Research/chaos 明确作为 advisory 跳过。外层 task 工具
在 361 秒 timeout；不能仅因报告已生成就称外层成功。

干净提交输入 run `7bf07ea4-be96-4c86-8dfd-c6a9439bcd43` 验证功能提交
`c31e03fc355bef2e75588d516616641099cb7d3b`，显式传入全部 26 个拥有的路径及 `--require-clean`。
原生父调用从 `2026-10-15T05:15:36.177Z` 至 `2026-10-15T05:17:05.179Z`，退出 0，无 signal
或 error。报告记录 16 个 blocking command 全通过、child exit 0。Research/chaos 是 advisory
skip，不是执行成功。Docs 含本报告，共 433 篇、0 error/warning。

该 clean run 直接使用既有 watchdog，将 stdout/stderr 写入文件，另存父进程实际 status。
范围清单与原生退出在 `.nmg/verification/` 是本地辅助产物；共享提交、下列命令和上述观察
足以恢复必要验证事实，不依赖私有记忆：

```sh
# 在功能提交的干净树上，显式传入它改变的路径。
node --experimental-strip-types tools/agent-verify-watchdog.ts \
  $(git diff-tree --no-commit-id --name-only -r c31e03fc355bef2e75588d516616641099cb7d3b) \
  --require-clean --json --timeout-ms 300000
```

后续 evidence-only 提交更新本记录，不改变 clean 16 项运行测量的实现。

## 写作准则与首次应用

读者导向准则先提交于 `3a3eb04a756fe750c5c3458f3b63cd9896ad2216`。规范条件与审稿流程由
[reader-review](../../../skills/doc-maintenance/references/reader-review.zh-CN.md)拥有；治理设计与
维护入口路由过去，不另建检查清单。双语生命周期决策记录借鉴受控语言的选择与成本，不宣称
ASD-STE100 合规，不采用完整词表或句长门禁。

准则单独的 clean run `046fd5cd-95d4-456b-9fc9-6f50cff61e93` 实跑选中的 8 个 blocking check，
顶层 native exit 0、无 dirty input。既有 72 项目标测试在准则写入后也通过；两者都不认证
规范正文的质量。

首次应用把[可信基线操作主题](../../design/ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.zh-CN.md)
重组为前提、安装、策略准入、候选执行、结果处理与信任边界。这是一个操作阅读单元，不是
其余主题全部完成。

作者对照该文件在准则提交时的内容：

| 原合同组 | 改稿保留的位置与条件 |
| --- | --- |
| 选择与权威 | 显式本地流程；普通 reconcile/Agent 验证不自动获得基线隔离；保留 governing decision。 |
| 安装 | 已审阅固定 commit；现存父目录、候选仓库外的不存在目标；仅普通文件；Git 输出限 256 MiB。 |
| 依赖与升级 | 精确 npm flags、无生命周期脚本、失败不降级/不豁免缺环境；升级用新目录并显式选择入口。 |
| 策略边界 | 基线策略，非空且唯一具名的义务、测试和超时；仅 src 产品改动；package/lock/tsconfig 及其他路径限制；规则/测试/依赖变化独立审批。 |
| 候选与裁决身份 | 已提交快照、不读 dirty/untracked、不自动 commit；基线测试/helper、候选 import、外部裁决、安装依赖及摘要检查。 |
| 验收与失败 | 全部义务实跑、不复用历史；TAP 非空、全 passed、无 fail/cancel/skip/todo；缺报告、异常、超时失败。 |
| 结果与限制 | 退出 0/1/2；绑定 JSON 身份及实际主张；不自动写 receipt、推进生命周期、签名，不声称形式证明或对抗隔离。 |

两条可执行命令和 Authority 当时与来源逐字相同，规范术语标题保留，docs 中发现的 6 条入链
仍指向该标题。有界字段存在性检查仅补充作者对照，不证明语义。改稿没有改变运行时或验证
策略。

联合目标实跑 77 项，0 fail/skip：标题卫生、docs verification、glossary 及既有 trusted fixture。
Docs 仍 433 篇、0 error/warning；glossary 17 词、0 error。没有对真实用户仓库运行展示的安装/
验证命令；覆盖来自产品 fixture，不是新的真实安装。不声称独立文笔审稿或阅读效率测量。

## 轨道与仓库上下文整改

下批相对 `00e7181f7f7d32e2c74d3caf961a240610211e3f` 比较两个阅读单元：
[执行轨道](../../design/ci-cd-and-quality/verification-tracks.zh-CN.md)与
[仓库上下文](../../design/ci-cd-and-quality/repository-context.zh-CN.md)。前者分开入口选择、本地工具、
lint/format 范围、type/policy、mutation 锚点、复杂度证据、provider 隔离和覆盖率活性；后者
分开 owner、能力、数据来源及协调状态解释。

作者保留并对照：

- 轨道命令/用途、本地工具、lint 范围与 severity 例外、console 豁免、format/hook 同面及子包
  独立流程。
- type 范围排除、policy 元数据与真实策略自由的区别、只读锚点与真实 pre-push sweep 的区别、
  complexity merge-base/AST 身份/未测量边界。
- keyless 限制、模块顶层去除 provider 环境、显式 provider、并发 2/4，以及 0.01% 活性下限，
  不是覆盖率质量目标。
- scope 不收集其他 Agent 改动；导航可选，不要求全文读；只读、不用数据库/daemon/真实模型；
  capability 与 route 的事实归属。
- desired/observed/evidence、3 种状态及失败条件、dirty 内容指纹、Git 元数据与内容身份，以及
  drift 不等于架构错误。

有界检查确认原 inline code 标识符、Authority、缺省生命周期及规范子标题当时保留。
Docs/skills 中没有发现指向这两个路径的 fragment 入链；context 术语标题保留。这不构成语义
等价证明。

常驻正文删除了 patch 局部叙述和没有环境依据的一秒计时，保留失败机制与决策。实际
`mutation:anchors` 解析 22 个 target 的 110/110 锚点，没有运行 mutation tests；数字属于该次
观察，不是另一份手工源码清单。

文档中的 scoped `agent:context` 实跑成功，只读视图报告 `drifted`，因为 latest evidence 不描述
该 scope/state；没有称为收敛或架构失败。联合既有目标实跑 106 项，0 fail/skip，涵盖 docs
hygiene/verifier、glossary、repo context、ESLint 扫描面和 test groups。Docs 433 篇、0 error/
warning，glossary 17 词、0 error。未跑 live provider、full mutation 或 remote CI。两篇正文改写
不等于全仓正文审稿。

## 既有主题命名修正

用户指出拆分仍沿用章节位置名，未遵循既有描述性英文 kebab-case；没有明文禁止不构成理由。
相对 `a4ab1e16f66b259d7ac536ce8cce9eddbae33012`，范围是 `270d9e3..0ff7a8f8` 引入的全部
84 个主题：78 个改名，6 个合适名称保留。实现产物导航的两种语言使用相同主题 basename。
既有双语后缀、有意义的版本/日期、步骤顺序及稳定领域/义务 ID 保留。清理主题/父页的生成式
`— topic` 和机械章节编号，不认证余下正文。

CI 例名为 `verification-tracks.md`、`repository-context.md`、`repository-control-plane/`，后者
下有 `trusted-baseline-verification.md`、`contract-surface-and-ir.md`、`verifier-and-receipts.md`。
准则由 reader-review 拥有，双语生命周期决策记录否决项和迁移成本；未新增文件名 gate，也不
普遍禁止数字。

迁移包含 Markdown 入链、移出文件的相对链接、变化的 fragment/章节引用、术语 owner/anchor。
历史 commit-bound 代码示例及 fenced literals 不改为当前指令。显式 map 恰含 84 原路径，拒绝
目标冲突，保留显式/缺省生命周期、义务 ID 出现次数和 fenced code。排除预期 owner/anchor
迁移后，当时所有 term ID、名称、别名、定义、状态与来源 namespace 相同；未改 tracked
runtime/source。

有界扫描覆盖 459 个 tracked Markdown、fence/comment 外的 inline local fragment：原 185 条，
新增具名章节引用后 224 条，12 个 distinct baseline-invalid source/link pair，新增无效 0。
它检查改稿后的实际标题及重复 slug 后缀，不是完整 renderer 或穷尽 HTML/Setext/reference
link 检查；不同语料的早期审计不能作同一测量比较。扫描的 tracked Markdown/YAML/JS/TS/JSON
中没有完整旧仓库相对主题路径。

临时 probe 通过 map、冲突、字面量、重复标题和外部 URL 自检。负控制在迁移后的 store/
operation/view 子页替换一个 `D1`，精确对照实际 native exit 1，恢复原字节后正向复跑。
首次选中不含 `D1` 的路由父页，写前停止；调试器定位到真实子页。Probe LSP 0，提交前移除
probe 和 map 输入。Map 与原始观察只作本地辅助，Git 新旧路径及本报告是可恢复共享证据。

既有目标实跑 111 项、0 fail/skip，含 trusted fixture，非真实安装。Docs 433 篇、0 error/
warning，glossary 17 词、0 error。未跑 live provider、full mutation、remote CI、push 或 merge。
这完成 84 个拆分主题的命名，不是全仓正文/读者审稿。

## 非临时文档组与词形键

本轮基线为 `4ecf243f8e0449bb5289fe74ee25284351bdcc0d`。
[双语 owner](../../README.zh-CN.md#双语规则)覆盖全部长期保留、面向读者的内容，包括归档、
decision、Skill/reference、实验/事故报告；只例外明确可丢弃的工作材料。缺项是整改债，不是
另一种语言豁免。

英文正文、中文正文和共用 `<topic>.terms.yaml` 组成阅读单元。共享概念引用规范词形，不复制
定义。用户否决为每词另编 ID：规范英文就是键，中文译名/精确别名归同一定义，真正同名异义
才用 namespace。缺省 namespace 为 `repository`。既有 v1 和带 ID 的 v2 仍可读取，新词不生成
ID。改规范词形须迁引用/successor，别名查询不让旧引用静默有效。Contract/assertion/route/
session 是真实协议身份，不因词汇简化而删除。
[决策](../../decisions/implemented/2026-09-08-repository-terminology-index.zh-CN.md)记录否决理由与迁移成本。

### 实现与负向证据

- 纯引用/无专门术语文件已支持。最初 4 个新 reference 测试实际 RED 22 pass/4 fail，再
  GREEN 26/26，0 skip。
- 词形键/缺省 namespace/schema/改名/successor/旧格式兼容实际 RED 23 pass/9 fail，再
  GREEN 32/32，0 skip。调试器复现了旧 mandatory-ID 拒绝；歧义和有界未命中仍失败，不授权
  越界读取。
- 旧 Contract 示例缺 `domain`、`assumes`，编译 `4ecf243` 版本作为负控制。修正后的两版均
  编译成功，显式保留 `strength: witness`，摘要同为
  `sha256:1d44391d7cacb049a5377b30e281c117d343eb2ea927e4115f181be239f382ac`。
  这是编译接受和相同 IR 身份，不是 universal 主张证据。
- 临时证据 probe 初读不存在的 `compiled.ir.digest` 而崩溃，调试器确认实际字段为
  `compiled.contract.contractDigest`；仅计修正后 native-zero 运行。LSP 给出的类型为
  `compiled: any`，所以 0 诊断不验证该属性访问。
- 新中文报告暴露文件名检查缺陷：date/rolling-name 检查未先剥离 `.zh-CN`。新增 fixture
  实际 RED 44 pass/3 fail（共 47），一行后缀归一化后扩大目标集 GREEN 89/89；未带日期仍只
  advisory，severity 不变。
- 实跑局部 receipt 查询暴露跨域依赖：CI/RCP 的正确使用清单引用目录外 AG/STG/LTG，查询
  实际失败关闭，扩大语料后成功。正常入口改用完整语料，治理明确标注局部失败与恢复；没有
  删除正确引用，也没有静默越界读取。
- 治理英文稿超过 15,000 B 时 `docs:check` 实际拒绝；等义精练后回到既有上限内，未提高上限，
  也未把规范迁到豁免角色。

### 阅读单元与作者对照

9 组 CI/RCP 已有双正文和共用词表：CI 根页、tracks、repo context、RCP 父页、Contract/IR、
verifier/receipt、run-to-completion CLI、trusted baseline、narrow/full gate。治理、维护 Skill、
reader-review、docs 索引和 lifecycle/terminology owner 也补齐对应材料；本报告自身配对。
Memory-graph 词义登记在既有 owner，不表示 memory-graph 正文队列完成。

| 单元 | 对照的条件与限制 |
| --- | --- |
| CI 根页 | 测试分类与资源选择；精确入口/scope；full-plan 与 full-product 区别；150 秒整轮预算；advisory/skip/timeout 归因；只提交 owned 文件。 |
| Tracks | 命令集合、lint/type/format 范围、warn 例外、anchor-only 与 mutation 执行、merge-base/AST、keyless 隔离和覆盖率活性。 |
| Context | 查找可选、capability 与真实稳定 route ID、不访问 DB/daemon/真实模型、desired/observed/evidence 和全部 3 种协调状态。 |
| RCP 父页 | 真相 owner、未认证收据边界、include 剪枝/读取字节、权限、WorkOrder 最小字段、验证后终态、continuous/扩展的前提。 |
| Contract/IR | 输入/主张、domain/assumes/strength、assertion 身份；修正示例不是 universal proof。 |
| Receipts | 自哈希及 work order/gate/scope/check/verifier 绑定；不完整 JSON sketch 不是有效收据；本地完整性不认证执行。 |
| CLI | 缺省只读 plan、显式授权 apply、中断恢复不 replay harness、声明的 forge 权威及可选身份绑定 NMG feedback。 |
| Trusted baseline | 已审阅外部安装、src-only policy、规则独立审批、固定候选、全部义务实跑、退出 0/1/2、排除同权限对抗。 |
| Narrow/full | shared root 升级、恰一个 owner route、严格非空且无 skip TAP、有条件 `sharedChecks: none`；full 无适用 authored Contract 不生成 RCP receipt。 |

这是作者源码/双语对照，不是独立审稿或机械语义证明。保留正确 API/命令；错误示例依据 owner
修正，不为字节相同保留。生命周期显式或缺省 current；未改 RCP runtime 或 CI severity。

### 链接与测试观察

最初有界审计 20 个 CI/RCP/治理语言目标：基线 459、当前 471 篇 Markdown，fragment 边
30→40，基线无效 0，新增无效 14 处，已修复。扩大到含政策/Skill/decision 的 30 个目标后，边
64→92，两边无效均 0；该次 native exit 0，且编译了两版 Contract。数字在本报告中文稿写入前
测量，不是全仓链接数。Profile 排除 fence/comment/inline code，检查 ATX 推导的 Unicode slug，
不覆盖完整 renderer、Setext/HTML/reference-link 等价。

新 TAP 实跑 `tests/tools/glossary-check.test.ts`、`tests/docs/document-hygiene.test.ts` 和
`tests/docs/verify-docs.test.ts`：82/82，fail/cancel/skip/todo 全 0，native exit 0。
本报告翻译前 docs 检查覆盖 445 篇、0 error/warning；glossary 在 11 个 design 来源发现 25 个
定义、0 error。工具 design 语料外的新 companion 不静默扩张其准入范围；每词仍只有一个定义
owner。

中文稿和文件名修复后，新目标运行 89/89，fail/cancel/skip/todo 全 0、native exit 0。
Docs 覆盖 446 篇、0 error/warning。同一 30 目标审计当前为 472 篇/94 边/0 无效，基线为
459/64/0；自动发现外的 6 个纯使用 companion 另行解析，34 个规范词形引用均唯一解析到
登记定义，不因此扩张自动检查范围。4 个修改的 TS/MTS 源码/测试及临时 probe LSP 均 0；
编译和实际执行仍是独立证据。

### Scoped verification 检查点

提交前 run `a8b8f689-b5d0-4777-b368-cc8b277e3b79` 在 owned dirty 输入上实际通过所选 16 个
blocking command。原生父进程从 `2026-10-15T13:07:40.936Z` 至 `2026-10-15T13:09:26.427Z`，
退出 0、无 signal/error，不以此替代 clean run。

功能检查点 `dae398e50082e482defe084f8d539a1233da7ab7` 包含正文组和 checker 修改。暂存空白检查
实际在新中文 Created 行的末尾空格处失败，原生 Git 已定位；修正提交
`49159d2989032650a4ee27a7fd5b68d1814a123a` 改用空行，不改变双语元数据。
随后原生 `git diff --check 4ecf243` 返回 0。临时 probe 在功能提交前已移除。

Clean run `2c1c631b-a186-4be2-bd20-ba89530e479b` 验证 `49159d2`，同一 60 个 owned 路径显式
传入并使用 `--require-clean`。原生父进程从 `2026-10-15T13:13:00.965Z` 至
`2026-10-15T13:14:49.324Z`，退出 0、无 signal/error，前后工作树干净。16 项实际执行并通过，
child exit 均为 0：

`docs:check`、`glossary:check`、`build`、`package:check`、`check`、`check:tests`、
`mutation:anchors`、`check:lock`、`lint`、`format:check`、`agent:context:check`、
`complexity:gate`、`verify:packages`、`check:policy-words`、`rtm:check`、`test:product`。

Research/chaos 是 advisory skip，不是通过。报告保留产品命令执行及退出码，不保留逐用例
TAP 计数，不能推断未留存的数字。命令使用既有 watchdog，60 路径可从
`git diff --no-renames --name-only 4ecf243 49159d2` 恢复，并传
`--require-clean --json --timeout-ms 300000`。具名本地报告/原生记录是辅助产物，共享提交与
本记录保存必要事实。随后这次纯证据修改，不是 clean run 测量的源码。

不声称新的真实用户仓库 trust 安装、live provider、remote CI、push、PR 或 merge。
本地检查点不关闭全仓非临时正文整改。用户要求的 DSH 对照排在 NMG 完成并验证之后，仅授权
先报告发现，未授权修改 DSH。

## 记忆图与状态空间：2026-10-16 检查点

功能提交 `fe697a362aa7d045bd61b75695358a7af04dd412` 相对
`225255086b3965a87993087a59f4867d476d7461` 修改 25 个 owned 路径。六个阅读单元已具备
英文、中文及共用术语材料：

```text
docs/design/memory-graphs
docs/design/memory-graphs/session-runtime-graph-and-projection-revisions
docs/design/memory-graphs/theoretical-lineage
docs/design/memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board
docs/design/session-active-graph-runtime-design
docs/design/state-spaces
```

这是作者对照旧稿、源码及既有合同，不是独立语义审稿。读者问题包括：暂定记忆存于何处、
AG 与冻结检索投影有何不同、如何维护状态、何谓独立产物验收。

### 修正与保留的事实

- `src/core/stg.ts`、`src/cli/service.ts` 确认每项目一份 STG 文件、会话私有暂定行和
  独立共享 LTG 缓存提示。行过滤不是 harness 认证，也不是数据库内核级行安全。
- 跨库归并使用 `remember` 及 `consolidated_from_stg`／`attributes.sourceMemoryId`，
  不保证两库物理记录／节点 ID 相同。同库驻留变更保留自身身份合同，不再把该保证
  扩张到跨库复制。
- `SessionActiveGraphRuntime` 分开可变会话 AG、任务帧与冻结投影。
  `boardChannelId` 是设计身份，board API 用 `taskId`，不新增参数。
  公开 `activeGraphId` 仍标识投影。
- 状态入口决策与 `state-spaces.md` 拥有普通 `nmg_state` 访问。内部 Lab 权限／RPC
  兼容不是面向模型的日常 Lab 用法。writer 到期保留文本，clear／release 删除活状态，
  不删除旧宿主消息。fence 不认证身份或证明完成。
- Pi 的 16,000 UTF-16 单元分组输出预算已实现，区别于未完整实现的多维 AG 构建预算。
  准备／携带不确认最终 provider 输入，也不证明自然成本／质量收益。
- 黑板认领、交付、独立裁定、resolve 分开。`undecidable` 不等于 `rejected`，
  resolved 自报不是验收；历史读取不自动暂存为当前 AG 上下文。
- 过滤遥测统计 SQL 返回候选及存活数，不统计 SQLite 内部扫描行数或实测下推收益。
  双语示例 JSON 可解析、相同，且满足 `selectivity = 1 - after/before`；数字不是实测。
- 理论／调查保留引用，不证明研究全覆盖、NMG 优越性、无限恢复或默认策略已校准。
  本轮没有新一次联网文献核实。

新增四个规范词形：`projection revision`、`task frame`、`Task Board`、`state space`，
不造人工 ID 或新 namespace。完整语料查询 `ProjectionRevision`、`任务帧`、`任务黑板`、
`状态空间` 均唯一解析。目录限定查询即使本地已有 projection 定义，也正确因外部依赖
缺失而失败并要求扩大范围，没有静默越界。自动登记仍限 design：29 定义、16 来源，
不代表全部非临时 companion。本证据 companion 另行解析，26 个规范引用均唯一解析；
未登记名负控制无匹配，不扩张自动登记范围。

### 链接与 fixture 证据

有界 probe 对 12 个显式语言目标比较 472 份基线、478 份当前 regular Markdown。
选中片段边为 32→40。七个既有无效 source/link 对及四个新失效 state-space 链接，
在七个来源中修复，最终该范围无效为零。将概览真实链接改为
`#missing-negative-control-heading` 后实际 exit 1、出现一个新增无效边，恢复后 exit 0。
范围仅为简单 inline 本地片段、Unicode ATX slug、重复标题后缀，排除 fence／comment／
inline code；不是 Setext、HTML、reference-link、完整 renderer 或全仓链接证明。

双语 concept map 已区分可变 AG 与投影，但其余正文／owner 链接和 companion 仍待审。
harness 参考只修复 carriage 片段；陈旧工具表、Lab／逐推理说明及缺失组员仍是债，
不是豁免。

隔离运行时 fixture：**80/80**，fail/cancel/skip/todo 全零、native 0，
`2026-10-15T14:01:23.611Z`–`14:01:25.427Z`。输入为 core STG isolated/v2、session AG、
working-state、board-deliverable；CLI state／working-state；integration working-state
client／input／context-information 测试。
文档 fixture：**89/89**，fail/cancel/skip/todo 全零、native 0，
`2026-10-16T03:10:23.955Z`–`03:10:25.660Z`，来自
`tests/docs/document-hygiene.test.ts`、`tests/docs/verify-docs.test.ts`、
`tests/tools/glossary-check.test.ts`。不证明 live provider／benchmark 或真实宿主 GUI。
临时 probe 的 LSP 诊断为零，功能提交前已移除；原生 `git diff --check` 通过。

### 执行、复用与干净验证

- 提交前 run `5357e317-f2f5-47ef-b154-c9945b3f7e17` 针对 25 个 owned 路径实际执行八项：
  `check`、`docs:check`、`format:check`、`glossary:check`、`lint`、`package:check`、
  `rtm:check`、`node-test:documentation`，child exit 全为 0。原生父进程
  `2026-10-16T03:13:33.996Z`–`03:14:20.884Z`，status 0、无 signal/error。
- 干净默认 run `ebb46c69-a885-434b-a8a6-496b824b1642` 验证 `fe697a3`，但**复用**已有
  operation receipt（`rcp.status = reused`）。返回的八项不是八次新执行。
  父进程退出 0、前后树干净；未改收据来强制结果。
- 干净 `--full --require-clean` run `0ee7342a-bcee-4caf-baa4-7f582cf1f18b` 实际执行
  documentation route 声明的**两项**阻塞：`docs:check`、`glossary:check`，child exit
  均为 0。原生父进程 `2026-10-16T03:16:19.527Z`–`03:16:21.277Z`，status 0、无
  signal/error，前后干净。它不是八项重跑，也不是全产品执行。

最终检查报告 452 份文档、零错误／警告；29 术语、零错误。owned 路径可从
`git diff --no-renames --name-only 2252550 fe697a3` 恢复，直接传给 watchdog，附
`--json --timeout-ms 300000`；干净声明 route 检查另附 `--full --require-clean`。
`--` 属于 npm 包装语法，不应传给直接 Node 调用；首次误传在执行检查前被拒绝，删除后
成功。Windows task runner 的 heredoc 也在 Node 启动前被拒绝，改用可移植 `node -e`
后实跑 fixture。一次 codemode 语法错误没有执行任何工具，均不计入测试执行。

具名本地产物为 `.nmg/verification/memory-graphs-*`；本记录、源码 owner、Git 保存必要
范围与结果，不依赖私有文件。随后这次证据修改不是功能 clean run 所测输入。全仓非临时
正文仍未完成；DSH 检查继续后置，不声称 DSH 修改、push、PR、merge 或 remote CI。

## 翻译协作审阅：2026-10-17

两位独立分工的 Agent 提供了中文稿和术语文件。已审阅子集共五十篇保留实验记录，覆盖完整四批。协调者逐篇比较五十组完整原文／译稿
及术语定义后，整合了一百个新配套文件，并同步修正英文 owner：

- 实验根目录汇总：`benchmark-results`。
- `benchmarks/`：`beam-100k-evaluation-2026-08-13`、
  `halumem-operation-evaluation-2026-08-11`、
  `lme-recall-headers-2026-08-04`、
  `locomo-evidence-mode-signal-2026-08-02`、
  `locomo-qpp-safe-prefix-2026-07-29`。
- `retrieval-quality/`：`gate-cascade-literature-2026-09-09`、
  `gate-certification-2026-09-09`、`relevance-gate-calibration-2026-09-09`、
  `sufficiency-shape-features-2026-09-12`、`baseline-2026-08-16`、`hybrid-2026-08-16`、
  `node-summaries-2026-08-24`、`chains-2026-08-24`、
  `chain-activation-2026-08-25`、`summaries-2026-08-18`、
  `compound-reference-2026-10-11`、`shared-output-2026-10-10`、
  `uuid-dedup-2026-10-11`、`lexical-tie-ranking-2026-09-30`、`status-2026-08-18`。

- `store/`：`consolidation-evaluation-2026-08-09`、
  `scale-evaluation-2026-08-09`、`write-path-scope-index-batching-2026-08-31`。
- `topology/`：`bpid-evaluation-2026-08-09`、`gate-evaluation-2026-08-09`、
  `namesakes-evaluation-2026-08-18`。
- `runtime/`：`matched-evaluation-2026-08-09`（还包含标为 2026-08-20 的章节）、
  `real-use-shadow-2026-08-09`。
- `context/`：`intervention-literature-2026-09-07`、`live-canary-2026-09-07`、
  `live-comparison-preregistration-2026-09-07`、`router-component-2026-09-06`。
- `retrieval/`：`hyde-pool-full-2026-08-04`。

- `execution/`：`task-semantics-design-cases-2026-09-13`、
  `task-semantics-slice1-2026-09-13`、`mast-coverage-2026-09-12`、`field-ownership-2026-10-01`、`ooo-retention-2026-09-13`、
  `ooo-round-transition-2026-09-13`、`ooo-run-namespace-2026-09-13`、
  `ooo-single-boundary-2026-09-13`、`ooo-task-tables-2026-09-13`、
  `ooo-transaction-port-2026-09-13`。
- `verification/`：`task-unit-semantics-ledger-readings-2026-10-14`、
  `full-gate-atomic-checks-2026-09-23`、
  `full-gate-parallel-static-2026-09-23`、`impact-probe-2026-09-23`、
  `document-byte-budget-rollout-2026-10-14`、`product-file-partitions-2026-09-23`。

每个 basename 均有英文、`.zh-CN.md` 与 `.terms.yaml` 配套。必要证据边界保存在最终
读者文档中，不依赖私有 Agent 对话：

- LongMemEval bridge 对比绕过改动后的 Pi header renderer；bridge 指标不变不能
  验证该 renderer，也不能单独估计 judge 波动。
- 词法基线原来的能力分片计数说明合计为 236，而总体为 235。后续表格以 preference
  分片 39 题合计为 235，但本轮未重新核对原始基线分片计数。
- 仅凭 R@5→R@20 曲线不能区分候选未入池与排在第 20 名之后，也不能单独证明 QPP 收益。
- 激活报告表格显示，any@20 增益保留约 25.5%，使用约 39.5% 的**新增**字符；
  不是两个总量都为 40%。仅统计排序 gold 的诊断不能排除非 gold 链起点，
  也不能建立通用链扩展上限。
- 共用 store 不足以单独识别因果效果；v1/v2 选择器变化使臂间对比存在混杂。
  字符数或每节点一次短调用不证明计费 token 或货币节省。
- 术语区分历史配置与 runtime 保证、分层抽样与仅覆盖类别，以及 STG consolidation
  与能力晋升两种不同语义。

第二批进一步区分重复／注入的任务观测与独立证据、gold 引导的 prototype 构造与
不使用 candidate 标签的打分，以及入选节点对非匹配比例与实测错误合并率。只读拓扑评估
与单独的强制合并回滚探针已明确分开，不再互相矛盾。本轮读取了保留的 evaluator 源码；
这不是新的历史运行或回归回执。

Namesakes 区间描述十个固定实体上的重复观测，不是五十个独立实体。Canary 与 HyDE
均由同模型回答／判定；温度 0 不保证重复一致或独立判定。HyDE 的 479 题召回分母、
500 道判定题及舍入差值不一致已明确，保留原始数值而不虚构缺失计数。外部文献仍是
未经本轮核实的研究线索。拟议预注册仍缺套件／映射、具体网格、预算与功效细节，
H1／§6 的成本措辞也未解决，不能表示为已完整前瞻冻结；本轮未代选缺失实验设置。
仅为交接完整性，本轮整合前十二份第二批源文件哈希与 worker 清单一致；这不是实验验证。

第三批把研究 `ooo_probe_*` 存储与产品 `taskRun` 契约分开。Retention pin 保留 verdict
证据，但不接受 artifact；探针事实行保存最新值，不是 append-only attempt 历史。
事务 port 的缺失拒绝以已有 transition 为条件，不禁止独立的无 port 发布。取消 round
泄漏行号与本地 mutation 配方是历史线索，不是当前缺陷或重放可用性的确认。
Field-ownership JSON 记录五个模型的计数、一个 base revision 和三个源哈希，
并未逐一列出五个模型身份。

验证摘要保留了原文 12.3 秒与舍入表格 12.2／12.7 秒差值的未决差异，以及串行行
100.0 秒与所引另一篇最后一行 107.4 秒之间未解决的归因。并行表的七秒具体指
27.8−20.8 的非产品时间下降，被产品时间增加三秒抵消后，端到端下降为四秒。
缺少 run 身份时，不因同一耗时出现在多篇文档就算独立重复。原生子检查报告与超时的
外层包装仍明确分开。RCP 译文区分了八个不再初始化 Git 的用例和其余每个真实 Git
夹具少两个 config 子进程。源码阅读及历史 DSH 参照不是新的运行时／DSH 审计。
第三批曾调用源哈希比较，但本检查点未恢复其完整的编辑前结果；撤回较早的
“十二份全部匹配”表述。清单仍保留逐文件哈希，但不对现已编辑的来源主张匹配。
`docs/design/design.terms.yaml` 中一个含冒号的 anchor 值加了引号而未改语义；
不能据此推断任何 YAML 或仓库门禁通过。

第四批十五篇（owner 见上方分类）均已完成英中全文／术语人工对照与整合，统一检查仍后置；
其中三篇文案／引用单元复用既有组合引用／共享文案定义。只读
`memory-reference.ts` 和 service 解析器确认了前缀／引文匹配与原始短引文见证，
并未确认历史耗时或测试回执。

共享输出分母为十二种 fixture × search／get 表面，即 24 个配对表面单元，
不是两臂数量或 24 个独立任务。其变短条件排除明确保持不变的仅 folded envelope；
字符计数不会变成计费／token 测量。组合引用渲染的长度守卫使用 UTF-16；原始 ID／短引文
见证不冻结整条当前正文。干净后提交义务仍不同于已完成的 precommit 计数。
UUID 矩阵在 16 个单元间复用 100 个 ID，不是 1,600 个独立 ID；十进制长度为均值。
字面规范 ID 查找与独立的图作用域引用解析器已分开；RPC 归属／当前目标检查也不同于
纯 helper 的调用者作用域，helper 的默认目标集不刷新记录。另修正一处把“未承诺无额外调用恢复”
误译成“不需要承诺这种恢复”的义务变化。

第四个已审阅单元 `lexical-tie-ranking-2026-09-30` 现区分历史选后试验与已批准的预算前
扩展。本轮读取 `search-ranking.ts`、检索调用点及规范的 `pre-budget lexical tie-break`
决策。Helper 保留输入池，但 cap 前重排可能改变返回前缀；报告中的 R@20 不变不是通用
产品保证。既有决策仍拥有算法定义，未在实验词表中重复定义；其双语措辞现明确 UTF-16 证据单位
及查询词文档频次。规范组合引用定义也改为前缀与引文组合而非任选其一，并保留
RPC／纯 helper 的区别。500 单位证据片段为 UTF-16；
该记录没有针对 100 MB 预算的前后常驻内存测量。1,540／1,532 的 LoCoMo 总体仍未对账；
十九个查询行不证明十九个独立任务，缺负例不等于经核验的无关标签，p=1.0 不是等价证明。
未重跑本地报告或 benchmark。

随后两篇已审阅单元为根级 `benchmark-results` 快照和
`runtime/real-use-shadow-2026-08-09`，每篇三件套均已对照。源码视图覆盖配置 runner 预检、
cache wrapper、bridge、无头 helper、数据路径解析器、数据集联结及标定 gate；未执行这些程序。

Benchmark 汇总不再把旧版本／checkpoint 当成当前运行或精确续跑保证。官方行采用不同
answer／judge；可变的上游 URL、运行／不确定性细节仍未核实。Temporal 的
`event_ordering` 21.73 对 18.92 不支持字面的“没有变化”，也不单独识别叙事能力上限。
Logical A／B 的 68.67 与完整运行的 66.57，以及跨改动运行集合的 summarization
46.52／69.74，仍是分开的读数。仅评测默认标签不建立当前 bridge 默认。本地阶段不天然
零成本，直接 shell 命令保留为历史并路由到当前配置工作流。当前 provider 探测有
cache-only／无 provider 例外，不证明整次运行健康；cache-only 限制 embedding I/O，
不排除 answer／judge 网络调用。

影子报告现分开首次自然使用、后续受控 episode 与当前源码行为。九个 outcome 事件
不是九次任务成功，显式 Agent 反馈不是独立核验的 claim 支持；补入决策后第二次循环
减少也不单独识别因果效果。当前计时器只包住逐次 prompt／settling，不覆盖启动、取结果、
清理或整个 helper 生命周期。先等子进程 stop 再关闭自有 daemon，不保证所有崩溃都安全。
旧受控／歧义行不因改名就成为当前自然训练行，离线候选仍非激活。观察收集开关、影子
打分资格与 active／default 权限继续分开；docs 索引现把 benchmark 页面称为历史快照。

已审阅的 `retrieval-quality/status-2026-08-18` 分开初始检查点与
2026-08-24／25 跟进，不是当前续跑计划或单日期账户快照。旧 612+16 测试／tsc 及 v1
结果不证明当前回执、v2 支配或保守界。产品调用不复现四个退役 benchmark 臂；cache／
store 持久化及旧余额／重置／回退指示不是当前就绪或花费权限。`+0 generated` 不单独
诊断配额失败，`reasoning` 不单独证明设置被忽略、额外计费或延迟。已校正链 owner 提供
25.5% any@20 增益保留、39.5% 新增上下文、58.9% 总上下文，替换混淆的 40% 分母。
仅排序 gold 的诊断不证明链不可达或可部署。当前 TODO／协议 owner 优先于旧未决清单。
未执行 provider／store 检查或运行；配额标题／术语锚点已修正。入链查找覆盖 docs／
skills／evals，不是统一链接门禁。

第四批第八个已审阅单元 `execution/mast-coverage-2026-09-12` 现明确为历史研究探针
标注，不是自然失败发生率或产品 Task Board 契约。7／5／2 统计类别标签，不是事件或
独立试验。3.2 行保留 9／10 存活与后来的 2 个被杀死／5 个存活，不补造总体衔接；
若从 9 扣除 2 应余 7 而非 5，差异仍未对账。计划内排除依赖互斥效果、唯一权威及候选
worktree，不是 OS 隔离或对计划外写入者的防护。固定 composition 路径无 A／B 对话，
不等于没有 board 协调。成功准入完成与物理阻止终止不同。Fixture 进程确实分别启动，
但脚本行为不是独立模型行为。外部 28.5% 使用不同分母，不是定量佐证。未重验联网
引用、原始日志或旧源码／测试计数；所读 admission 报告用于范围核对，未执行。仅作有界
入链查找。该次整合检查点的队列推导余量为 69，第四批待完整审阅七篇；其他队列保留在共享工作计划。

2026-10-18 对 `execution/task-semantics-design-cases-2026-09-13` 与
`task-semantics-slice1-2026-09-13` 的全文译稿／术语完成对照并整合。已读当前 next-slice
owner 的最小用例、有限上限及明确未建模边界；只读编译器源码／LSP 核对当前签名及其
纯输入角色文档，不是测试或完整运行时集成回执。

产品计数 1444 保留为独立历史读数；账本 1457 及其所叙 1446 → 1457 clock-window
变化不是配对 run／tree 对账。本地脚本与后来 `mutation:teeth` 的调用关系保留未决，
不悄悄当成精确复现命令。Budget mutant 在旧选定输入下因相邻守卫拦截而未被区分，
新用例能区分，因此不建立全输入语义等价；术语／章节不再声称任何测试都不可能抓到。
Fused 区间统计模型事件／合法顺序，不是耗时加速、置信区间或真实模型会话复用。
保留 ID 的计划排列不证明文本可合并或 OS 写隔离，无时钟 API 检查也不是实际时间测量。
单运行 namespace 限制已带历史范围，并路由后续研究报告，不声称当前产品 taskRun
仍有限制；父 refinement 映射缺口仍与具体 input-closure 修复分开。Retention 改为具体
阅读链接，不要求找未命名分支。数值表与 literal 命令全部保留历史边界，未执行程序。
该次两篇检查点的队列推导余量为 67，其中第四批待审五篇；不新增全库完整性或门禁结论。

当前 `docs/design/task-unit-semantics.terms.yaml` 中两个含冒号的 anchor 值加了引号，
未改锚点含义。这是语法修复，不是严格 parser／门禁通过，也不恢复六份未知前驱内容。
DSH 接线与全部实验回执仍是带日期的观察，不是新的宿主验收。

保留的表格与命令块仍是历史参考。本轮没有独立复核或重跑原始实验产物及其报告测量。
本次协作审阅未执行测试、lint、format、文档／术语／链接门禁、benchmark、provider
实验、提交或 DSH 修改。统一验证仍待执行；上文较早回执不覆盖这些新输入。

## UOp 参考源码审阅：2026-10-17

双语 [UOp 目录](../../design/design/learnable-routing-and-differentiable-query-graphs/uop-catalogue.zh-CN.md)
及其共享术语文件现描述当前内部 `Op` key。只读 `src/lab/autodiff.ts` 与 LSP 符号查询
识别了遗漏的 `Sqrt`、缩写的 gradient 名称、二维而非任意维 shape、全缓冲区归约、
正下限和零范数处理。目录现区分这些实现约定与数学或运行时启用保证。
未执行数值测试、benchmark 或仓库门禁；源码审阅不替代统一验证。

## Tessera 设计源码审阅：2026-10-17

[Tessera 设计](../../design/memory-tesserae-design.zh-CN.md)、中文配套及共享术语现区分
带日期的草稿与本轮所读 schema、写入、查询和 service 路径。Label／snippet FTS
不等于整文件索引；定位仍会读文件，且最多扫描 200 个普通文件。单行首个匹配、
跳过／不可读文件，以及缺少 root 的情况，都不建立唯一身份或全项目不存在证明。
后补指纹不是已验证的写入时快照；一次没有成功行的 pass 可停止 root 级补填。
书签查询不按所链接 memory 的状态过滤；仅携带元数据 marker 不提供免 schema
或级联生命周期保证。历史 ticket 8 不认证当前 DSH 清理。

五条外部对照保留在双语研究子文档中，保留原始 URL 与调查日期。它们仍是未核实线索；
架构相似不验证 NMG 的成本、生命周期或漂移主张。100% recall／0.24% false-positive
仍归于原始文件尺度讨论，不晋升为普适上限或重跑结果。
本轮是只读源码审阅与文档写入，不是运行时、安全、外部文献或统一门禁回执。

## 第四批交接身份：2026-10-17

已读取两份冻结的 round4 清单。协调者编辑前，按原始字节计算 SHA-256，与清单逐文件值
比较，15 份英文来源（G8／H7）及 30 份交付配套（G16／H14）全部匹配。下表记录来源
身份，使这一观察不依赖私有对话。这仅是交接完整性，不是语义验收、历史运行重验或
仓库门禁回执；不能因为哈希匹配，就把较早协作审阅的范围扩展到这些全部输入。

| Batch | 来源（相对于 `docs/experiments/`） | SHA-256 |
| --- | --- | --- |
| G | `benchmark-results.md` | `759a33d20491769f96d25746dcfea2ed81d542fda6682a1e24593a08b3a31144` |
| G | `execution/mast-coverage-2026-09-12.md` | `bece4fc3f2784ba1cfa025ff72e7c0d2717f085d9ab0213d9c91cfd55f3620a8` |
| G | `execution/task-semantics-design-cases-2026-09-13.md` | `e153f2cbb5954486779950d0f9ac928f845c70f4f78bb2e0547692d75023c03a` |
| G | `execution/task-semantics-slice1-2026-09-13.md` | `3cdf1ae396a7988605b43952ea5a055adb44cec7db4445b9fad0a61a73db25f9` |
| G | `retrieval-quality/compound-reference-2026-10-11.md` | `64cfc6baaa58d12bc6dd2b35ae7f1b09767921ba40ab99e9778812ff10055b4a` |
| G | `retrieval-quality/shared-output-2026-10-10.md` | `18e3879aa22959f6582632ad5a83a585a47426e54899dd217fcaa6e2b2627a6a` |
| G | `retrieval-quality/uuid-dedup-2026-10-11.md` | `923e961c77148d50b84a1a825afd1d0f7b564fd771f3e12d72c4a29ea9019a7b` |
| G | `verification/task-unit-semantics-ledger-readings-2026-10-14.md` | `77f07312358ed6fa6a61089095851a7fb9854c118d52c0fc3710ff61a62cab3c` |
| H | `retrieval-quality/gate-cascade-literature-2026-09-09.md` | `ce26ae3a7a2c0c649eb9e18d07bc44b1d684cb05e61985d71ac6dc106e6e9a5d` |
| H | `retrieval-quality/gate-certification-2026-09-09.md` | `0bba51ad561b0db30b9acdea3527e811ceab1564ddd7743e75607198333f45f6` |
| H | `retrieval-quality/lexical-tie-ranking-2026-09-30.md` | `e0f2f3ec307b58c9eb3ff285d1249228870c74a6a04f2c0f0871d31d9280fbc9` |
| H | `retrieval-quality/relevance-gate-calibration-2026-09-09.md` | `ce36bf83a03fa31d4635e3607b186c53e9f80205356fbbc3f8b455d4dfa85542` |
| H | `retrieval-quality/status-2026-08-18.md` | `5905638b499a49a87a2201f715c5064ab4052f4dcc86ed7dd4f910a159c8d93f` |
| H | `retrieval-quality/sufficiency-shape-features-2026-09-12.md` | `a420c2203837e84b6a35651233bffae9b35147ac174487f860f436f13fed563c` |
| H | `runtime/real-use-shadow-2026-08-09.md` | `cd42acc6b881bcb44f3bfbd8a50b508d6ca8e9c0996b30b08be0c1a9b526a646` |

## 盘点与第五批分工：2026-10-17

只读盘点 Git 可发现且当前存在的 Markdown（已跟踪及未忽略的未跟踪文件），排除中文
后缀／目录变体后得到 360 个来源候选：71 个缺中文同名配套，74 个缺术语同名配套，
共 74 个文件名层面的不完整组。这些只是规划标记，不是语义覆盖或获准文档门禁结果；
被忽略材料与旧式分组仍需范围审查。

其中一项是 speculation run2 证据目录中的 `CLEANABLE-scratch-2026-09-19.md`。
正文明确允许在报告引用该次运行数字后删除，符合带清理条件的可丢弃工作材料定义。
本轮保留其原始字节，既未删除，也未悄悄当成普通待翻译阅读单元。在该盘点检查点，其余 73 个候选分为：
第四批已交待完整审阅 11 个、第五批新分派的活动设计 I6／J6 共 12 个、尚未分派 50 个。
`docs/` 之外的 26 个候选含入口／操作材料，不能仅因目录位置就整体豁免。
DSH 相关文档保留范围澄清前的停写状态，本盘点不授权修改。

机器盘点及分工保存在共享路径
`C:/Documents/GitHub/nmg-doc-contributions/coordination/reader-inventory-2026-10-17.json`
和 `reader-work-plan-2026-10-17.json`。`nmg-doc-writing-rollout` 上的第五批任务为
`1792226691093_000606`（I6）与 `1792226691099_000607`（J6），仅允许各自
`round5/<agent-id>/` 贡献根写入。派工不是收到或验收；此前贡献根继续冻结，统一验证尚未开始。随后 benchmark 汇总／runtime shadow／status 的整合
将第四批待审队列减至八篇；工作计划记录此变化，不冒充重新执行了全库盘点。

重读闭集页眉契约时也发现本轮作者错误：新 tessera 设计包曾把审阅说明放入页眉，
研究子文档还新增了不支持的 `Survey recorded` 字段。说明现已移到正文小节，调查日期
仍保留在研究正文。这是英中同步的作者修正，不是页眉检查通过。

## 第五批收到与第六批分工：2026-10-17

第五批两份交付已收到并仅作收到 ACK：频道 `nmg-doc-writing-rollout` 的 I6 result
`1792242997088_000616` 与 J6 result `1792243003627_000617`。协调者修改前，12 个源
与 24 个输出的 raw SHA256 全部逐项匹配清单。I 清单 raw SHA256 为
`adfb69c63d3e34324b16b17987bc6d9a88acbfd50100438e56ba6bdea3894d1c`；J 为
`103d67b09585d3a01be02d8dbc5353c8ec0f4a2c0525d3da751c51f9de6863a6`，也匹配其 deliver digest。
这只证明文件身份，不是语义验收、字节预算验证或门禁。原始对照保存在共享路径
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round5-intake-2026-10-17.json`。
round5 及此前全部贡献根和清单均冻结。

下表保留收到时的源绑定，不声称后来修改的源仍具有这些字节：

| 源文件 | 修改前 SHA256 |
| --- | --- |
| `docs/design/design/memory-graph-reasoner.md` | `788f54402ea843314cf183be1aa7c65bed08fb9501fc7f684fc2cfe2dc37a0a7` |
| `docs/design/design/session-reasoning-workspace-and-compaction-checkpoint.md` | `d57af7fbff5902949f3a5db075ca90f6cb6e424cf3f51a6f8a960b6386e41b3c` |
| `docs/design/design/stg-ltg-connectivity-and-provisional-memory.md` | `809b3cebd07ed274fc7254c4e84d6347bb85803501226bf9eb3d7ef8dbaf28c4` |
| `docs/design/design/active-graph-activation-and-consolidation/node-identity-and-reversible-canonicalization.md` | `acfef0e3ab1da5b9b4880dae9c9b723afaa7cd0647d5f3fa0205022352d6c39c` |
| `docs/design/design/active-graph-activation-and-consolidation/session-ag-and-projection-revisions.md` | `57c91af34e133a996544110f86996a7fc22692e8eb3778b83dc7aed1554bc3d9` |
| `docs/design/design/active-graph-activation-and-consolidation/edge-stability-and-structural-consolidation.md` | `e0d4cd46c3b83fde913419f595febc2c147e8e4788f44db32f823e533a7e89b5` |
| `docs/design/agent-convergence-feedback-design/executable-v1-specification-and-decision-gates.md` | `0cf9ea4502fece3e805ec4dd2beeb148e5af44df50badcbb978b230348d35220` |
| `docs/design/agent-convergence-feedback-design/existing-runtime-components.md` | `19d3fe22e2de10d13e869b711ae585cae597d1d110f9d20c57a648d6b5b28daa` |
| `docs/design/agent-convergence-feedback-design/harness-formalization/low-compute-router-candidate.md` | `5e1e0f0aa31a11fd43dcf6090697c824184fa3b5929de41b3a1a6a50518d1569` |
| `docs/design/agent-convergence-feedback-design/implementation-boundary.md` | `b493b5a5674d370836e0c35b30f55e12102b32cf854a34da9e23c0a83ddec389` |
| `docs/design/design/evaluation-and-falsifiable-claims.md` | `5d43dbeebccd1938d951cd5981e5073f22a77c3b1b5f92ac8a18cc06d292fa92` |
| `docs/design/session-active-graph-runtime-design/remaining-work.md` | `0ea41bf76fdde5e7386fbb29aba0b28d2390f5e19e9e66663ec9f34a4cfc0674` |

第五批语义审阅仍待完成；收到该批时，人工整合数为 42 个实验单元／84 个配套文件。Worker 问题
是审阅线索，不是协调者结论。特别是设计没有 `Status` 本身不是错误：既有契约默认
current；须审查的是它与文档具体范围声称是否冲突。

第六批 K8（`1792243238385_000618`）与 L8（`1792243238402_000619`）各分派八个不同
新源，仅可写 `nmg-doc-contributions` 下各自的 `round6/<agent-id>/`；共享 NMG 源、DSH
及旧交付均只读。16 篇逐项查到缺中文及术语配套，不是运行文档门禁；共享工作计划列出
准确路径。第六批分派时，旧盘点队列分为第四批待审 8、第五批待审 12、第六批分派 16、未分派文件名
候选 34，共 70。这是旧快照的队列变化，不是新的全库完整性结论。DSH 停写及最后再做
统一验证的安排不变。

## 第六批收到与第七批分工：2026-10-17

K8 result `1792244305344_000624` 与 L8 result `1792244112903_000623` 已仅作收到 ACK。
协调者修改前，独立 raw-byte 对照确认 16 个源及 32 个输出的 SHA256 全部匹配清单。
K 清单观察到的 SHA256 为 `d2f44112be63388925ef30950ba51a8775048e3903cb0b48095b44b23bfd37eb`；
L 为 `57bec6b07c9af19399610e4fa87ffed084d4385ddb940a52022ade5fb8698c20`，
也匹配其 deliver digest。完整对照：
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round6-intake-2026-10-17.json`。
这只验证交付身份，不是语义正确、字节预算或门禁。round6 及此前全部贡献根与清单冻结。

| 源文件 | 修改前 SHA256 |
| --- | --- |
| `docs/design/design/active-graph-activation-and-consolidation.md` | `64223d8b4e59ae4c3c0410652bbae59f827d44d12f38cf8511eeb58b72ea4244` |
| `docs/design/design/core-data-model.md` | `97292097a5b3908be83e5036f09521c76f44f540c8c858fd72924759d6f01cd6` |
| `docs/design/design/incremental-storage-and-index-maintenance.md` | `f18cdebaf07429a4a59d418ce0be5a95b5588e07eeb6d739f8176e77bc081fb8` |
| `docs/design/design/learnable-routing-and-differentiable-query-graphs.md` | `53a651e81d324e4f076e9009815a27a5c843fbcc90c2fc08d21ea8870ce269d6` |
| `docs/design/design/memory-graph-reasoner/differentiable-set-logic.md` | `bf666896c2d4c8c33ace45712d1ed66a23e26b34edbe725b6a6eed0e72a6f7df` |
| `docs/design/design/progressive-retrieval.md` | `2297c162e358405a11c36e18e96de4c34ad3734ef899d989e31d624fd7f3f214` |
| `docs/design/design/session-capture-and-write-path.md` | `790be930fce2b573e6e6a7db51f9e64f0caa88f11d2dbb81107cf96de70c9553` |
| `docs/design/design/product-boundary.md` | `4958692c6561170d3fc9c542cbf39a5ca3b11a9854ecc0a038af263b274f7346` |
| `docs/design/agent-convergence-feedback-design.md` | `d8bce541ab37189f39134975a8d644bed208323ea7426af5f83b227dfe3f84b0` |
| `docs/design/agent-convergence-feedback-design/harness-formalization.md` | `ebc69d352ce031eff4e2e87a28984163649d471387b170424c249c09826bf0cf` |
| `docs/design/completion-audit.md` | `7f1ab1475d2dfdeeb61ac4e29f52bc170a5dd34ff71f054c0cccc187c7878b61` |
| `docs/design/completion-audit/requirement-matrix.md` | `c2bdd0d2bebbd483c7db09921f00009f1a795a9f3352dcfdbbdac5f411772423` |
| `docs/design/design/evaluation-and-falsifiable-claims/offline-text-space-policy-optimization.md` | `e02f091c6082e3aa85d02fb195a48948324e77c1a0f4858dd5bc11a593c71208` |
| `docs/design/design/implementation-order.md` | `434670f8d28814adc79bfd8d44aec077906b78fef3c806cffcb07f37bb018e6a` |
| `docs/design/design/implementation-versus-target.md` | `ecf9fa70cabbae53d90e926df13aa23f5dbf615229e4f6b94cec8ab7788cdc3b` |
| `docs/design/design/product-boundary/agent-cli-and-resident-service.md` | `478f1e99cf6beb493b6f0432b762c26c626691b39236aa0f0b454e5260d0908f` |

第六批尚无单元获语义整合；收到该批、后续审阅之前，人工数为 43 个实验单元／86 个配套文件。源问题
清单是线索，不是已接受的修改；不同范围的完成声称不一定冲突，缺设计 Status 默认
current，且 2026-08-30 早于 2026-10-07／08（L 清单方向写反）。

第七批 M8（`1792244572845_000625`）、N8（`1792244572858_000626`）各八个新源，精确
路径见共享工作计划，仅可写各自 `round7/<agent-id>/`。其中 protocol-governed-collaboration、
verification-claims 及 root README 已有中文，必须对照并记录原中文指纹，不得直接覆盖，
也不为变化措辞而重译。保留归档仍需双语，维护 TODO 不是可丢弃材料；入口／模板机器
字段及打包影响须在整合前审查，没有委托修改源或加载器。AGENTS 仍为 5,000 字节上限，
Skill 入口 15,000；普通 README 与归档设计不继承活动设计上限。分派时旧快照推导队列
为 69：第四批待审 7、第五批待审 12、第六批待审 16、第七批分派 16、未分派 18（16 个
评测 README 及两个 DSH 范围停写项）。这不是新全库审计。未运行测试／门禁／provider／
网络／daemon／Git 写操作，也未改 DSH。

## 第四批人工审阅收尾：2026-10-18

剩余五篇均已完成英文、中文及共享术语全文对照，修正英文 owner 并整合。第四批 15 篇
全部人工审阅完毕，前四批共 50 个实验单元、100 个新配套文件。这关闭第四批写作／
审阅队列，不代表整个推广结束或已完成后置仓库验证。

| 单元 | 修正边界 |
| --- | --- |
| `verification/task-unit-semantics-ledger-readings-2026-10-14` | 读数归所报仪器，不共用一个搬移修订。添加可检索历史分节；stdout 丢失后 JSON 存在不是一概“不写日志”。点名断言、套件失败及超时分开；worktree 本地隔离不等于共享服务隔离，31 条 LSP 诊断与时间不是今天预期。 |
| `retrieval-quality/gate-cascade-literature-2026-09-09` | AND 等价需要同池固定逐项谓词，不只是纯过滤器；重排可改变截断前缀召回。权限／有效性硬过滤不能变为学习特征。不同数据集／单位及未核验文献不证明因果或普适优越。 |
| `retrieval-quality/gate-certification-2026-09-09` | 源 builder 的基线解释 67 = 1 + (4+7)×6，109 是扩展格点而非同一族。DROPS 是复查统计界失败，不必超 alpha；题风险 40.7%／52.5% 低于 63.0%，不是更差，87.2% 则是条目指标。池覆盖不强迫 10% 接受时约 34% 风险；条目 bootstrap 是近似，独立性／候选族／留出使用均重要。 |
| `retrieval-quality/relevance-gate-calibration-2026-09-09` | 保留 top1 9.00／gap 2.00 为未解单位证据，不猜归一化；19／23 召回不是独立用户。13.1%→20.3% 约 1.55 倍非翻倍，81%→50% 降 31pp；0.438→0.521 是伴精确率代价的召回变化，不是“没有变化”。分数带／ECE 不识别原因，也不授权当前默认。 |
| `retrieval-quality/sufficiency-shape-features-2026-09-12` | 在所有受影响代理结果旁标明假定负例；缺正 qrels 是未知，不是噪声或不可答证明。Fold 复用不是独立任务证据，缺离散度及 10／11 特征绑定明确保留。部分形状特征仍带单位，覆盖分位数既不是风险保证，也不是生产就绪。 |

所读 `certifyPoints`、`boundHolds`、`latticeSpec` 路径及当前相关性训练 owner 用于
解释边界，不是新运行。当前 manifest、训练集派生候选族、显式判定及不具部署资格
产物要求与旧 LoCoMo／qrels 实验分开。未重生成源数据，未改默认、参数、准入规则或
运行时实现。历史命令／表格保留为证据，不是获授权的当前复现配方。

仍明确保留历史未知：未重开原始产物或外部来源，混合分数路径单位未对账，充分性特征
数量缺产物绑定，旧计数／时间不证明配对运行。这些限制现属于读者可见主张，不再藏在
通过／上线措辞后。docs／skills／evals 的有界入链查找未发现受影响引用，不是仓库链接
门禁。未运行测试、lint、format、benchmark、provider／网络、daemon 操作或 Git 写。
DSH 仍未动且停写。旧快照推导队列现为 62：第五批待审 12、第六批待审 16、第七批
分派 16、未分派文件名候选 18；这是队列统计，不是全库语义覆盖结论。

## 第七批收到与第八批分工：2026-10-18

M8 result `1792294546294_000634` 与 N8 result `1792296637184_000637` 已仅作收到 ACK。
整合前独立 raw SHA256 对照确认 16 源、32 输出及三个既有中文基线全部匹配。
M 清单为 `dd8cb3de8fc7d4c9f58ec7ca2db0fff307c86d4fe9557dc24751dd90ca272e4a`；
N 为 `05b4f0093d4cd2a3e67c15407e54c188bb1a521073603d970c39fd24f8a32948`，
也匹配其 deliver digest。原始对照共享于
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round7-intake-2026-10-18.json`。
这只证明交付身份，不证明翻译、语义或门禁验收；round7 及此前全部贡献根／清单冻结。

| 源文件 | 收到时 SHA256 |
| --- | --- |
| `docs/design/archived/file-content-source-design.md` | `c1ec40d9c30335f864a7dd4a3991016df9049adf2932e5fb3d1c228b50b7ca5b` |
| `docs/design/improvement-areas.md` | `75c9334883a10e3c1ee1ffeb98a0e9cb75e848370e1170ae92d1463353a6d026` |
| `docs/design/predicate-key-canonicalization.md` | `8d5f562984e876bc024f7043e581102c1a7805593e9bfff232e98c0cac3ca467` |
| `docs/design/protocol-governed-collaboration.md` | `e2a22386c8b82332e30f50a05b153751f5ada41d015cec23d4d3e53f79a5370c` |
| `docs/design/skillopt-policy-optimization.md` | `3944a78f4d3c9e3da1be187a611b94c07f9bbd54fa66cc339a2d025dae1b08dd` |
| `docs/design/temporary-todo.md` | `f304222b0363798ceca09158df32408f74d4706bd44ff7dbc71e1df012ceff63` |
| `docs/design/temporary-todo/default-embedding.md` | `69b1a1cc61137e75bbf70fb916817f5963daa3471ca91a130a7fe337ece3d1bc` |
| `docs/design/verification-claims.md` | `8981176b3c8c732fea833d714e817515f7d5c968d87de38af3bed74287380575` |
| `README.md` | `e1920ce3c65526e46591d107efe2577887578b8af19b5ec70a25cf31a1f3e84c` |
| `.github/pull_request_template.md` | `7a789c1be6109e32bea7f9f7bc88e2317551db01518d468c2deb8964cf8ec1c6` |
| `.pi/skills/omnimemeval-eval/SKILL.md` | `afc74528775b5e04b82e1fe981e862af41007beddfff006fd22bfcb635693bfd` |
| `AGENTS.md` | `97df92c3854a4b310a700c1d62370e64b4d72db8a3a14f39f9ba4f2af3eb5bfd` |
| `claude-plugins/nmg-memory/CLAUDE.md` | `af129f149eb98c5931198c1176f1c5b9bf69e13a04118e958d8ccd3126e198bc` |
| `docker/README.md` | `f1f2ec65d20d4352175800ac6762ec15387ab68cf3725745223b82dbc50e725d` |
| `kimi-plugin/README.md` | `d65a4f6cacef379d14b9444b38feb150fbca2b69ae0b0f869ec1360237310a1c` |
| `tests/guardrails/README.md` | `2ccf567cf1931c81306de9b050734bbf5e11973cff47abc11003b99802a4f8a2` |

| 既有中文基线 | 收到时 SHA256 |
| --- | --- |
| `docs/design/protocol-governed-collaboration.zh-CN.md` | `c1ada895acd8b241d9be0903e1b63d0f81be2858aa8e139d1d8df86c73c9d249` |
| `docs/design/verification-claims.zh-CN.md` | `b60b314b01cc4d344760df3a26428dc8580d0cc254f2903613119d2da6420325` |
| `README.zh-CN.md` | `934ab6ea8a6d45502a1b6a5e7494b425f584bd68ce97db3b56efcde884dbdb7c` |

PR 模板与 Kimi README 的源正文原本为中文，所交中文副本与其字节相同；这保留了机器
literal 字段，却没有提供英文 primary。两个既有阅读单元的英文 owner 修复仍待处理，
不能另算完成配套。N 清单声称 CLAUDE.md 无自动加载角色，在审查宿主／打包前不接受。
现有 root README、protocol-governed-collaboration、verification-claims 中文均未覆盖，
修订稿须对照后合并。人工整合实验数仍为 50 单元／100 配套文件。

第八批 O8（`1792296925694_000640`）、P8（`1792296925703_000641`）承接余下 16 个评测
README 候选，平衡了较大的 OmniMemEval 与评测策略 owner；精确路径见共享计划，仅可
写各自 `round8/<agent-id>/`。普通 README 不继承活动设计字节上限，长文必须读全译全，
不得截断。源语言或可执行例子缺陷须报告，英文改写建议仅可放入单独列哈希的贡献稿，
不改共享源。没有委托运行评测、provider、安装、下载、门禁或 daemon。

原快照推导队列仍为 62：第五批待审 12、第六批待审 16、第七批待审 16、第八批分派
16、未分派的 DSH 范围停写项 2。源语言债务属于这些既有待审单元，不是豁免或新的
完整性结论；本段不证明全库语义收尾、不批准 DSH 修改，也不启动统一验证。

## 第八批与首组交叉复核收到：2026-10-18

O8 result `1792300028059_000653`、P8 result `1792299915603_000651` 已仅按文件身份收到并
ACK：16 源、32 配套输出逐项匹配清单 SHA256；两清单匹配自报或 deliver digest，两个
交付根均无清单外文件，原始 round8 根现已冻结。这不表示单元已通过语义验收或整合。

首组交叉复核 `1792300075386_000654` 覆盖 I6 的六单元，六个当前源、12 个冻结 peer
输入及四份修订建议匹配其所列哈希，清单匹配 deliver digest。审阅者处置为四项修改
建议、两项 reviewed-no-change，不是协调者验收。术语复用、恢复 fragment、中文伴生
链接与错字修复仍须协调者审查。三个交付的原始身份对照共享于
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round8-and-peer5-intake-2026-10-18.json`
（记录 70 次文件对照，无哈希差异）。

两位贡献者已确认连续队列（`1792299698300_000646`、`1792299707422_000648`）。共享计划
的 `continuousDelegation` 仅授权有界的连续起草／交叉复核，不是最终验收；每人无需
用户逐批批准即可接下一已授权阶段，各阶段新审稿根交付后冻结。收件时有 60 个既有非 DSH 单元待协调者语义整合。在随后 I6 检查点，协调者已审阅并
整合六个单元，尚余 54 个（R5 J6：6，R6：16，R7：16，R8：16），没有新增候选。本文
下述 J6 验收使当前待审积压降至 48 个（R6：16，R7：16，R8：16）。人工整合实验总数
仍为 50／100。DSH 两个范围停写项、PR 模板／Kimi README 英文 primary 债务、源漂移复查、
未决证据及延后的统一验证均未改变。此前收件未执行仓库测试／门禁或 provider／daemon／
Git 操作。

## 协调者实质验收：R5 I6（2026-10-19）

协调者将六个冻结的贡献单元逐篇对照当前英文原文、中文译文、v2 术语记录及相关实现契约，
随后整合了 18 个单元文件。交叉审阅者报告四项改动建议与两项 reviewed-no-change；它们只是
审阅输入，不构成验收。协调者只采纳有依据的建议，否决了对会话工作区单元的 no-change
判断，并作出以下额外的源代码校正：

| 单元 | 协调者处置 |
| --- | --- |
| `memory-graph-reasoner` | 验收并整合。复核 `src/lab/memory-graph-reasoner.ts` 确认 `requires` 是乘到遍历吸收门上的 sigmoid 相似度；事实缺失时回退为 0.5，不硬过滤候选，`trainPath` 不应用它。复用仓内已有的 canonical `Memory-Graph Reasoner` 术语，不再重复定义。 |
| `session-reasoning-workspace-and-compaction-checkpoint` | 实质修正后验收并整合：复核 `src/lab/reasoning-workspace.ts` 确认，证据引用只是非空字符串，不会解析或验证目标是否稳定／外部来源；`add`／`update` 会检查支持锚定，但恢复 JSON 不会重跑该检查。`src/integration/reasoning-workspaces.ts` 按文件修改时间而非最近读取计算清理；`.pi/extensions/nmg/index.ts` 注册的 Pi hook 名称为 `session_before_compact`。2026 年 7 月的测量作为历史文档保留，本次未独立复验。 |
| `stg-ltg-connectivity-and-provisional-memory` | 验收并整合。中文交叉链接现指向已存在的中文伴生，并以当前章节名称替代过时的 `§3–§6` 范围。 |
| `node-identity-and-reversible-canonicalization` | 验收并整合；将中文错字 `提审议` 改为 `提议审阅`。 |
| `session-ag-and-projection-revisions` | 验收并整合。补回指向现有中文标题的两个 heading fragment，并修复英文源中重复的 `through`。 |
| `edge-stability-and-structural-consolidation` | 复核 `src/core/store/graph.ts` 后验收并整合：默认门槛要求活动证据记忆总计四条，并另行检查两个节点各至少被一条证据记忆表示。现已在英文、中文与术语中写明此阈值，避免误解为每个节点都需四条。英文主张与术语也明确该后验门禁针对已存储原子声明的自动合并，不适用于另行受治理操作立即接纳已确认原子记忆的路径。 |

整合为保留单元补充了英文／中文／术语导航，并保持原贡献根与交叉审阅根冻结作为证据。
这些是协调者的语义处置，不是统一门禁回执。未运行测试、lint、format、LSP 检查、benchmark
或文档门禁；统一验证仍待写作与审阅收尾后进行。

## 协调者实质验收：R5 J6（2026-10-19）

协调者将六个单元逐一对照当前英文原文、中文译文、术语 sidecar 及相关实现契约。共享树
编辑之前已核对交付 manifest 与源文件哈希；交付根及交叉审阅根继续冻结。工作者报告与哈希
只是输入，不构成验收。协调者在以下源代码证据支持的修改后，整合全部六组三文件（共 18 个
文件）：

| 单元 | 协调者处置 |
| --- | --- |
| `existing-runtime-components` | 验收并整合。`observe()` 除工具观察与任务板投影外，也能准入显式提供的 `reasoning_artifact`；`semantic_memory` 与 `working_state` 使用不同路径，自动 MGR 准入仍未接线。说明了 Tessera 解析能力的边界，并将 SimHash 指标限定为早先文件样本结果，而非片段级或普遍保证。 |
| `implementation-boundary` | 验收并整合；在英文和中文中将过时的“Section 9”引用改为指向上层实现边界。 |
| `low-compute-router-candidate` | 对齐三份文件后验收并整合：132 参数 `ContextRouter`、`context-features-v1` 与四动作 `context-executor` 是彼此分立的研究原语，不是已组装、启用、验证或投入生产的控制器。 |
| `executable-v1-specification-and-decision-gates` | 澄清宿主授权要求、当前适配器只返回有界内容且不会暴露给主模型，以及按完整片段边界截断的语义后验收并整合。 |
| `session-active-graph-runtime-design/remaining-work` | 澄清 `maxTaskFramesPerSession` 的上限涵盖所有保留帧（包括活动帧）、披露限制是可配置的默认值，以及独立的 `hierarchical-activation` 检索模式不代表 AG 准入／重打分已经接线；据此验收并整合。 |
| `evaluation-and-falsifiable-claims` | 删除对影子分数差异缺乏依据的因果归因，链接详细 BEAM 报告，并注明报告中的 1,540 道 LoCoMo 题与 relevance-gate 报告的 1,532 道计分题分母尚未对账；完成后验收并整合。 |

实现审查涉及 session Active Graph、RCP feedback 与 CLI、ContextRouter/features/executor/trial/
intervention/journal 模块，以及 controller-shadow context dataset。这些是协调者语义处置，
不是统一门禁回执。未运行测试、lint、format、LSP、benchmark/eval、provider、网络、安装、
部署、daemon 或 Git 写操作；统一验证仍待写作与审阅收尾后执行。整体推广仍未完成。

## 协调者实质验收：R6 K8 + L8（2026-10-18）

协调者将 R6 全部 16 个单元逐一对照当前英文源、中文译文、术语 sidecar 与相关实现契约，随后把 48 个源／配套文件整合入共享树。K8 与 L8 交付哈希只证明交接文件身份，不作为语义验收。以下校正和限制现已落入共享树：

| 单元 | 协调者处置 |
| --- | --- |
| `active-graph-activation-and-consolidation` | 验收并整合。补正导航与重复标题的 Core data model 锚点，修正中文跨会话 AG 表述，并保留 session/branch、HA 与 MGR 证据边界。 |
| `core-data-model` | 验收并整合。澄清 `observe()` 与压缩是会话有界的 AG 投影，而非独立 FIFO 缓冲；区分实现与目标、移除过时编号标题，并链接当前 open-design owner。 |
| `incremental-storage-and-index-maintenance` | 对照 config、service 与 store 代码检查维护阈值、全局/局部压力、有界事件循环切片及重试行为后验收并整合。 |
| `learnable-routing-and-differentiable-query-graphs` | 验收并整合。标出当前 controller runtime/QPP 设置与标定入口，区分运行模式、影子控制及研究原语。 |
| `memory-graph-reasoner/differentiable-set-logic` | 验收并整合。修复 research README 路径，并把探针结果限定在历史证据范围。 |
| `progressive-retrieval` | 验收并整合；在英文、中文与术语中明确 `NMG_QPP2_RETAINED_MASS` 及其 0.98 默认值。 |
| `session-capture-and-write-path` | 验收并整合，补充当前导航并修复导出命令代码片段。 |
| `product-boundary` | 验收并整合；对齐缩写签名、recall trigger 上限、逻辑撤回与物理擦除，以及当前 first-response-timing 引用。 |
| `agent-convergence-feedback-design` 与 `harness-formalization` | 验收并整合。将过时的内部章节编号改为具名链接，修正一处中文误译，统一探索动作记法，并限定设计主张的证据边界。 |
| `completion-audit` 与 `requirement-matrix` | 验收并整合；更新过期审计日期，修正 surface-anchor 译法，同时保留矩阵对实现与证据的界限。 |
| `offline-text-space-policy-optimization` | 验收并整合。链接 SkillOpt owner，并记录未对账的七题 LongMemEval 结果与 LoCoMo 1,540 摄入题／1,532 计分题报告，不编造原因。 |
| `implementation-order` | 验收并整合。界定各条“Complete”的局部范围，并注明相对于当前 `nmg.v9`，`nmg.v7` 是历史协议版本。 |
| `implementation-versus-target` | 验收并整合。移除过时 FIFO 描述，明确 reasoning workspace 是 Opt-in Lab 能力但非 Lite 默认，并链接当前 posterior-confidence 标题。 |
| `product-boundary/agent-cli-and-resident-service` | 验收并整合。修复 H1 直接跳到 H3 的标题层级，并依据 `src/cli/protocol.ts` 澄清 `taskRun` 对 `adopt` 字段的能力闸门。 |

完整性例外：整合期间协调者误改了冻结的 K8 `active-graph-activation-and-consolidation.zh-CN.md` 与 L8 `agent-convergence-feedback-design.zh-CN.md` 贡献文件，随后立即恢复。恢复后，两者 SHA-256 均与交付清单一致（L8 文件哈希：`d7e741777198eb167253b73a9ee63b8bde710ad66e403064bf7ee6cd23e3bf0d`）。不得再写入贡献／审阅根；原根继续冻结。

这是协调者语义验收，不是字节预算结果或统一门禁回执。未运行测试、lint、格式化、LSP、文档门禁、benchmark/eval、provider／网络调用、安装、部署、daemon 操作或 Git 写入。在 R6 检查点，尚余 32 个既有非 DSH 单元（R7：16，R8：16）；另有两个 DSH 范围停写项。统一验证仍延至写作与审阅完成后。

## 协调者实质验收：R7 M8 + N8（2026-10-18）

协调者独立对照 R7 全部 16 个单元的当前英文（或中文主源）、交付中文、术语 sidecar 与适用的实现证据，随后将 48 个源／配套文件整合入共享树。交付清单与哈希仅作为文件身份依据。主要协调者处置如下：

| 单元 | 协调者处置 |
| --- | --- |
| `archived/file-content-source-design` | 作为已被取代的设计记录验收并整合；保留「不是记忆」、有界范围与推迟结构化单元的明确边界。 |
| `improvement-areas` | 作为历史缺口分析验收并整合。保留源文内部矛盾与带日期的测量，不擅自调和；修正术语对汇总表“已解决／按实测重开”语义的描述。 |
| `predicate-key-canonicalization` | 验收并整合。保留从初始极性守卫提案到后续结果明确要求仲裁候选对不得加守卫的时间脉络；保留弱模型验证限制及仅作咨询标注的状态。 |
| `protocol-governed-collaboration` | 验收并整合；保留「机制完整、重启责任未分配」的双重状态，并修复中文归属文档链接。 |
| `skillopt-policy-optimization` | 验收并整合；保留仅控制器策略边界、自然标签要求、留出加匹配晋升门禁。 |
| `temporary-todo` | 验收并整合；保留全部未勾选工作与明确推迟的前置条件。 |
| `temporary-todo/default-embedding` | 检查 `NmgService.#signalMaintenance` 与 `#drainEmbeddings` 后验收并整合：嵌入补批按每次操作触发，独立于维护阈值，且采用有界批次与 provider 冷却。将过时的实施前阻塞和条件标成历史；本次未重跑 provider 或端到端检查。 |
| `verification-claims` | 验收并整合；保留伪代码字面量、claim-domain 范围，以及 `decision`、`witness`、`documented-only` 三轴区分。 |
| `README` | 验收并整合；将完整修订版中文与当前英文及既有中文基线对照。修复英文标语多余的加粗标记、补充双语术语导航、修复中文首次输出计时目标，并纠正“bundled local model”与开篇短句的译法。 |
| `.pi/skills/omnimemeval-eval` 与 `AGENTS.md` | 验收并整合；保留 skill 发现元数据、命令字面量及引导入口的职责范围。 |
| `docker/README` 与 `tests/guardrails/README` | 验收并整合；保留容器／provider 健康边界与临时护栏生命周期。 |
| `.github/pull_request_template` 与 `kimi-plugin/README` | 整合同语言伴生与术语，但源正文已经是中文；其英文主文档债务仍未解决，且不计作翻译覆盖。 |
| `claude-plugins/nmg-memory/CLAUDE.md` | 整合译文，但不认可源文的两处问题（自指的重启指令与格式错误的替代安装句）。插件 manifest 未列出此文件，但尚未确立宿主／打包的自动加载行为，因此不接受交付方关于“不自动加载”的主张。 |

在 R7 检查点，16 个单元已验收，尚余 16 个既有非 DSH 单元（R8：16），另有两个 DSH 范围停写项。本处协调者处置不是字节预算结果或统一门禁回执。未运行测试、lint、格式化、LSP、文档门禁、benchmark/eval、provider／网络调用、安装、部署、daemon 操作或 Git 写入。贡献根与审阅根继续冻结。

## 协调者实质验收：R8 O8 + P8（2026-10-18）

协调者将 R8 全部 16 个评测 README 单元的当前英文、交付中文与术语 sidecar 逐一对照，随后将 48 个源与配套文件整合入共享树。交付哈希与审阅报告仅作为输入，不是验收证据。处置与范围限制如下：

| 单元组 | 协调者处置 |
| --- | --- |
| O8：`evals/omnimemeval/README` | 验收并整合。区分历史运行与当前默认值，并保留冷态端到端 `search_duration_ms` 与热态 core 侧车计时的边界。澄清官方 PersonaMem prompt 保持不变，而前缀布局建议只适用于非官方 runner。检查了当前 bridge/cache 代码；未重跑历史分数。 |
| O8：`evals/omnimemeval/research/README` | 验收并整合；将假 API 的序列化字节前缀估算与 provider token 缓存语义区分开。 |
| O8：`evals/adaptive-topology/README` | 验收并整合，并注明 2026-07-19 历史指标未给出工件路径，仅凭 README 无法独立复现。 |
| O8：`evals/beam/README` 与 `evals/locomo/README` | 验收并整合；澄清官方数据集需另行下载，未随仓库提供。BEAM 的 `100K` 目录与 `100K/128K-scale` 表述之间仍缺少明确对应关系，属于待澄清的源文债务。 |
| O8：disclosure、gate 与 memory-quality README | 验收并整合；保留有界的确定性／无 LLM 范围，不把探针提升为广泛能力保证。 |
| P8：`evals/README` 与 adapter README | 验收并整合；保留确定性工程用例、backend benchmark 执行与 Pi 端到端闸门的区别，以及失败即关闭指标与历史证据边界。 |
| P8：`evals/retrieval/README` | 验收并整合；将英文与中文中的六个错误实验链接修正为现存的 `docs/experiments/retrieval-quality/` 路径。 |
| P8：LongMemEval、controller、hierarchy-scale、PersonaMem、reasoning-workspace 与 scale | 验收并整合；保留 manifest／样本规则、官方与诊断性证据、候选与排序限制、合成／本地测量边界、Lab-only 范围及成本／质量权衡。 |

英文源 README 现已链接到中文与术语配套文件；中文导航标签也链接到中文文件。R8 两个批次的 16 个单元已验收；当前队列中不再有按文件名派生的既有非 DSH 单元。协调者也通过将 PR 模板与 Kimi README 正文译为英文、保留中文伴生、修正 Kimi 的“三项能力”表述并更新术语锚点，解决了额外的英文主文档债务。这不代表解除两个 DSH 停写项、恢复未知的前序术语，也不代表已确立 CLAUDE.md 在宿主／打包时的自动加载行为。未运行测试、lint、格式化、LSP、文档门禁、benchmark/eval、provider／网络调用、安装、部署、daemon 操作或 Git 写入。统一验证仍延至写作与审阅完成后。

## 持续文档组防回退检查（2026-10-18）

第一项持续维护切片把 `scripts/verify-document-groups.ts` 接入既有 `docs:check`。它从 `docs/`、`skills/` 及根 README 的英文、中文和术语文件并集发现文档组，拒绝缺件、非普通文件、新增单语主题和孤立配套。CI owner 记录唯一带清理条件的运行草稿例外。本次未引入小节哈希、翻译质量门禁、新正文模板或 DSH 修改；现有链接与术语检查保留各自范围。

以下验证针对有未提交改动的 writing-rollout 树，不是干净检出回执：

- 独立文档组检查：333 组，零错误，一份已声明可丢弃的运行草稿。
- 四项目标套件（`document-groups`、`document-hygiene`、`verify-docs`、`glossary-check`）：105 项测试，104 通过、1 失败、零跳过。新增的 16 项分组用例全部通过；其中一项运行 package 拥有的 `docs:check` 组合：结构检查通过后，删除配套退出 1，补回退出 0。
- 两个新增 TypeScript 文件的 LSP 为零诊断；限定文件的 ESLint、Prettier 和自有路径空白检查通过。
- 仓库 `docs:check` 在原有结构阶段失败：26 个错误、7 个警告，尚未进入新增分组阶段。剩余错误包括不受支持的历史状态／头字段，以及超限的 `task-unit-semantics.md`；不能称为统一通过。
- `glossary:check`：363 个定义、171 个错误。仓库级 glossary 测试因既有 status 缺失、owner 标题过期和引用未解析而失败。调试器确认这些错误在加载目录时产生；没有放宽 schema，也没有编造定义。

最初重复增加的准入表行使治理设计双语文件超出既有字节上限，随后删除该重复行，继续由权威 CI 表拥有范围。恢复后的治理文件分别为 14,995 和 14,984 字节。组合命令 fixture 也必须使用真实脚本路径，而不是 junction 别名：别名会改变 `argv[1]`，而 `import.meta.url` 指向真实模块；fixture 文档还必须含正文，才能通过既有卫生检查。

未运行全量产品套件、`agent:verify`、benchmark/eval、provider／网络调用、安装、部署、daemon 操作或 Git 写入。下一步先修复上述文档／术语债务，不改变检查严重级别，再考虑新增规范或声明推广验证通过。

## 既有债务清理（2026-10-19）

本节处理上节记录的失败，工作对象仍是 HEAD 为 `823d96e9`、含未提交改动的
writing-rollout 树；不把第一切片的历史失败追改为通过。

- 将不受支持的叙述性状态／头部标签改为普通正文，保留必需生命周期字段；修复术语
  status 缺失、YAML 引号、别名及精确 owner 标题，不改变 schema。
- 将二十个既有定义搬入已登记的 design 术语配套，原位置改为引用；合并重复概念定义，
  收窄过宽的 edge-activation 别名，并区分历史记录级 polarity 与当前 claim 元数据。
  另补二十个有源文支持的既有用词定义，包括同步编码接口与显式执行工具集合。
  规范词形不证明运行时接入，也不代表恢复六份未知前序文件。
- 将完整任务细化与确定并发章节搬至
  `docs/design/task-unit-semantics/refinement-and-concurrency.md` 及中文伴生，并补术语
  配套。与拆分前审阅快照比较，双语两个章节的文字均保留，仅去掉末尾空行；父文保留
  原标题作为入站锚点并路由到子文。父文分别为 14,605／12,502 字节，子文分别为
  3,287／2,679 字节（英文／中文），未提高字节上限。
- 三项回归用例先在旧检查器上失败：中文子树指令入口被误分类、多条反向链接未被
  解析、正文示例被视为元数据。调试器确认，现有双目标退役字段在单链接模式下得到
  零匹配。修复后在头部内逐目标检查，真实缺少反向链接或正文放错位置仍会告警。
  这随后揭示双语退役记录各缺一条真实反向链接；核对其决策范围后补上。
- 空白检查发现十三行尾空格；移除段末无用空格，并将两对元数据改用空行分隔，
  保持字段分别呈现而不依赖行尾空格换行。

本地验证只覆盖以下列明检查：

| 检查 | 结果 |
|---|---|
| `npm run docs:check` | 669 个文件，零错误、零警告；334 个文档组，零错误，一份已声明可丢弃草稿 |
| `npm run glossary:check` | 422 个定义，零错误；登记发现范围不变 |
| `document-groups`、`document-hygiene`、`verify-docs`、`glossary-check` 四套件 | 108 项全部通过；失败、取消、跳过均为零 |
| 定向 LSP | 两组检查器／测试共四个文件，零诊断 |
| 限定范围 ESLint 与 Prettier | 两组检查器／测试均通过 |
| 自有路径 `git diff --check` | 退出 0；六条非致命行尾规范化提示，未改配置 |

套件使用 `node --experimental-strip-types --test`，目标为
`tests/docs/document-groups.test.ts`、`tests/docs/document-hygiene.test.ts`、
`tests/docs/verify-docs.test.ts` 和 `tests/tools/glossary-check.test.ts`。
79 项 implemented 决策与 31 项仍含待办的决策是不同计数；文档检查通过不等于
这些待办已解决。

没有放宽 schema、严重级别、已登记术语范围或字节上限；未引入小节哈希、正文模板或
DSH 修改。未运行全量产品套件、`agent:verify`、benchmark/eval、provider／网络工作负载、
安装、部署、daemon 操作或 Git 写入。

## 限制

检查不提取全部自然语言术语引用、不生成产品 concept map、不在创建时检测概念重复，也未
把术语策略固定到外部 trusted install。小节确认 hash 未启用。

本轮已登记、获准修改的非 DSH 队列已审阅整合，列明的本地文档检查已通过；当前未发现
范围内仍未通过的验收项。DSH 停写范围和未核实的前序文件清单事实保留为明确边界，
不据此将本轮判为未完成。不把本报告扩大为范围外覆盖、全仓文笔或阅读效率测量、
remote CI 或全量产品验证，也不将这些另设为本轮完成条件。

## PR 93 主线接入（2026-10-19）

隔离文档分支为 [PR 93](https://github.com/wefio/NodeMemoryGraph/pull/93) 接入 main
`1534e98acbdd93f037d128b5ee0ce8720abf3234`；48 个文档冲突均有明确工作文件解法。
相对该 main，运行时实现与锁文件不变；非文档差异仅为八个文档检查器／测试文件与
package 所拥有的文档命令。

上游存储、SQL 过滤／绑定、证据选择后的词法并列顺序、声明恢复、测试资源及自动等待
预算事实归入对应双语拆分 owner。预算前排序与保留的源版本功能／事件记录明确限定
历史范围，不冒充当前主线实现。恢复说明区分九个声明的 SQLite 场景、迁移证明与
真实进程证据。

持续文档组检查发现 main 带入的 24 个缺失伴随文件；补齐十八份术语伴随与六份中文报告。
原长篇中文行为组合报告补成完整英文主文，保留表格、命令、历史失败、证据边界与已有
入站锚点。定义仍在已登记 design 术语范围内。协议表仅去掉填充空格、不改表格单元；
十一处行尾空格改为保留字段分别呈现的形式。

| 集成分支检查 | 实测结果 |
| --- | --- |
| `npm run docs:check` | 711 文件，0 错误、0 警告；355 文档组、0 错误、1 份已声明可丢弃草稿 |
| `npm run glossary:check` | 433 定义、0 错误 |
| 四套文档／术语聚焦套件 | 108 passed；失败、取消、跳过均为 0 |
| 八个自有 TypeScript 文件 | LSP 0 诊断；限定格式化与 ESLint 完成 |
| PR 差异空白与冲突标记 | 无行尾空白诊断或工作文件冲突标记 |

这些观测归本次集成工作区，不沿用原工作区的完整 verifier 回执。完整本地验证、远端
检查与发布状态由 PR 93 分别报告，未执行不算通过。本节未执行依赖安装、部署或 live
provider／benchmark 工作负载；此前获准队列的已接受完成状态不变。
