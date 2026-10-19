# OoO 结果准入探测 — 2026-09-08

[English](ooo-admission-2026-09-08.md) · [术语](ooo-admission-2026-09-08.terms.yaml)

## 问题与范围

协调器拥有的验证能否在乱序结果到达时安全准入，同时不因 worker 自报、重复投递或过期执行而释放依赖任务；这也包括任务在相互独立的进程之间移动的情形。

这些是研究探测，不是产品设计决策。小型可信核心的思路借鉴了外部验证方法，见 [CI/RCP 固定可信基线验证](../design/ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.zh-CN.md)。这些探测没有引入 RCP，也不继承其固定安装隔离。它们没有改变任何 NMG 默认协议、Task Board 语义、AG 或宿主会话行为。

**后续状态：** 专用研究工具 `ooo_round` 于 2026-09-14 离开产品工具目录。本报告记录此前的研究 instrument，不授权再次运行，也不证明产品运行时集成。见[历史 S3/S4 工具记录](../design/ooo-execution-bootstrap/historical-round-tooling.zh-CN.md)。

## 复现

```sh
node --experimental-strip-types --test evals/ooo-execution/admission.test.ts evals/ooo-execution/narrow-dispatch.test.ts evals/ooo-execution/multiprocess.test.ts
```

这些检查由显式命令运行，不属于产品测试 gate。需要支持 TypeScript stripping 和 SQLite 的 Node；不需要模型、网络 provider 或已安装的 daemon。本地 HTTP 绑定到 loopback。每个进程测试使用自己的全新临时数据库，并且即使失败也只会终止自己创建的子进程。

## 本地准入探测

[admission.ts](../../evals/ooo-execution/admission.ts) 及其[检查](../../evals/ooo-execution/admission.test.ts)使用复制出来的固定计划、由协调器拥有的同步谓词、绑定 instance/revision/input/attempt 的 tickets，以及本地接受前的再次检查。DAG 预检使用 Kahn 算法（memory-chain 排序中也有该算法），但会拒绝环，并在开始时纳入孤立任务。这不是通用调度器。

本地 Maps 只足以支持这项探测。它们不提供跨进程所有权、持久化接受或重启恢复。

## 多进程探测

实现：[board-admission.ts](../../src/integration/ooo-board.ts)。  
进程启动：[process-fixture.ts](../../evals/ooo-execution/process-fixture.ts)。  
场景：[multiprocess.test.ts](../../evals/ooo-execution/multiprocess.test.ts)。

驱动器会启动一个独立 daemon 进程和两个不同的 worker 进程。daemon 使用真实的 `NmgService`、`httpHandler` 和 Task Board SQLite store。worker 通过未改变的 board JSON-RPC endpoint 发现 handoff 并发布结果条目。IPC 只控制 fixture 的操作与时序；任务和 candidate 结果通过 HTTP 与 board 传递。worker 从不打开 SQLite。

fixture 增加了一个 loopback `/admission` endpoint，但它不是已注册的产品 RPC。其 claim 操作在一个 SQLite 事务中，将现有 `claimTaskBoardEntry` 与持久化 generation 递增组合起来。可变任务状态、input binding、已接受输出和 run identity 都保存在同一数据库的探测表中。可信策略是固定的三任务算术计划；没有通用的持久化 DAG 编辑器或任务 revision 迁移。

candidate 数据从归属于 worker 的 board 结果中读取。worker 的 `passed` 标志会被忽略。验证发生在 commit transaction 之前；在 `BEGIN IMMEDIATE` 内，authority 会重新读取 generation、owner、input binding、board claim identity 和 lease 有效性。已接受的任务输出不可变。相同当前 attempt 的相同结果是 duplicate，而不是第二次完成。

Board `put` 拥有自己的事务。因此探测会一起提交接受结果和 board resolution，然后再发布决策与新满足资格的 handoff。持久任务行表示待发布事项。重启或重试时，单一 authority 会清空这些待发布项；如果发布已提交、但任务链接尚未保存，它会接管现有的匹配 board 条目。这是小型 transactional-outbox 模式，不是原子投递，也不保证外部副作用 exactly-once。

Lease 过期使用显式 coordinator test clock，推进 61 秒。真实 board claim 实现会收到其支持的 `now` 参数，并使用正常的 60 秒最小 lease。这是确定性的过期注入，不是墙钟延迟或生产 wake-loop 测量。Verifier/commit barriers 也是 fixture 专用的 IPC 控制，worker HTTP 无法访问。

## 窄范围派发

共享的 [OoO integration module](../../src/integration/ooo-execution.ts) 按固定计划顺序选择第一个 eligible task。effect classes、input revisions 和 external-event declarations 由 coordinator 拥有，不由 worker 拥有。只有当第一个 pending task 明确在等待其 external event 时才允许越过它；input 缺失或过期不构成跳过许可。最多允许一个未解决的 external wait 和一个正在 claim 的 task。只有 `read-only` 与 `isolated-artifact` 任务符合资格；未知或 shared-write effects 会 fail closed。

选择操作与 board lease 和 attempt 递增在同一 claim transaction 中运行。external event 就绪不会抢占已有 runner。input versions 在选择时和最终准入时都会检查；版本变化会阻止复用和依赖工作，但不会自动改写计划。探测中的 revision 观察是可信 fixture 信号，不是已实现的文件变更监视器。

缩窄后的进程 fixture 起始状态是：A 等待 `interface-response`，B 已就绪，C 依赖两者。只有选中的 task 会作为 handoff 发布。若先发布等待中的 A，它会占用现有 board 串行 outstanding slot，使 B 无法 claim；集成这些规则时实际观察到了这一点。探测不会绕过或更改该 board 协议。等待任务状态留在 SQLite；coordinator events、过期刷新、完成与重启会重新评估发布资格。claim 时仍会按权威 eligibility 检查现有 handoff。v3 snapshot-work policy 会绑定 seed plan，并拒绝较旧或不同的探测数据库；测试使用全新数据库。

这些约束管理的是这个固定算术 executor 的准入。它们不会 sandbox 任意工具，也不能证明 worker 声明的 effects 诚实。

## 观察结果

- 合并运行：**12 项测试通过，0 项失败**（六项本地准入检查、四项共享派发/snapshot 检查、两项复合多进程场景）。
- 两个多进程场景都额外连续通过了 **5 次**。
- TypeScript LSP：窄范围派发所改五个文件中 **0 条诊断**。

准入/恢复多进程场景验证：

1. driver、daemon 和两个 worker 拥有不同 PID。
2. 在 coordinator external event 到来前不能 claim A。竞争 claim B 时只有一个胜者；并发重复提交只产生一次接受。事件到来后，即使 A 的 artifact 不正确，只要它带 `passed` 也不会因此被接受。
3. A 被挂起时 B 可完成，且不会发布 C 的 handoff。
4. 即使尚未重新分配，过期的 A 提交也会被拒绝。另一个 worker 获得 generation 2 后，已完成验证的 generation-1 candidate 仍会在最终事务中被拒绝。
5. daemon 在 A 的接受已 commit、但 C 的 handoff 尚未发布时被终止。重启后只发布一次 C；旧 A 仍为 stale，新 A 为 duplicate。
6. worker 发布 C 的结果后被终止；daemon 也在提交前被终止。另一个 worker 找到保留的结果并提交。
7. daemon 在 C 的接受已 commit、但其 decision 尚未发布时被终止。重启会修复发布；两次重新提交都为 duplicate。最终接受输出为 A=4、B=6、C=10，且恰有三条 decision entries。

