# 功能注册表

[English](feature-register.md) | [简体中文](feature-register.zh-CN.md) · [术语](feature-register.terms.yaml)

**权威范围：**[父级注册表](../hidden-features-registry.zh-CN.md)。本表覆盖非默认能力、模式开关与重要配置项。精确实现细节以英文 owner 和当前源码为准；代码名、环境变量、RPC、路径、值与错误文本保持原样。

## 功能注册表

| 功能 | Gate／开关 | 默认值 | 含义摘要 | 状态／owner |
|---|---|---|---|---|
| OmniMemEval deployed HTTP transport | `NMG_OMNI_API_URL`、`NMG_OMNI_API_TOKEN`、`NMG_OMNI_API_NAMESPACE` | OFF；默认本地 NDJSON 桥 | 带鉴权和显式 namespace 的同步 AML Add/Search；不做本地 embedding 预检，不支持重定向、删除或操作级物化记录 | 显式启用，验证范围由各实验限定；[Benchmark 集成](../../../evals/omnimemeval/README.zh-CN.md#集成边界) |
| Board event records and Agent task status | `board-events`；`nmg_state space=board`；沿用既有协调 gate | 跟随共享黑板 gate；记录创建是显式动作 | 带版本粗粒度历史、直投／频道／事件通知、邀请驱动的频道订阅（可退出）、由任务 owner 派生的公开状态；无链长上限，不新增模型或轮询器 | 源码验证与部署分开 |
| Automatic recall deadline and timing | 无 env gate；Pi `/nmg recall timing` 查看诊断 | ON | [五秒绝对等待预算](../session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.zh-CN.md)；显式搜索不受自动期限约束；实现位于 `src/integration/recall-budget.ts` 与 Pi／WorkBuddy adapters | 默认开启；共享 integration owner |
| Maintained AG working state | `nmg_state space=ag action=write operation=enable`／`nmg state write ag enable` | writer OFF | 有界 session lease；`replace(text)`／`clear()`；拒绝过期、secret、超预算写入；disable／过期撤销 writer 但保留文本；Pi 每个用户回合通过共享 InformationView 原子携带状态 | opt-in writer；仅确定性机制；[state spaces](../state-spaces.zh-CN.md) |
| Grouped context information | `prepareInformationOutput` 的 `format`；Pi 选择 `context` | library/tool `flat`（8,000）；Pi `context`（16,000 UTF-16 units） | 按用途分组 source-bound entries；wrapper 纳入预算；state／recovery 优先于可选材料；仅完整 item 入选；不代表披露、provider receipt 或第二个状态 owner | source／contract 已分别验证；[state spaces](../state-spaces.zh-CN.md) |
| Retrieval relevance gate | program half 无 gate（始终开）；model half 使用 `<dataDir>/relevance-model.json` | program ON；model OFF 且未 armed | program half 确定性且只删除候选；model half opt-in，可重排披露预算；离线训练／认证与 runtime admission 分开；评测集不能作训练数据 | program 默认开启（2026-09-09）；model opt-in／unarmed；shape head、coverage knob、provenance guard 仍在推进；[relevance training](../relevance-training.zh-CN.md) |
| Fixed trusted RCP baseline | `nmg-rcp trust-install <repo> <reviewed-commit> <new-external-dir>`；`trusted-verify` | OFF | 显式安装才是批准；仅 committed snapshots；baseline policy／test／dependency 变更需另行批准 | opt-in，仍需回归验证；[RCP trusted baseline](../ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.zh-CN.md) |
| Narrow-default verification gate | `agent:verify` 默认；`--full`／`--narrow` 可覆盖；route 的 `verify.sharedChecks: none` | narrow ON | 仅当所有改动范围都由一个非共享 route 独占时采用 narrow；执行固定共享检查加 route 测试，否则执行 route blocking set。`sharedChecks: none` 只能用于共享检查无法覆盖的独有 surface；必须声明 route 自有测试，不能覆盖共享路径；receipt 记录实际 gate | 已实现（2026-09-07）；[narrow/full verification](../ci-cd-and-quality/repository-control-plane/lightweight-verification.zh-CN.md) |
| Online context-use learning（ContextRouter） | `NMG_CONTEXT_ONLINE_LEARNING` | ON | 值为 `"0"` 时关闭；其他值（包括 `"false"`）开启。搜索产生 disclosure graph 时由 daemon 暂存；`recordFeedback` 只训练指定 graph，不回退到 session-latest；写入 `<dataDir>/context-router-online.json`（132 参数，不保存样本行） | 默认开启／本地推进中 |
| Self-contained recall-instance corpus | `NMG_RECALL_INSTANCES` | ON | `"0"` 时关闭；每次 disclosure recall 追加未标注 `{trigger, candidates(+text), activeGraphId}` 到 `<dataDir>/recall-instances.jsonl`；离线 judge 独立于回答标记相关性 | 默认开启／本地推进中 |
| Controller shadow evaluation | `NMG_CONTROLLER_SHADOW` | OFF | `"1"` 开启；写 shadow events JSONL 与旧 `shadow_feedback_nudge`，供 QPP／rerank 数据集使用 | opt-in／休眠；router 已由 online learning 取代 |
| Shadow collection-origin tag | `NMG_SHADOW_COLLECTION_ORIGIN` | `natural` | `natural`／`controlled`，标记 shadow event 来源 | opt-in |
| Controller runtime-state file | `NMG_CONTROLLER_RUNTIME_STATE` | 自动路径 | learned controller state 文件路径 | opt-in |
| Controller activation-receipt file | `NMG_CONTROLLER_ACTIVATION_RECEIPT` | 未设置 | activation receipt 文件路径 | opt-in |
| QPP1 learned fold | `NMG_QPP1_MODE` | `off` | `off`／`shadow`／`active` | opt-in／休眠 |
| QPP2 second-pass fold | `NMG_QPP2_MODE` | `off` | `off`／`shadow`／`active` | opt-in／休眠 |
| Controller (DC) runtime rerank | `NMG_CONTROLLER_RUNTIME_MODE` | `off` | `off`／`shadow`／`controlled`／`active` | opt-in／休眠 |
| Search-recommendation nudge | `NMG_SEARCH_RECOMMENDATION` | `off` | `off`／`advisory`／`guardrail` | opt-in |
| Lab tools | `NMG_ENABLE_LAB_TOOLS` | `off` | `"1"` 开启 reasoning workspace、memory-graph reasoner、controller shadow；也影响 dsh `dsh-nmg` | opt-in |
| Autodiff graph compile | `NMG_AUTODIFF_COMPILE` | `off` | 将 autodiff graphs 编译为 JS 以提高速度 | opt-in／性能 knob |
| Auto-recall tuning knobs | `NMG_AUTO_RECALL_TIER` (1)、`NMG_AUTO_RECALL_LIMIT` (13)、`NMG_AUTO_RECALL_INITIAL_TARGET` (13)、`NMG_AUTO_RECALL_STRONG_HIT_TOP_GAP` (0.05)、`NMG_AUTO_RECALL_STRONG_HIT_INITIAL_TARGET` (3) | 如列值 | 调节默认开启的 auto-recall | 默认开启功能的 knobs |
| Board wake cadence | `NMG_BOARD_WAKE_INTERVAL_SEC` | 未设置 | board coordination loop 的唤醒间隔 | knob |
| Daemon idle timeout | `NMG_DAEMON_IDLE_TIMEOUT_MS` | 未设置 | daemon 空闲关闭时间 | knob |
| Session-only recall cue pilot | Lab 租约 `recall_gate` | OFF | 被跳过入口的字面提词；种子与学到的词共用一个按不同用户回合驱动的分段 LRU；有界事件环；不持久化，也不做真值／相关性反馈 | 实验性；仅受控机制，无自然质量／成本证据；[检索与生命周期契约](../design/progressive-retrieval.zh-CN.md#渐进检索) |
| Controlled daemon code reload | 显式 `nmg daemon reload`；owner 能力 `controlled-reload`；内部 `daemon run --reload-ticket` | OFF（仅操作员动作） | 独占交接、排空已接受调用、持票替代、持久数据保留、易失 AG／租约清空；缺少能力与孤儿门禁 fail closed | 隔离契约测试；没有自动生产替换 |
| Agent identity／capabilities | `NMG_AGENT_ID`、`NMG_AGENT_CAPABILITIES`、`NMG_AGENT_ONLINE_MS`、`DSH_SESSION_ID` | 自动 | board／agent 注册身份 | 配置 |
| Paths | `NMG_DATA_DIR`、`NMG_PROJECT_DIR`、`HOME`、`USERPROFILE` | 依环境 | data／project 目录 | 配置 |
| Model selection | `NMG_EMBED_MODEL`、`NMG_SUMMARY_MODEL`、`NMG_JUDGE_MODEL`、`EVAL_MODEL`、`ANSWER_MODEL` | provider 默认值 | 选择 embedding、summarizer、judge、eval、answer 模型 | 配置 |
| Retrieval backend mode（RPC 参数，非 env） | `retrievalMode` | `legacy` | `legacy`／`fts5`／`hashing`／`qwen3`／`hybrid` | 配置／knob |
| Online recall feedback affordance（all recalls） | 无新增 gate；沿用 online-learning 默认值 | ON | 每次 recall 输出携带含 activeGraphId 的简短评分邀请；调用者提交 `nmg_remember action=feedback`，daemon 仅训练指定 graph；Pi 与 dsh 均接入 | 已实现（2026-09-07）；机械 end-of-turn labeler 仍是可选后续 |
| Benchmark venv directory | `NMG_BENCH_VENV`、`NMG_HALUMEM_PYTHON` | `bge-venv` | `.benchmarks/` 下的共享 Python 3.13 benchmark venv；缺失时 runner 发出警告，不静默回退到 PATH 中的 Python | 已实现（2026-09-11）；benchmark harness |
| Pi first-output timing observer | `/nmg-latency on\|off\|status` | OFF；会话替换／分支导航／reload 时重置 | host-event observer；无 probe request，不改变等待策略；加载本身不会启用采集 | opt-in；[lifecycle contract](../session-memory-lifecycle-hooks-2026-08-10.zh-CN.md) |

## 仓库文档试点

| 功能 | Gate／选项 | 默认值 | 含义 | 状态／owner |
|---|---|---|---|---|
| Scoped terminology discovery | `glossary:check --resolve <name> --within <directory> --namespace <namespace>` | 聚合注册语料；无 namespace filter | 限定目录查找、不声称全局缺失；支持 namespace 消歧；歧义时返回候选；旧 pointer index 仍运行 | [文档治理](../documentation-governance.zh-CN.md)；仅仓库工具，不改变 runtime memory 或在线 provider |
| Structural document hygiene | `docs:check`；CI contract 显式指定语料 | 仅对试点文件开启 | 检查 ATX 标题／章节非空与兄弟标题唯一；不评价文风，也不是全局长度规则 | 有界试点；不自动扩展 |

## Explicit research probes

完整职责见[显式研究探针](feature-register/explicit-research-probes.zh-CN.md)。

## 共享展示选项

| 功能 | Gate／选项 | 默认值 | 含义 | 状态／owner |
|---|---|---|---|---|
| Long Task Board convention text | `TaskBoardSurfaceOptions.includeConventions=true` | OFF | library caller 显式请求较长的展示约定；普通 tool result 保留 entry identity 与协调状态，不重复注入约定 | 已实现的展示选项；不新增 tool 或 runtime capability；[共享信息输出决策](../../decisions/implemented/2026-10-07-shared-information-output.zh-CN.md) |