第二个多进程场景在 B 运行时让 A 就绪，并验证 A 不能抢占，也不能获得第二个 slot。它在 B 完成验证、提交之前改变 B 的 input revision：B 的结果变为 stale，C 不会释放，且 B 不会针对变化后的输入自动重试。worker 直接发起 claim 请求不能绕过尚未发布的依赖。未知 external events 会被拒绝。纯规则检查覆盖固定优先级、多个等待者、未知/shared effects、缺失输入和传递失效。

## Live Pi SDK 运行 — 2026-09-09

选择逻辑、输入预算、工作指令和精确 artifact 检查位于 [`src/integration/ooo-execution.ts`](../../src/integration/ooo-execution.ts)，不依赖 Pi。 [Pi adapter](../../.pi/extensions/nmg/ooo-execution.ts) 只构造一个新的 Pi SDK session 并返回 artifact/usage。SQLite 生命周期与 board 传输留在研究 coordinator 中，不在 Pi adapter 里。这是显式 SDK 集成，不是注册的 slash command，也不会自动替换用户当前的 Pi session。

adapter 不加载 extensions、skills、AGENTS 文件或 prompt templates。唯一启用的工具是 `read_snapshot`，它不接受路径/命令，只返回已捕获的任务数据。adapter 会检查活动工具列表，要求成功调用工具读取，限制读取次数/turn 数，并在 45 秒后中止模型运行。最终文本仍须由 coordinator 接受。每个 task 都使用全新 context，不迁移 AG。

显式 live 入口（模型认证留在 Pi 正常凭据存储中；命令或报告不得包含凭据）：

```sh
# Set PI_PROVIDER / PI_MODEL to the intended configured model first.
node --experimental-strip-types evals/ooo-execution/live-pi.ts --live
```

与单元测试不同，这会调用真实 provider。默认测试命令绝不会运行它。该运行从 `README.md` 与 AG runtime 文档中截取有界文本，启动隔离 coordinator 和两个 Pi worker 进程，并将本地 metadata 写入 `.nmg/ooo-live/latest.json`。Live 请求使用墙钟 claim 时间；本次运行禁用了 clock/commit fault controls。external-ready event 由 driver 在 B 之后明确控制，不由模型推断。

使用 `openai-codex/gpt-6-astra` 观察于 2026-09-09 14:25 UTC：

| 顺序 | 任务 | 已接受 artifact | Snapshot 读取数 | Tokens | Worker 执行毫秒 |
| --- | --- | --- | --- | --- | --- |
| 1 | B：提取 AG 文档标题 | Session Active Graph runtime | 1 | 3924 | 8367 |
| 2 | A：external release 后提取 README 标题 | Node Memory Graph (NMG) | 1 | 4094 | 11289 |
| 3 | C：合并已接受的 A/B 值 | 两个标题，先 A 后 B | 1 | 358 | 7749 |

三个 artifact 都通过了精确检查，涉及两个 worker PID 和三个不同的 Pi session ID。trace 记录了 B 在 A 仍受阻时完成，随后 A 和 C 在显式 release 后完成。该运行报告 8376 tokens。它证明通过共享契约执行了真实模型/工具调用，但**不是加速测量**：没有匹配的顺序基线，且 external wait 是受控的。读取/提取标题不等于代码任务质量验证，也不等于自主任务规划。

集成后验证：12 项探测测试通过，LSP 在改动的八个 TypeScript 文件中报告零诊断。限定范围的 `agent:verify` 通过了 TypeScript、build、documentation 和 glossary 检查，但完整产品套件**未通过**：1163 项通过，1 项失败。失败是 dirty-worktree complexity gate 报告了与本实验无关的 `tools/recall-instance-judge.ts:191`（`main`，complexity 16，limit 15）。本实验没有修改该文件。验证 run ID 为 `aea26373-f431-4fcb-811c-19fefcfb11ab`。

## S0 补丁提案探测 — 2026-09-09

第一个 bootstrap seed slice 在 snapshot contract 旁增加了有界 patch-artifact contract，依据是[bootstrap 设计](../design/ooo-execution-bootstrap.zh-CN.md)：

- [`src/integration/ooo-patch.ts`](../../src/integration/ooo-patch.ts) 将宿主拥有的 work envelope（task identity、attempt、instruction、file set、editable allowlist）冻结为 detached、frozen 结构，并绑定 SHA-256 digest。`patchCandidate()` 使用 HOST 冻结副本验证 worker 提案：只允许整文件替换、只允许可编辑路径、执行预算限制、不接受 worker `passed` 标志。它返回 candidate 文本；写盘应用、语义 verdict、lease 和取消仍是独立步骤。
- Pi adapter 新增 `executePiPatch()`：保留 fresh-session、snapshot-only-tool 接口，但返回不可信 JSON 提案，而非最终答案。
- 五项 contract/safety 测试覆盖 identity/attempt/instruction binding、digest 过期、路径遍历与 Windows device aliasing、大小写冲突、精确结构和拒绝未改动文件。全部 17 项 OoO 测试通过；LSP 报告零诊断。
- 显式 live 探测（`evals/ooo-execution/live-patch.ts --live`，仅允许编辑冻结的 `src/integration/ooo-execution.ts`）：`google/gemini-3.5-flash` 首次就返回有效的整文件提案（2,901 tokens、一次读取、两轮）；配置的 `openai-codex` provider 多次调用遇到 usage limit。使用用户授权的 `B.AI` provider（`glm-5.3-flash`）观察到四次调用：provider 429、`patchCandidate` 拒绝格式错误的 JSON、超时，随后得到结构有效的提案（3,131 tokens、一次读取、两轮）。JSON parse error 不能证明格式错误输出的成因。两个成功探测都只通过了子串检查（存在 `planIndex`、不存在 `byId`），**没有**证明不存在其他改动。最新 metadata 在 `.nmg/ooo-live/patch-probe.json`；它不是更严格 verifier 的证据。

提案被丢弃：没有写入工作树，也没有 task 被标为 accepted。

后续修复恢复 Pi 正常停止要求，并为成功读取后的 error/aborted/length/tool-use termination 增加负向覆盖。探测的宿主 oracle 会将完整 candidate 与精确预期 rename 对比，拒绝无关编辑。每次调用都有唯一 task identity，并分别记录开始和结束。

探测现在会在全新的一次性目录中检查 candidate 文本，使用固定的 TypeScript syntax-check 子进程、有界输出与超时、空的 child environment、唯一 check ID 和真实终态时间戳。它只解析，不执行 candidate 代码。之后会再次检查精确内容，并删除所属目录。语法检查不是类型检查或行为验证。本机的一项负向测试发现该 Node 安装对格式错误的 TypeScript 使用 `--check` 会返回零；修复后的 checker 改用 TypeScript parser diagnostics。

2026-09-10，一次获授权的 `deepseek/deepseek-v4-flash` live 调用通过修复后的 exact-rename oracle 和隔离语法检查：3,367 tokens、一次读取、两轮、artifact 4,149 bytes。Check ID 为 `a71ad776-cf44-4a57-af93-4898770804e3`；candidate 被丢弃而未提升。最新 `.nmg/ooo-live/patch-probe.json` 标明 verifier `exact-nextTask-rename-v1`。20 项定向 OoO 测试通过，LSP 干净。限定范围验证 `b91fae49-c8f6-46f3-b42c-6dea37631867` 通过 type checking、build 和 docs；产品测试为 1,171 项通过 / 1 项失败，失败仍是无关的 `tools/recall-instance-judge.ts:191` complexity violation。

S0 仍在进行。后续 coordinator slice 在 SQLite 中持久化宿主签发的 check identity、input digest、attempt、owner 和 check lease。签发新 check 会围栏旧 check；取消与终态准入使用现有 immediate transaction 边界。重开后重复终态证据仍无效果。Stale input、过期 lease 与已取消 attempt 不能释放 A；undecidable 结果会保留等待。失败检查可以释放 repair task，但接受检查证据不会接受该 task，也不会释放 C。旧 fixture release method 会拒绝由此协议管理的等待。

一个本地集成测试把真实 syntax-check 子进程绑定到 coordinator check ticket，并准入其终态结果。这是 host-trusted plumbing，不是经过认证的 worker 证明。它尚未展示完整 live patch-worker A/B/C 周期、check-process recovery 或 candidate promotion。固定 syntax checker 仍是 probe 专用的宿主实现。

Coordinator 现在也会在同一 SQLite plan 中把 patch task 作为一等 work item，而非 side channel：

- Patch task 的冻结输入（instruction、file set、editable allowlist）由宿主拥有；worker 只接收 digest 和可读 snapshot。
- 宿主 verifier 在构造 plan 时固定。已提交提案必须先满足冻结 contract，再通过 host check；worker 的 `passed` 字段或 `verdict` 会作为未知字段拒绝，而不被信任。
- 只有 accepted candidate 才成为 task 输出，依赖项绑定到宿主派生的 candidate 文本。被拒提案不接受任何内容；重新签发 attempt 会通过 digest 围栏旧 worker artifact。
- 被拒 attempt 保留 claim，符合既有 snapshot 语义：同一个 worker 可以修正它；只有 lease 过期后重新签发（或新 attempt）才会取代它。

确定性测试套件中有 28 项定向测试通过。S0 的四项退出检查现在分别有证据：真实模型 patch 通过 exact oracle、candidate-directory 语法检查、绑定的 external check event、拒绝过期或未验证 artifact。但它们尚未作为一个 live A/B/C 周期运行，因此这里报告的是引导（bootstrap）证据，而不是自举。

## S1 第一轮 — 2026-09-10

第一轮真实 A/B/C 运行通过 `evals/ooo-execution/live-cycle.ts --live`，使用 `deepseek/deepseek-v4-flash`；该轮基线冻结为七个未提交 OoO 文件，并使用一个固定检查（protocol regression test 文件对）。宿主启动了绑定 coordinator check ticket 的后台检查进程；每次提交都会在冻结 revision 的一次性 git worktree 中重新运行检查，并创建 `node_modules` junction。工作树从未被修改。

| 时间 (UTC) | 步骤 | 详情 |
| --- | --- | --- |
| 05:57:15.856 | 签发 check | `1bd07fbe-035d-4780-a229-544cf10eafcc` |
| 05:57:15.859 | B 被 claim | attempt 1，digest `5d9b22626e35` |
| 05:57:19.946 | B 被接受 | conclusion `no-change-needed` |
| 05:57:19.949 | check 终态 | 真实检查通过 |
| 05:57:19.950 | 派发 A | coordinator 仅在该事件后选择 A |
| 05:57:27.338 | A attempt 1 | 拒绝：模型返回散文，而非 JSON envelope |
| 05:57:30.947 | A 被接受 | attempt 2，conclusion `no-change-needed` |
| 05:57:33.348 | 组合检查 | 通过（组合 candidate 与基线相同） |
| 05:57:37.123 | C 被接受 | conclusion `promote-candidate` |

存在真实重叠：B 在后台检查结束前 3.2 秒完成；check 尚未终态时不能选择 A。这是本轮的第一个结论：**合法的乱序执行，但没有有用的开发变更**。三个任务都得出没有理由改动的结论，因此组合 candidate 与基线逐字节相同，本轮没有产生可供下一轮采用的 patch。这不是自举。

该 contract 捕获了两种失败模式，也暴露一个未捕获的缺口：

- A 和 B 首次都用 Markdown 散文而不是 envelope 作答；共享 contract 拒绝了它。宿主重新签发的 attempt 将拒绝原因回报给 worker，随后才得到 JSON 格式。
- conclusion evidence 只检查是否非空。B 声称现有测试已覆盖六个指定 case，该说法凭散文就被接受，没有经过验证。设计要求 no-change conclusion 有可核查依据，因此这是本轮暴露的真实缺口。

## S1 第二轮 — 2026-09-10

第一轮结束时留有一个漏洞：只要 no-change conclusion 有非空文本就会被接受。第二轮先封闭这个漏洞，然后又运行四个 live round，每轮都暴露 round machinery 自身的不同真实缺陷。所有运行使用 `deepseek/deepseek-v4-flash`、与第一轮相同的 revision 和 check command，且从未修改工作树。

**这些运行迫使 contract 作出的改变**（均在 `src/integration/ooo-cycle.ts`、`src/integration/ooo-patch.ts`、`.pi/extensions/nmg/ooo-execution.ts` 中）：

| 观察到的失败 | 改动 |
| --- | --- |
| 非空散文被接受为 no-change 依据 | 只有每个宿主冻结的 case 都能解析到一条 citation，且 citation 的精确标题存在于冻结来源时，才接受 conclusion；虚构、误引或缺失 citation 均 fail closed。`cannot-complete` 是 blocked report，因此会停止 round，而不是解锁 A 或 C。 |
| 模型返回 Markdown 分析而非 envelope（B、A 各两次） | prompt 现在预填真实 digest、可编辑路径列表和两种 JSON 形状；此后没有运行再返回散文。 |
| 模型输出超出长度限制，guard 拒绝截断答案 | worker 失败或返回截断输出时，将 attempt 及其原因记为失败，不让 round 崩溃，也不自动重试。 |
| 宿主因从未声明的规则拒绝 B（隐藏的“最长词”标题 token） | case 规则现在作为显式的宿主冻结 `{name, token}` pair，写入 instruction。 |
| 拒绝提交不可见：报告没有拒绝原因 | driver 记录共享 contract 自身的 parse error，并将有界的拒绝 artifact 留在 `.nmg/ooo-live/rejections.json`。 |

**Live round 的测量结果**

| Round | B 的结果 | A 的结果 | 原因 |
| --- | --- | --- | --- |
| 1 | accepted，`no-change-needed` | accepted，`no-change-needed` | 两个结论都没有可核查依据；round 没有产生 patch。 |
| 2 | accepted，`no-change-needed` | rejected：散文，不是 envelope | B 的六条 citation 都能解析到冻结测试文件中的真实标题。 |
| 3 | rejected：worker 撞到输出长度限制 | 未到达 | 截断 guard 触发；整个运行没有生成报告。 |
| 4 | rejected：candidate worktree 中真实检查失败 | 未到达 | B 添加的测试断言了协议并不具备的行为；检查捕获了它。 |

Round 2 和 4 再次显示真实重叠：B 仍在工作时后台检查已结束；只有终态事件之后 A 才可选择，且没有任务被抢占。每一轮 check 自身的结果都是 `accept`。

**第二轮后的状态。** 没有任何一轮产生可供后续轮次采用的有用变更，所以 S1 退出条件仍未满足，这不是自举。round machinery 确实拒绝了所有不符合冻结 contract 的 artifact，包括一个真正未通过检查的 artifact；这是 S1 gate 要检验的性质。

**运行暴露的未决问题。** 将 case 解析到测试 _标题_ 只能证明标题存在，不能证明测试断言了该 case。第二轮六个 token 中有三个（`cancellation`、`restart`、`never`、`escap`）没有出现在任何冻结标题里，但冻结套件确实用其他说法测试了 cancellation 和 expiry。要求 worker 满足标题 token 会诱发冗余测试——第四轮 B 写了一项，结果失败。要证明一个 case **未覆盖**，需要负向控制（破坏该行为后确认测试套件仍然通过），不能只匹配标题。

多进程检查验证的是一个权威 daemon 与独立、合作式 worker 进程，不是多 daemon/HA 或多设备测试。SQLite 状态和谓词由 coordinator 拥有，但这不是对抗性 sandbox：board author ID 不是经过独立认证的 worker identity，共享 bearer credential 也不是逐 worker ACL。恶意 worker 若能访问数据库或执行任意标准 board mutation，不在模型范围内。Ticket 和 hash 绑定执行/内容；它们不是凭据、签名，也不证明 verifier 正确。验证仅限固定算术与精确 snapshot-text 谓词，不是通用代码任务 evaluator。

Task rows 会持久化，但 board entries 仍保留普通的 24 小时 TTL。未证明 TTL 到期后的恢复、长期保留、lease renewal、取消、动态计划变更、超出这个微型 board 的分页、自主 wake/re-poll 行为或外部副作用幂等性。Notification repair 只在显式 fixture/coordinator 边界运行，而不是生产后台 reconciler。

## S1 第三轮 — 2026-09-11

第二轮留下的问题是：把 case 解析到测试标题，无法证明测试断言了该 case。第三轮用 mutation proof 替换了这条规则，并运行六次 live round（均使用 `deepseek/deepseek-v4-flash`、revision `6f5504d6`），使 loop 从“没有可核查依据”推进到“得到宿主验证的有用变更”。

**现在由宿主先证明缺口，再请求工作。**

`evals/ooo-execution/mutation-probe.ts` 会将宿主拥有的单项替换故障注入 `src/integration/ooo-check.ts`，再运行真实固定检查。第三轮开始时，冻结套件有五个故障仍能存活；这证明没有测试能检测到这些故障：

| Mutant | 第三轮开始时状态 |
| --- | --- |
| `sameCheck-ignores-attempt` | 存活 |
| `sameCheck-ignores-expiry` | 存活 |
| `sameCheck-ignores-digest` | 存活 |
| `checkResultValid-accepts-unknown-outcome` | 存活 |
| `checkResultValid-log-bound-off-by-one` | 存活 |

`cycle.ts` 现在会拒绝启动一个声明 mutant 并未存活的 round，因此存活是前置条件，而不是假设；每次模型调用之前都会重新证明所有声明 mutant（每个 1.6–9.2 s）。采纳了生成测试的已发表保留规则：patch 只有通过未改动实现、并且至少杀死一个声明 mutant 时才会接受。一旦某 mutant 已被证明存活，no-change conclusion 会被直接拒绝，因为宿主自己的证据与之矛盾。

**Live round 结果**

| Round | B | A | 说明 |
| --- | --- | --- | --- |
| 3.1 | 拒绝：未改动实现检查失败 | 未到达 | worker 添加的测试断言了协议并不存在的行为，而且没有方式运行测试套件。 |
| 3.2 | 拒绝：自检通过后返回散文 | 未到达 | check tool 可用（运行 1 次，输出 “the check accepts my proposal”），但随后 worker 改为叙述，而不是返回 artifact。 |
| 3.3 | 拒绝：未改动实现检查失败 | 未到达 | 使用了三次自检；worker 报告 “11 of 12 passing”，并修正了最后一项断言。 |
| 3.4 | 拒绝：宿主的 title-token 规则 | 未到达 | 已声明为 proven-gap mode，但 token 规则仍然运行并拒绝 candidate；意图只写在注释中，未被强制执行。 |
| 3.5 | 拒绝：散文；worker 表示看不到 mutants | 未到达 | instruction 声称列出了已证明的故障，但 `cycle.ts` 只打印 case rules。worker 无法读到的要求就不是可执行要求。 |
| 3.6 | **接受：通过未改动实现检查，并杀死全部五个声明 mutant** | 拒绝：散文 | 组合 candidate 恰好只改一个文件：`evals/ooo-execution/check-events.test.ts`。 |

Round 3.6 是这一研究线第一次产出经过宿主验证的有用变更：冻结套件从检测不到五个故障中的任何一个，变为检测到全部五个。它**尚未被采纳**，因此 S1 退出条件仍未满足：round 要求 A 和 B 都接受，C 才能提升；而六轮中有四轮 A 返回了散文。

**这些 round 迫使系统具备的能力**（每项都来自观察到的失败，不是推测）：

- `.pi/extensions/nmg/ooo-execution.ts` 增加宿主提供且有界的 `run_check` 工具：worker 可对提议的文件运行本轮固定检查（通过与提交相同的共享 contract 校验，`maxRuns` 由宿主冻结），因此可以自检 patch。没有这个工具时，每个新增测试都是盲写。
- 在通过自检后 worker 改为叙述；工具结果和 system prompt 现在会在决策点重申 artifact 形状。
- `cycle.ts` 把声明的 mutants 和 case rules 打印进 task instruction，并绑定到 digest，使 worker 能读到每条接受规则。
- 拒绝原因与已接受 candidate 会持久化；否则有用产物只存在于生成它的进程里。Round 3.6 的 accepted 文本曾因这个缺口丢失，现在只剩其 mutant-kill 结果描述。

**领域证据标准仍缺少的内容：** 在冻结任务集上重复试验、留出检查、以及节省时间或 token 的任何测量。第三轮能证明的是：当一个独立任务仍被阻塞时，真实 external wait 可以承载另一项任务，并得到宿主验证且可证明有用的结果。

## S1 第四轮 — 2026-09-11

本轮落地了测量 contract 和下游 pushback machinery，并进行了一次 live 运行。相关机制由 58 项 offline tests 覆盖；这次 live run 首次报告了真实成本。

**测量结果（deepseek-v4-flash，revision `90178712`，首次包含这些字段的 round）：**

| 数量 | 值 |
| --- | --- |
| B worker | 78,172 tokens、4 turns、2 次 self-check、37.0 s |
| A worker | 38,859 tokens、3 turns、1 次 self-check、6.0 s |
| 被覆盖的 external wait | 1,602 ms（check 在 B 运行期间返回 `accept`） |
| 宿主检查工作 | 13 次 check、21,903 ms |
| Reopens | 0（C 未运行） |
| Verdict | B accepted（杀死全部五个声明 mutant），A rejected：散文 |

**数字说明什么。** 本轮用了 117k worker tokens；宿主花 21.9 s 本地检查来验证，而被覆盖的 external wait 只有 1.6 s，是其 13.7 倍。因此，免费的 A 类工作值得做（当时已在做：全部五个 `mutant-survived-baseline` 证明，约 7.7 s，在 B 的 37 s 模型调用期间完成，而不是在 round 开始前完成）；但与验证成本相比，“靠猜测来填满等待”只会是噪声。未来的任何收益主张都必须对照这份账，而不是只看等待时间。

**Class-A 效果可从时间线看出。** 前提证明发生在 13:05:33.3–13:05:39.4，B 的模型调用持续到 13:06:12.2，check 在 13:05:33.3 进入终态：必需的宿主工作从 round 前的关键路径移开，external wait 不再是瓶颈。

**A 的失败已成为稳定 blocker，文献比“ framing ”更能解释它。** A 的职责是判断自己的文件是否有错；七轮中有五轮它用散文作答，包括自检通过之后。B 的职责是命中明确目标；只要按该格式表达要求，B 就会输出有效 JSON。已发表解释不是“角色措辞”：显式推理会损害指令跟随（[When Thinking Fails](https://huggingface.co/papers/2505.11423)）；堆叠约束会非线性降低服从率，应编译为更少且互不重叠的约束（[Instruction Stacking Collapse](https://arxiv.org/html/2608.02639v1)）；格式成本由剩余容量承担，而 A 的重任务留下的容量更少（[Capacity, Not Format](https://arxiv.org/html/2606.09410)）。文献不支持把改写 persona 当成修法（[Personas in System Prompts](https://doi.org/10.18653/v1/2024.findings-emnlp.888)）。同一文献指向的架构修复是停止在 prompt 中反复要求格式，改在 sampling 时约束：本仓库 SDK 已通过 `defineTool` 暴露 `Tool.constrainedSampling` 与 `{type:"json_schema", strict}`，因此 artifact 可成为 schema 即 contract 的有界工具调用；仍须保留宿主验证，因为约束解码只会消除语法失败，不会消除结构或语义错误（[Structured Output Control](https://arxiv.org/html/2606.09395v1)）。我们还在四处重复了相同格式规则（patch prompt、system prompt、check tool result、pushback note），这正是文献建议移除的 constraint-stacking 模式。

**Pushback 路径状态。** 声明前提后的 reopen、attempt 中途 pushback tool 和有界 reopen loop 都有确定性测试，但还没有 live round 执行过它们：round 在 A 处结束，C 的要求尚未被评估。

## S1 第五轮 — 2026-09-11

这是第一次**三个任务全部接受**（`rejections` 为空）的 round；此前完成了格式工作的步骤 1–2：通过 `submit_artifact` 工具交付 artifact，工具 schema 就是 contract，并请求 provider-side constrained sampling；prompt 只陈述一次格式约束，而不是重复四次。

| 数量 | 值 |
| --- | --- |
| B worker | 67,513 tokens、4 turns、1 次 self-check、60.6 s |
| A worker | 96,601 tokens、6 turns、2 次 self-check、12.8 s |
| C worker | 41,920 tokens、4 turns、1 次 self-check、7.5 s |
| 被覆盖的 external wait | 1,577 ms |
| 宿主检查工作 | 15 次运行、23,317 ms |
| Reopens | 0 |
| Verdicts | B accepted（杀死全部五个声明 mutant）、A accepted、C accepted |

**散文失败类别已消失。** A 返回了带已解析 citation 的 `no-change-needed` conclusion；此前七轮有五轮 A 返回散文。B 和 C 也通过工具提交。运行中的三条 `pi turn error: This operation was aborted` 是预期路径：记录 artifact 后工具会中止 session，worker 无法继续说话（或在提交后自相矛盾），宿主也不会把文本当作答案。

**已接受的 artifact**（该 round 的产品，持久化在 `.nmg/ooo-live/` 下）：`evals/ooo-execution/check-events.test.ts`，7,350 bytes，新增十项测试且没有删除测试（测试标题从 4 增至 14）。它在未改动实现上通过，并在此前五个未被检测到的 mutants 上全部失败。记录当时它尚未由人提升到下一轮基线，因此 S1 退出条件只差最后这一步。

**如实计算成本。** 本轮花费 206k worker tokens 和 23.3 s 宿主验证时间，对比 1.6 s external wait，验证仍是主导成本。A 现在是最贵的 worker（六轮用 96.6k tokens、两次 self-check），尽管它给出的答案是 no-change conclusion；这是下一步成本调查的具体目标，不是调度问题。

**Class-A 效果在时间线上可见。** 前提证明发生于 13:05:33.3–13:05:39.4，B 的模型调用持续到 13:06:12.2，check 于 13:05:33.3 进入终态：必需的宿主工作从 round 前的关键路径移开，external wait 不再是瓶颈。

**尚未在 live 中执行：** 下游 pushback 边（声明前提、attempt 中途 pushback、reopen）仍只有确定性测试；因为 C 声明的要求首次尝试就已满足，不需要 reopen。

## S4 对照 harness：同一冻结计划上的顺序与乱序 — 2026-09-12

该阶段要求在_同一_冻结计划上进行对照，并报告质量、时间、tokens、失败与人工介入，而且不预设有收益。因此 round 增加了第二种派发顺序：

- `mode: "ooo"`（默认）——为等待任务签发 check，独立任务在 check 等待期间运行，然后按固定计划顺序派发。这是被测设计。
- `mode: "sequential"`——先等待 check，再派发任何任务。计划、输入、checks 和接受规则都相同；只有顺序不同。

模式属于 round identity（`compareFrozen` 会比较它），因此不能把 sequential round 重放成 out-of-order round，还声称它是同一轮。

`round-compare.ts` 会将两个 arm 各运行 `N` 次；每个 arm 有自己的 store、log 和 record，并报告 verdicts 与 acceptances（质量）、墙钟时间、宿主检查及宿主耗时、被覆盖的等待、tokens、cache reads、worker check runs、被杀死与存活的 mutants、失败和 reopens。如果两个 arm 的质量不一致，对照会明确指出并以非零状态退出，**不会**比较时间——它们就不是同一轮。

离线 arms 的测量（记录答案、真实宿主检查、`times: 1`）：

```
ooo:        verdicts {"B":"accepted","A":"accepted","C":"accepted"} accepted {"A":"…","B":"…","C":"…"}
ooo:        wall 5166 ms, host 5868 ms over 5 check(s), hidden wait 775 ms, tokens 0, …
sequential: verdicts {"B":"accepted","A":"accepted","C":"accepted"} accepted {"A":"…","B":"…","C":"…"}
sequential: wall 4533 ms, host 4429 ms over 5 check(s), hidden wait 0 ms, tokens 0, …
out-of-order minus sequential wall clock: 633 ms (slower) — reported, not treated as a result on its own
```

如实解读：这些 arm 使用记录答案，worker 会立即返回，因此**没有模型时间可供重叠**；out-of-order arm 慢了 633 ms，这是宿主检查调度开销，不是设计本身的效果。只有 live arm 能报告 tokens 和真实墙钟时间，但每次重复都要为每个 arm 花完整 round。是否这么做是操作者的决定，所以这里标为尚未运行，而不是猜测结果。

两个真实 coordinator defect 只有在顺序执行走到乱序 round 没走过的路径时才暴露；两者都会阻塞任何顺序运行：

1. **未被认领、且不再是当前选择的 task handoff 占住了 board 串行 slot。** 顺序执行中，B 的 handoff 仍 pending 时 check 已进入终态，此时 A 成为选中 task，却无法 claim：`entry …_000002 is pending until the prior serial entry is claimed`。`publishReady()` 现在会撤销任何既非 selected 也非 live 的 task publication，且不围栏它（没有 worker claim 的 task 没有 ticket）。
2. **`publish()` 会接管内容相同但已 resolved 的 publication。** 接管规则用于恢复 post-put/pre-link 崩溃，但它会匹配任何内容相同的 entry，包括刚由前一个修复解决的 entry，于是 row 被链接到无人能 claim 的 entry（`already resolved`）。接管现在要求 `status='open'`。

第三个较小问题：`claimableRow()` 会把尚未发布 handoff 的 task 报成 “unfulfilled dependencies”，让读者误以为依赖有问题。现在三种 refusal 都按真实原因命名，并先检查依赖，因为依赖能解释_为什么_没有发布。

## S3 入口：从 spec 执行 submit / status / cancel — 2026-09-12

该阶段只要求为手工重复的操作提供入口，并遵循 durable-agent harness 已有形态。手工重复的操作是编辑 `live-cycle.ts` 来改 round 输入、读取 stdout 了解结果；此前完全没有入口的是取消。因此新增：

| 文件 | 作用 |
| --- | --- |
| `round-spec.ts` | 将 round 描述为数据：baseline paths、checks、两个 task 的 instruction/editable/visible subset、case rules、declared faults、admitted conclusions、preconditions、budget、limits、worker kind |
| `round-runner.ts` | 将 spec 冻结为 round，写入 run directory（store、log、`run.json`），并报告状态 |
| `round-cli.ts` | `submit <spec> --run-dir <dir> [--live]`、`status --run-dir <dir>`、`cancel --run-dir <dir> --reason <text>` |

重复运行受支持的 round 不需要改脚本：同一 spec 先运行一次（记录 log），再以 `worker.kind = "replay"` 指向该 log 重跑。S2 slice 的 round identity 检查确保安全：如果 spec 的冻结工作与 log 不同，就会具名拒绝，而不是重放到另一轮。

取消现在支持跨进程，这正是 S2 原先缺少的机制：`cancel` 把 decision 写入 round 自己的 store；正在运行的 round 会读取该 store（等待时每 250 ms 一次，并在每个 dispatch 点检查），然后自行取消、推进每个 attempt，并杀掉在途 check 的进程树。离线测试用廉价方式证明了 contract：若另一个进程在 round 开始前写入取消，本轮会消耗 **零次 worker 调用**，报告 `cancelled`，且不接受任何内容。

构建此功能时暴露的四项缺陷都在 round 内，不在入口本身：

1. Store 已记录取消的 round 会在第一次 coordinator 调用时抛出 `round cancelled`，而非明确终止。现在会先 trace plan 和终态事件，再返回取消结果（verdicts `cancelled`，composition `undecidable`）。
2. 该提前返回路径泄漏 coordinator 的 store connection，导致 Windows 上无法删除 run directory（`EPERM`）——原因是连接泄漏，不是清理操作。
3. `cancel()` 不具幂等性：第二次取消会覆盖第一次的原因，事后改写 round 记录的终态 decision。现在保留首次 decision，并由 `recovery.test.ts` 固定此要求。
4. 原始 artifact contract 要求 `kind` discriminator（`kind: "conclusion"`），该字段由 artifact _tool_ 为模型补上。因此在测试中手写答案并不等同于走工具路径，宿主曾以 `invalid patch structure` 拒绝一个答案——提醒我们工具只是 contract 的便利接口，不是 contract 本身。

明确说明范围：入口位于 `evals/` 下，通过 `npm run ooo:round` 使用；round engine 仍在 `evals/ooo-execution/` 中，没有修改产品 CLI。Spec 由操作者编写，因此 spec paths 不按不可信输入处理；会进入冻结 envelope 的路径仍是 repository-relative，使同一 spec 在其他机器上含义一致，而记录 log 可以归档在任意位置。

## S2 退出：真实进程取消，以及绑定到 round 的 replay — 2026-09-12

S2 的退出条件有两部分。恢复部分已由 `recovery.test.ts` 覆盖；这里补上设计本身列出的另外两个缺口：使用真实进程取消（改进项 3），以及 replay 要么复现同一 round、要么明确拒绝伪装成复现（改进项 1）。

**Replay 以前没有绑定到 round。** 提升 round 7 artifact 改动了 `evals/ooo-execution/check-events.test.ts`；该文件属于冻结基线，因此属于每个 task digest。相同 `round.jsonl` 随后重放时结果从 `A/B/C accepted` 变成 `rejected`——结果可见但原因未归属，而且只是碰巧可见：只比较终态时，即使 round 不同也可能匹配。为此写测试后又发现第二个问题：修改 check 的**命令**，冻结 digest 和 verdict 都不变，因为 verification rules 不属于任何 task 的 frozen work。因此 round identity 现在涵盖三项，replay 会检查三项并具名拒绝：

| 记录内容 | 对照内容 |
| --- | --- |
| 每个 task 的 frozen digest（baseline files、instruction、declared faults、budget、limits） | replay 实际 claim 的 digest |
| `revision`（round 的 candidate 所针对的 checkout） | 作为 replay 的 revision 使用，确保移动后的 `HEAD` 不会静默验证不同代码 |
| `checkDigest`（check commands、arguments 和 labels） | replay 即将运行的规则 |

未记录 identity 的 log 会被重放为**未验证**，而不是复现——与 complexity gate 遵循的“有测量 / 从未检查”规则相同。

**取消以前只有机制，没有真实进程证据。** `runCycle` 现在接收操作者的 `AbortSignal`；abort 时 round 会在 coordinator 中自行取消（推进每个 attempt，使迟到 artifact 成为 `stale`）、杀掉所有仍在运行的 check 进程树、停止派发、停止组合，并在终态记录 `cancelled`。`src/integration/ooo-candidate.ts` 在 POSIX 上以 `detached` 启动 check，在 Windows 上用 `taskkill /T` 杀树。

实测结果（首次尝试较弱，报告中如实说明）：

| 测试 | 固定验证的性质 |
| --- | --- |
| 进程内运行，使用真实子进程和 worktree | 取消后 round 为 `cancelled`、不接受任何内容、composition 为 `undecidable`、check 及其 grandchild 都已退出，且没有遗留 candidate worktree |
| 真实多进程（`Actor` daemon + worker） | worker 在途 delivery 变为 `stale`、不接受任何内容、不发布 `C` 的 handoff、`next()` 返回空，且取消原因在 daemon 重启后保留 |

两个诚实边界都来自测量，而非假设：

- Windows 上杀进程树是**冗余的**：替换为普通 `child.kill("SIGKILL")` 仍通过测试，因为 libuv 会把非 detached 子进程放进 job object。POSIX 上显式 kill 才能成立（detached process group 加 `process.kill(-pid)`）。
- 测试中的 grandchild 没有 detached。任何**故意**detached 子进程的 check 都不在断言覆盖范围内；已证明的是当前 check 的进程形状（`node --test` workers），不是任意进程逃逸。
- Teeth check：禁用取消路径会使进程内测试失败（有断言证明），因此测试对其声称覆盖的代码敏感。第一版测试在前后比较 `git worktree list`，与其他创建 worktree 的测试发生竞争；单独运行能通过，但完整并行运行时连续失败三次。现在测试把 OS temp dir 指到自己拥有的目录，因此泄漏检查只针对本 round。

## S2 slice 2，live round 7：log 重放真实 round — 2026-09-12

Round 7 在提升后的基线上运行完整 A/B/C round，并且**接受、没有拒绝项**（`deepseek/deepseek-v4-flash`，revision `70731640`）：B 116,424 tokens / 6 turns / patch 11,421 bytes；A 37,240 / 4；C 168,769 / 9；总计 322,433 worker tokens；15 次宿主检查 / 29.4 s；`reopens 0`。B 的 patch 新增一个测试标题（16 → 17），并在 round 外独立重测：artifact 在未改动实现上通过，并杀死**两个**声明故障——本轮目标 `bound-ignores-runid` 和第六轮的 `reopen-keeps-attempt`。

随后 `--replay` 从 `.nmg/ooo-live/round.jsonl` **不调用模型**就复现该 round：verdicts 和 timeline 相同，15 次宿主检查 / 29.4 s。Live round 花费 322,433 worker tokens；重新检查其产出不花 worker tokens。如实说明：replay 只重新派生宿主自身能检查的内容，因此它证明的是**宿主**的 verdict，不证明被记录的答案是模型当时最好的答案。

**Replay 与 round 共发现四个编排缺陷，与模型答案无关：**

1. **编排不确定。** A 的 frozen instruction 包含每次签发时随机生成的 `checkId`，所以每轮 digest 都不同，replay 第一次尝试就被宿主以 `stale patch digest` 拒绝。现在 check identity 从 round 自身状态派生。
2. **文本通道使用更弱的 contract。** Patch 文本答案曾被原样记录，宿主只能在模型费用已产生后以 `invalid patch structure` 拒绝。现在文本答案经过与 artifact tool 相同的 envelope；形状不符的答案会成为记录了拒绝原因的失败 attempt。
3. **Prompt 指向错误的通道。** System prompt 仍写着 “your reply must begin with `{`”，它描述的是文本答案，也是模型实际遵从的方式。Patch attempt 现在要求通过 artifact tool 作答；文本路径仍是经过验证的 fallback。
4. **无法测量的前提被报告成 false premise。** 并发 `git worktree add` 会间歇性失败，矩阵却把 `undecidable` 合并为 “already detected”——有一轮把仍存活的 mutant 报告为在前一个之后 **76 ms** 被杀。现在 proof 有三种结果（`survived` / `killed` / `unmeasured`）；未测前提会以 `premise-unmeasured` 停止 round，而非 `premise-invalid`；candidate worktree 会进行有界重试。

同一轮还促成两项相关改动，遵循同一规则——_task 依赖于它的 instruction 所声称的内容_：

- **派发前先证明前提。** 早先有一轮把 **204,164 tokens**（B 的整次调用）花在一个已经为假的前提上。宿主证明只需数秒，因此现在先等待证明，再 claim task；在相同故障清单上测得，false premise 现在花费零 worker tokens。
- **派发被拒时关闭它已发布的内容。** 跳过 task 后留下 board handoff；由于 board 会串行化可操作 entry，round 中所有后续 claim 都会被阻塞。`withdrawHandoff` 会解决该 entry 并围栏 attempt。

### 第七轮提升 — 2026-09-12

提升经过明确的人类决策（与第五、六轮相同）。Candidate 替换了 `evals/ooo-execution/check-events.test.ts`（9,450 → 10,752 bytes，测试标题 16 → 17）；旧版本保存在 `.nmg/ooo-live/check-events.test.ts.round6-promoted`。两个固定 check 文件现在运行 22 项测试。

| Fault | 提升前 | 提升后的基线 |
| --- | --- | --- |
| `bound-ignores-runid` | 存活 | **被杀** |
| `reopen-keeps-attempt` | 被杀 | 被杀 |
| `bound-ignores-input-digest` | 存活 | 存活 |
| `bound-ignores-claimed-at` | 存活 | 存活 |
| `issueCheck-skips-stale-input-guard` | 存活 | 存活 |
| `cancel-keeps-check-tickets` | 存活 | 存活 |
| `withdraw-handoff-keeps-entry` | 存活 | 存活 |

按规则在提升后的树上重新测量：新基线能检测 candidate 所检测到的故障，且不会漏掉旧基线能检测到的故障。仍有五个 fault 存活，因此下一轮的前提成立，无须重新推导；并且必须从声明清单中删除 `bound-ignores-runid`，否则再次声明就成为 false premise。

**未解决且有归属的两项负载敏感测试 flake。** 合并运行（`evals/ooo-execution/*.test.ts` + `tests/integration/*.test.ts`）中有两项测试各失败一次，但单独运行和每次重跑都通过：`MCP adapter registers, discovers, and directs to a stable agent` 与 `recovery: a lapsed claim is a new generation, not a silent success`。Recovery test 将 `gate.now` 作为逻辑时钟推进（`BoardAdmission.now`，而 `claim()` 将其作为 `now` 传给 board，因此不是依赖真实时钟）；尚未诊断导致负载敏感的原因，三次刻意加压的重跑也没有复现。在把 `evals/` 接入 CI 之前这很重要：若 gate 因负载失败，人们就会学会重新运行它；因此必须先理解 flake，或先以有界并发运行 eval tests。

第六轮 fault 现在由该轮产出的基线检测；再次声明它会成为 false premise。声明列表由当前冻结套件上的 candidate 探测刷新（`MUTATION_SPEC=<spec> mutation-probe.ts`）——一次 probe 结果只对其测量的那棵树有效。

## S2 slice 2：round 记录自身，并在不调用模型的情况下 replay — 2026-09-11

本仓库其他地方已经采用的 durable-execution 分工是“确定性 orchestration，将不确定工作作为 activity result 记录”。模型调用属于 activity，因此 replay round 时不得再次调用模型；verdict 必须由冻结输入和已记录答案推导。

`src/integration/ooo-round-log.ts` 增加了记录机制：JSON-lines event stream（plan、check issued/terminal、claim、artifact 或 worker failure、pushback、verdict、每个 mutant outcome、reopen、terminal state），并提供 `recordedWorker(events)`（从 log 回答而非调用模型）和 `compareTerminal(recorded, replayed)`。

**Replay 发现了真实的不确定性。** 首次 replay 没有复现 round：A 的 frozen instruction 嵌入了 check 的 `checkId`，而它每次 issue 都由新的 `randomUUID()` 产生，因此每轮 digest 都不同，宿主以 `stale patch digest` 拒绝了记录的 artifact。这是正确拒绝——envelope 确实不同。修复应在 coordinator：check identity 现在由 round 自身状态派生（`digest([taskId, attempt])`，scope 为 store，`runId` 仍是 discriminator），因此同一 round 会产生相同 envelope。round 中其他内容没有不确定性：timestamp 出现在 events 中但不进入 digest，attempt 同时属于两者。

| 性质 | 证据（`evals/ooo-execution/replay.test.ts`，5 项测试） |
| --- | --- |
| replay 复现 round | 记录的 A/B/C round replay 后 `compareTerminal` 为空；恰有三次记录 attempt，且不调用模型 |
| 不信任 log | 编辑 log 中的 artifact 后，round 会以不同 verdict 完成：宿主重新检查它 |
| 检测截断 | 缺少记录的 attempt 会作为 recorded worker failure 报告，且该 task 的 terminal state 发生偏离 |
| 拒绝格式错误的 log | 不是 JSON、未知 kind、缺失 timestamp 都会使读取失败，而不是静默跳过 |
| replay 仍然是 round | 即使忠实 replay 的 artifact 被宿主拒绝，它仍会被拒绝 |

Live cycle 会写入 `.nmg/ooo-live/round.jsonl`，所以可以稍后用已记录答案重新运行宿主检查，复验真实 round——重新检查一轮所产内容不需要约 200k worker tokens。Replay **不能**证明：新的 log 行不会以宿主看不到的原因改变 verdict（这里只重新推导宿主自己的检查），也不能证明 log 防篡改（它不是：各行没有 hash chain，信任它就是信任一个普通文件）。

## S2 slice 1：恢复、显式终止与取消 — 2026-09-11

仅离线运行；不调用模型。S2 退出条件是“故障注入后无重复完成、错误解锁或无限等待；重启后能恢复或明确终止”；本 slice 用 `evals/ooo-execution/recovery.test.ts` 的 8 项确定性测试覆盖该条件，并增加了两个所需的 coordinator 能力：

| 注入的故障 | 观察到的行为 |
| --- | --- |
| coordinator 在 claim 仍有效时崩溃 | successor 不会偷走 claim；holder 的 artifact 被接受；重新提交为 `duplicate` |
| claim 被 withdraw 后退休，再发生崩溃 | 旧 ticket 的 artifact 为 `stale`；只有仍有效的 generation 可以完成 |
| claim lease 过期 | 恢复时会用**新** generation（`attempt + 1`），被退休的 ticket 为 `stale` |
| check 永不回报 | `abandonCheck` 只记录一次 `undecidable`，具幂等性；伪造 ticket 不能结束等待 |
| round 被取消 | `next()`/`claim()`/`issueCheck()`/`externalReady()` 全部拒绝；迟到 artifact 为 `stale`；原因在重启后保留 |
| store 缺少新列 | 增量迁移保留 claim、attempt 和 ticket identity |

两个新的 coordinator 能力是 `cancel(reason)`（round 级别；推进 attempt 围栏所有 task，并撤销待处理 handoff）和 `abandonCheck(ticket, reason)`（为否则只能等 lease 过期的等待显式记录终态 decision）。两者均具幂等性，并绑定到已签发的 ticket。

该 slice **没有**证明什么：log-and-replay。状态存放于 SQLite，successor 可从中继续，但模型调用没有被记录为可 replay 的 activity，因此无法从 log 重建 round。真实多进程取消时的 orphan-process 行为也未测试——这里只验证 coordinator 层的取消，没有测试活跃 worker 进程。

## S1 第六轮 — 2026-09-11（提升后的基线，使用受限 snapshot）

命令：`PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash live-cycle --live`。Revision `90178712`。本轮在**第五轮提升后的基线**上运行，因此能实际观察 S1 退出条件，而不是只作声明。

| Worker | Tokens | Turns | Self-checks | cacheRead | Time |
| --- | --- | --- | --- | --- | --- |
| B | 177,503 | 7 | 1 | 132,352 | 100.5 s |
| A | 32,547 | 4 | 1 | 16,768 | 7.1 s |
| C | 33,530 | 4 | 1 | 16,896 | 8.2 s |

Hidden external wait 1,985 ms；7 次 host check 合计 16,226 ms；`reopens` 0；`rejections` **0**；verdicts 为 B accepted、A accepted、C accepted；组合 verdict 为 accept。

**本轮完成了真实工作。** 之前各轮声明的 mutants 都已被提升后的基线杀死，因此本轮声明了一个基线仍未检测到的 fault：`reopen-keeps-attempt`（reopen 路径清除了 row，却保留 attempt，导致 fencing generation 从未推进）。宿主在 round 开始前证明了该缺口（`mutant-survived-baseline`），B 的 accepted patch 将其修复。用同一 verification library 在 round 外通过一个命令独立复测：

| `reopen-keeps-attempt` 对照对象 | Verdict |
| --- | --- |
| 当前基线（round-5 promotion） | 存活——缺口真实存在 |
| round-6 candidate（9,450 bytes、16 个标题、+2 项测试） | **被杀**——缺口已修复 |
| round-6 candidate 对未改动实现的检查 | accept |

### 本轮需要的三项结构修复

失败已不再是散文；每一项都暴露了宿主提供 worker 一个宿主自己会拒绝的答案通道：

1. **受限 snapshot。** 整个 59,874-byte 基线曾在每个模型 turn 重发。现在可读子集由宿主声明并绑定到 digest（`visible`）；可编辑路径绝不会被隐藏；冻结但不显示的内容会在 prompt 中点名，因此缩小可见范围不是隐藏规则。被隐藏的是 `ooo-patch.ts`、`ooo-execution.ts`（占 59.9 KB 中的 16.7 KB）。
2. **允许的答案通道。** 一轮通过 `kind: "no-change"` 和散文 `conclusion` 作答，因为 envelope 只检查字段是否_存在_；后续另一轮在必须返回文件的 task 上回答 `promote-candidate`，因为 schema 开放了所有 kind。现在工具 schema 从 task 冻结的接受规则（`admittedConclusions`）派生 enum，discriminator 来自工具自身的形状。
3. **Ticket 携带冻结 work。** Ticket 的 patch payload 曾手工列出字段，因此每次新增字段都被静默遗漏，driver 与 coordinator 的 digest 连续两次不一致。现在 ticket 直接携带冻结 work，driver 从 ticket 重建，mismatch error 会指出差异字段。

其中两个 bug 是由 digest 而非测试发现：可读子集按输入 key 顺序排列默认值，admitted set 只对显式分支排序。两者都让 digest 依赖声明顺序。

### 成本，以及它能与不能说明什么

Measurement contract 现在会记录 provider cache accounting；provider 确实缓存了内容：B 的 177 KB 中有 132 KB，以及 A、C 各自约一半 tokens 是 `cacheRead`。忽略它的 worker 成本说法都会偏向于夸大成本。A 从第五轮六轮、96,601 tokens 降至本轮四轮、32,547 tokens；受限 snapshot 减少每轮上下文的 28%。两轮的 turns 不同，因此这不是干净的逐轮测量。“tokens ≈ turns × snapshot”的简单模型适用于第五轮，但不适用于第六轮；逐轮成本仍是未决问题，不能当作结论。与此前每轮一样，宿主验证仍远高于 external wait（16.2 s 对 2.0 s）。

### 提升（第六轮）

第六轮 candidate 在明确的人类批准后提升；旧版本保存在 `.nmg/ooo-live/baseline-pre-promotion/check-events.test.ts.round5-promoted`。提升后的树重新测量，而不是信任 round 自身 verdict：

| Mutant | 提升前 | 提升后 |
| --- | --- | --- |
| `reopen-keeps-attempt` | **存活** | **拒绝（被杀）** |
| `submit-skips-fencing-recheck` | 被杀 | 被杀 |
| 第二/三轮的六个 mutants | 被杀 | 被杀 |

两个固定 check 文件现在运行 21 项测试（原为 19 项），offline suite 有 78 项。提升后的基线由第五轮产品叠加第六轮产品构成；新基线检测到了 candidate 检测到的故障，且不比旧基线检测到的故障更少。

## S1 退出：提升 — 2026-09-11

第五轮接受的 candidate（`evals/ooo-execution/check-events.test.ts`）在明确的人类批准后提升为工作基线；旧版本保存在 `.nmg/ooo-live/baseline-pre-promotion/check-events.test.ts`，用于回滚。提升不能只凭 round 自身 verdict 接受：提升后的基线经过独立重测。

| Mutant | 提升前 | 提升后 |
| --- | --- | --- |
| `sameCheck-ignores-attempt` | 存活 | **拒绝（被杀）** |
| `sameCheck-ignores-expiry` | 存活 | **拒绝（被杀）** |
| `sameCheck-ignores-digest` | 存活 | **拒绝（被杀）** |
| `checkResultValid-accepts-unknown-outcome` | 存活 | **拒绝（被杀）** |
| `checkResultValid-log-bound-off-by-one` | 存活 | **拒绝（被杀）** |
| `sameCheck-loose-owner` | 被杀 | 被杀 |

在提升后的树上运行 `evals/ooo-execution/mutation-probe.ts`，结果为 `baseline: accept`，六个 mutants 的检查都失败；因此套件现在能检测之前漏掉的每一种故障。新基线通过测试（两个固定 check 文件共 19 项；整个 offline suite 70 项）。

这是该研究线第一次由 round 产生变更、由宿主验证、然后_用于下一轮基线_——即 S1 的退出条件。它不能证明 loop 有速度或质量收益、能在没有人工提升时工作，或能迁移到本仓库自己的 check protocol 之外。

## 信任边界与剩余证明

已记录的 live run 使用真实 Pi SDK agents。它没有测试 background tool continuation、AG context restoration 或 same-session safe-point activation。这证明的是受限多进程准入和真实 agent 执行 adapter，不是通用 Agent OoO scheduler 或经测量的加速。此类探测不要求 HA/MGR scoring。