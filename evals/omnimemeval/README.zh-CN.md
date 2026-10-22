# OmniMemEval 集成

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

OmniMemEval 是 NMG 首选的公共用户记忆 benchmark 上游 harness。它已通过一套共享生命周期运行 LongMemEval、LoCoMo、BEAM、PersonaMem v2 与 HaluMem：

```text
benchmark data
  -> add(messages, user_id)
  -> memory backend
  -> search(query, user_id, top_k)
  -> answer model
  -> official/dataset scorer
  -> report
```

## 目录布局

本目录中的文件按职责切分：

- 根目录文件是受维护的 benchmark 边界：runner、配置、适配器桥／客户端、embedding 缓存／服务、judge provider 与操作辅助脚本；
- [`research/`](research/README.zh-CN.md) 存放一次性审计、探针、消融与极性实验。这些文件是证据工具，不是另一套 benchmark runner。

这一分离使 `npm run benchmark:omni -- <suite>` 保持为唯一的公开执行路径，同时保留过往调查的可复现性。

## Benchmark venv

一个 venv 服务所有 suite 与 embedding 服务器：`.benchmarks/bge-venv`
（Python 3.13，`torch 2.13.0+cu126`）。它不由任何仓库脚本构建，因此本文是它包含什么的唯一记录——不读这段就不要删它。

```powershell
uv venv .benchmarks/bge-venv --python 3.13
uv pip install --python .benchmarks/bge-venv/Scripts/python.exe `
  -r .benchmarks/official/OmniMemEval/requirements_user_memory.txt
```

`requirements_agentbench.txt`（BEAM）会从 git 额外安装 `swebench`、`pyserini`、`faiss-cpu`
与 `tevatron`；只在需要那些 suite 时才安装它。

两个 requirements 文件都把 `torch` 与 `torchvision` 列为**未锁版本**。因此一次普通的
`-r` 安装可能把 CUDA 构建替换成默认 PyPI 构建，从而静默丢掉 GPU 加速，所以不要让它们进 `-r`，而应从 CUDA 索引安装 torch。

`benchmark:omni` 保留继承的可执行文件搜索路径，将 Windows `Path`／`PATH` 规范为一个键，并把该 venv 前置（`NMG_BENCH_VENV` 覆盖目录名）。`eval:halumem:score` 默认使用该 venv 的 `python.exe`，并接受 `--python` 或
`NMG_HALUMEM_PYTHON`。

## 反向检索召回探针

`research/ablations/reverse-retrieval-ablation.py` 比较等规模的会话级 Top-K 输出：纯向量检索、Top-1 反向查找后接 QPP2、QPP2 派生的反向查找后接 QPP2，以及它们的并集。
这是一个离线机制探针：证据标签只用于评分，不调用任何答案模型或 judge。报告还测量可配置结果截断点（默认 20/25/30/40）上的累积召回，并记录每个金标会话的名次。这模拟检索式延续：第一页可以保持紧凑，而被折叠的候选仍可通过 `expand` 获取，而不是被当作已删除的证据。

该探针嵌入整段 LongMemEval 会话，而 NMG benchmark 通过其图与层级检索记忆记录。因此它的绝对召回不是 NMG 分数；只有四条臂之间的配对差异有意义。
RRF 与反向检索是有用的候选生成与融合策略，不是 benchmark 专属的答案逻辑。产品采纳仍要求在正常 Agent 面上有一个共享、有界的实现与匹配证据。
生产集成使用既有的 Fibonacci/QPP 窗口，而不是强制 Top-20。调用方的 `top_k` 是正常预算，而窗口从 Top-1 开始。`forget` 这类结构化控制标记在检索之后被投影进 LLM 指令，因此不施加最小窗口尺寸。

```powershell
.benchmarks\bge-venv\Scripts\python.exe `
  evals\omnimemeval\research\ablations\reverse-retrieval-ablation.py `
  --data .benchmarks\official\OmniMemEval\data\longmemeval\longmemeval_s_cleaned.json `
  --output .benchmarks\results\reverse-retrieval-temporal-full.json `
  --category temporal-reasoning
```

用 `--page-cutoffs 20 25 30 40` 改变累积展开点。

### 时间答案探针（2026-08-02）

133 个 temporal-reasoning 问题用 OmniMemEval 官方 LongMemEval prompt 与 DeepSeek v4 Flash 作答并评判。由于检索探针以整段会话为排序单位，答案上下文保留带时间戳的用户轮次并排除冗长的 assistant 轮次。这是配对的机制探针，不是记录级 NMG 排行榜配置。

| 臂 | 正确 | 准确率 | 平均上下文字符 |
| --- | ---: | ---: | ---: |
| 原始查询 Top-20 | 108/133 | 81.20% | 29,868 |
| 遗留 Top1+QPP2 反向 Top-20 | 107/133 | 80.45% | 30,317 |
| 加权 RRF 三路 Top-20 | **111/133** | **83.46%** | 30,223 |
| 加权 RRF 三路 Top-25 | 110/133 | 82.71% | 37,079 |

Top-25 臂对原始路线是 10 次配对胜、8 次负（双侧精确二项 `p=0.815`），所以这两题的净增不构成答案质量改进的证据。它确实证明了渐进结果可以在不把证据塞进第一页的情况下恢复检索证据。已知的博物馆桥接案例在其缺失的一月会话移到第 24 名后仍然失败：reader 没有从「没有同伴提及」这一缺失推断出「不是和朋友一起」。那个残余失败属于 reader／benchmark 推断，而不是检索丢失。

加入匹配的 Top-20 RRF 臂是为了把融合质量与更大的 reader 上下文分开。它对原始 Top-20 取得 9 次配对胜、6 次负（双侧精确二项 `p=0.607`）。其 3 题净增是方向性的、不具统计显著性，但它在点准确率上优于 Top-25，同时少用 18.5% 的上下文字符。Top-20 与 Top-25 互相比为 11/10 胜/负，进一步显示 reader／judge 噪声可观；多出的 5 条记录应保持为按需延续，而不是强制上下文。

可复现的 runner 是 `research/ablations/reverse-retrieval-answer-eval.py`；它消费保存下来的旧排序与加权 RRF 排序工件，并把结果文件写到
`.benchmarks/results/` 下。

### 渐进展开答案探针（2026-08-02）

官方 LongMemEval 的答案与 judge 阶段在全部 133 个时间问题上、用合并后的反向检索排序运行。配对臂分别暴露前 20 个会话或继续到 25。两者都使用 temperature 为零的 DeepSeek v4 Flash 与 64 个 worker。在两臂都成功评判的 123 个问题上，Top-20 得 78.05%，Top-25 得 76.42%（8 胜、10 负；双侧符号检验 p=0.815）。平均渲染上下文从 234k 字符增至 288k 字符，因为这个诊断嵌入并渲染整段会话，而不是 NMG 记忆记录。

展开在 6 个问题上恢复了一条新标注的会话，但只有其中 1 个答案从错误变为正确。特别是，问题
`0bc8ad93` 在第 24 名恢复了它的一月桥接会话，而 reader 仍然偏好十月那次与朋友的博物馆之行。因此渐进披露改善了证据可达性，但无条件展开不是答案质量的改进，也不能替代证据组合。生产必须把展开留给 Agent／QPP，而不是每次查询都注入下一页。

`research/ablations/materialize-pagination-arm.py` 把一个离线排序臂转换成官方 search 工件格式，使答案阶段比较可以复用上游 response 与 judge 脚本而不修改 OmniMemEval。

## 集成边界

NMG 应在 OmniMemEval 的 `scripts/client_factory` 注册表里贡献一个薄的 Python 客户端。该客户端是适配器，不是第二份 NMG 实现。它转发：

- `add(...)` 到会话／历史摄取与记忆抽取；
- `search(...)` 到有预算的 NMG 召回，并返回纯文本上下文；
- 清理到删除该 benchmark 用户的隔离 namespace。

适配器调用本地 NMG 桥或已部署的 AML Add/Search 边界。它不得伸进 SQLite 表、在 Python 里复制图逻辑，或把 benchmark 语义变成 NMG core 的一部分。

对用户记忆问题，本地桥默认请求归因于用户的证据，以免冗长未经核验的 assistant 回复挤掉用户历史。明确询问 assistant 或先前对话的查询会使用两个 actor，保留 LongMemEval 的 assistant-memory 类别。这使用通用
`SearchOptions.sourceActor` 边界而不是 SQL 访问。这种感知 actor 的选择是适配器声明的检索画像，不是 OmniMemEval 的答案或 judge prompt。官方 benchmark prompt 仍归上游所有，并按原样运行以获得可比的答案阶段结果。

默认传输方式是持久 NDJSON 子进程。测试已部署的 AML 服务时，在所选 benchmark 环境中设置：

```text
NMG_OMNI_API_URL=https://your-memory-service.example
NMG_OMNI_API_NAMESPACE=omni-your-unique-experiment
# NMG_OMNI_API_TOKEN 经进程环境提供，不写入已跟踪文件。
```

HTTP 模式不启动本地桥，也不探测本地 embedding provider；抽取、检索和 embedding 就绪状态由已部署服务负责。客户端为每个 benchmark `user_id` 添加显式 namespace 前缀。独立实验使用新 namespace，续跑保留原值。Add 使用内容派生的 `request_id`，要求同步 HTTP 200 和身份字段精确回显；Search 按原排序保留不超过 `top_k` 的文本记忆。客户端标识为 `NodeMemoryGraph-OmniMemEval/0.1`，除回环测试外必须使用 HTTPS，并拒绝重定向，避免凭据跨源。

时间展示使用共享的 [NMG 读取边界策略](../../docs/design/design/progressive-retrieval.zh-CN.md#时间证据展示)，而不是套件专属检测。Add 原样转发消息的 `chat_time`／`timestamp`，并把它们纳入原有请求身份。云端导入把经过校验的来源／会话时间映射为原始话语的 `eventTime`，不论该文本是否需要展示日期；缺失的来源时间保持未知。

服务端适配器可以对已排序记录调用 [`projectAmlMemory`](../../src/integration/aml-projection.ts)。返回行保留 `id`、分数、历史 `event_time`、实际写入时间 `stored_at` 和未渲染的 `raw_content`（保留撤回保护），`content` 应用共享展示策略。为兼容既有 NMG AML 服务，可选的 `created_at` 仍是历史时间别名，而不是存储创建时间。Python 原样保留返回候选，并用 `event_time` 渲染纯文本；只有缺少 `event_time` 字段时才使用旧 `created_at` 别名，显式 null 表示未知。已经渲染的前缀不重复添加。安装器把产品层 JSON 策略复制到 `nmg_client.py` 旁，只复制 Python 文件不够。原生富 Agent Surface 渲染不变。

### 多模态 Add/Search（云端服务）

已部署的 [onlion 服务](../../onlion/README.md) 在 Add 消息与 Search 查询中接受有序 `text`/`image_url` parts。仅接受内联 Base64 data URL（JPEG/PNG/WebP/GIF），单图、单条内容与单请求均有上限。检索视图由随附描述文字加不透明的单图 SHA-256 引用构成：不要求、也不会调用任何图片描述模型，也没有多模态向量。Search 在 `content` 返回原始有序 parts；`raw_content` 是原始证据 JSON；归因跟随消息角色，结构化内容标记携带格式、来源角色与内容哈希。服务响应包含超出 AML 必填范围的字段，且多模态 `content` 可能携带条件式时间前缀——这是[所属决策记录](../../docs/decisions/implemented/2026-10-22-onlion-aml-cloud-service.zh-CN.md)中登记的有意展示偏差。

HTTP 与连接失败抛出兼容 `RuntimeError` 的 `NmgRemoteError`。其 `diagnostic` 对象包含在异常文本中，使上游错误日志保留请求关联字段、UTC 时间、耗时、HTTP 状态与解码后的响应体（最多 16 KiB，并标记截断）。有效 JSON 保留其中的 `error.code`；文本／HTML 响应和传输失败不虚构 API 错误码。响应头白名单包含 `Content-Type`、`Retry-After`、`CF-Ray`、`Server`、`Date`、请求／关联标识和 `Traceparent`。当前服务 token 在全部采集字段中脱敏；诊断上下文不额外加入请求 messages/query 或白名单外响应头。取证不增加重试，也不把失败改为成功。未保留响应体的历史错误仍无法归因；后续回放属于另一份证据。

HTTP 模式拒绝删除和操作级 `add_with_result`，因为 AML 回执不提供实际物化的记忆记录。使用非 streaming 的 Add/Search 套件并设置 `--clear 0`；本传输方式不支持 HaluMem 操作评分及带删除的 streaming 生命周期。后续远程数据回收是另行授权的操作。两种模式的回答／评分设置、prompt 和评分逻辑仍归上游所有。

把共享适配器安装进锁定的忽略检出目录：

```powershell
npm run benchmark:setup
npm run benchmark:install:omni-adapter
$env:NMG_ROOT = (Get-Location).Path
```

然后在 OmniMemEval 的用户记忆命令里使用 `--lib nmg`。OmniMemEval 声明自己的 Python 3.12 环境；NMG 那个更小的 Python 3.11 官方评分环境被有意不复用。

对普通 NMG 运行，不要分开调用那些命令。用那一个跨 suite 入口。它从
`evals/omnimemeval/benchmark.config.json` 读稳定参数、固定 `--lib nmg`、确立 UTF-8、生成运行身份，并在委派前校验续跑：

```powershell
npm run benchmark:omni -- <longmemeval|locomo|beam|personamem-v2|halumem>
```

通用的与数据集专属的官方 flag 属于配置文件。复制出来的配置可用 `--config` 选择；确切的结果目录可用 `--resume` 续跑。在开始、续跑或特化一次运行时，见
`.pi/skills/omnimemeval-eval/SKILL.md`。

默认答案池是 32 个 worker。启动器把配置的
`--llm-workers` 值同步到 OmniMemEval 的共享自适应客户端上限，因此公开的 worker 设置不会被第二个默认值静默封顶。在官方 DeepSeek 端点上，LongMemEval 与 LoCoMo 还会在答案批次之前发一次尽力而为的单 token 前缀预热。它们稳定的 prompt 前缀约占平均输入 token 的 10.5% 与 12.9%。设
`ANSWER_PREFIX_WARMUP=0` 可禁用它。真实答案 prompt 保持不变，报告在 provider 返回时记录 DeepSeek 的顶层缓存命中与未命中 token 数。

PersonaMem v2 是 prompt 顺序会造成巨大可避免影响的例外。它的上游 prompt 把检索上下文放在 176 token 的固定指令之前，因此受维护的 NMG 画像显式传入
`--prompt-layout static-first`。上游 runner 仍默认 `official`；该替代只把那些固定指令移到上下文之前，保留同样的文本、问题、选项与输出契约。在一次均匀抽样的 500 题匹配探针上（直连 DeepSeek、temperature 为零、关闭 thinking、`max_tokens=24`、32 个 worker），官方布局得到 0% 报告的缓存命中、33.70 请求/秒、1240 ms P95 与 28.8% 答案准确率。static-first 得到 10.11% 缓存命中、44.83 请求/秒、1090 ms P95 与 28.0% 准确率；配对选择在 448/500 题上一致（22 题仅官方布局正确，18 题仅 static-first 正确）。这是执行画像优化，不是官方 prompt 顺序的排行榜行；有意改变画像会使对旧 PersonaMem 结果目录的续跑失效。

安装器还会把 NMG 注册进 OmniMemEval 的通用文本检索派发器、LoCoMo 的 benchmark 本地检索派发器以及 conversation-ID 辅助函数。OmniMemEval 目前把这些 allowlist 与它的中央客户端注册表分开保存，所以只复制 `nmg_client.py` 是不够的。
## 当前官方 smoke 结果

### LongMemEval

一次七会话流式 smoke（`nmg_smoke7_fix_20260728`，会话索引 0--6）跑通了 OmniMemEval 官方的 add/search/delete 生命周期，然后用 `deepseek-chat`（`deepseek-v4-flash`，temperature 0）同时做答案生成与评判。一份匹配的无记忆工件保留了同样的七个问题与 prompt，但清空全部检索上下文。

| 臂 | LLM-as-Judge | 每题上下文 token | 检索 均值 / P95 |
| --- | ---: | ---: | ---: |
| NMG，K=20 | **0.8571**（6/7） | 1,150 | 152 / 160 ms |
| 无记忆 | 0.0000（0/7） | 270 | 0 / 0 ms |

七个 NMG 单元全部完成摄取、检索、清理、作答与评判，无失败。更早那次运行漏掉 `Target` 与 `Serenity
Yoga`，因为检索施加了逐节点证据上限。检索现在只用共享 Active Graph 预算：来自一个节点的记录与其他节点的记录按相关性、token 成本与剩余预算竞争。这恢复了 `Serenity Yoga`。`Target` 仍是一次弱 reader 组合失败，即使两条同会话线索都在返回的上下文里。这个样本是管线 smoke，不是具统计意义的 benchmark 结果。

### LongMemEval 完整结果

一次全新的完整流式运行（`nmg_lme500_fixed_20260728`）为全部 500 个 LongMemEval 会话完成了官方 add/search/delete 生命周期。匹配基线（`no_memory_lme500_fixed_20260728`）保留同样的问题、金标答案、reader、judge 与 prompt，只移除检索上下文。两臂都用 temperature 0 的 `deepseek-chat`（当前为 `deepseek-v4-flash`）与 `top_k=20`。

| 臂 | LLM-as-Judge | F1 | METEOR | 每题答案 prompt token | 检索 均值 / P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| NMG | **0.6404**（317/495） | 0.1544 | 0.2124 | 1,138 | 156 / 175 ms |
| 无记忆 | 0.0646（32/495） | 0.0853 | 0.0904 | 278 | 0 / 0 ms |

NMG 的绝对增益是 **+57.6 个 judge 点**。两臂的检索与答案阶段都完成 500/500。官方 judge 在每臂各接受 495/500 个输出；每臂各有五个输出经 OmniMemEval 记录的 `--skip-failed-judge 1` 路径跳过，因为 DeepSeek 返回了一个同时含 `label` 与 `explanation` 的 JSON 对象，而上游严格解析器只接受它那个窄标签格式。被跳过的问题集合不同。在两臂都成功评判的 490 个问题上，NMG 得 0.6408（314/490），无记忆得 0.0653（32/490），所以匹配子集上的结果不变。

| 共同 490 题上的类别 | NMG | 无记忆 | 题数 |
| --- | ---: | ---: | ---: |
| 单会话用户 | **0.9714** | 0.0857 | 70 |
| 时间推理 | **0.7519** | 0.0620 | 129 |
| 知识更新 | **0.7692** | 0.0769 | 78 |
| 多会话 | **0.5227** | 0.0909 | 132 |
| 单会话 assistant | **0.2857** | 0.0000 | 56 |
| 单会话偏好 | **0.1600** | 0.0000 | 25 |

结果显示在固定弱 reader 下有巨大的端到端记忆收益，但也指出了下一步质量目标：assistant 记忆、偏好与多会话证据组合。相对无记忆平均多出的 860 个 prompt token 就是大致的检索上下文成本。

辅助的精确文本证据审计让这个诊断更具体。在 479 个带标注证据的问题中，NMG 为 79.96% 的问题检索到至少一条证据轮次，为 62.63% 的问题检索到全部证据轮次，整体覆盖 69.42% 的标注轮次。用户证据召回为 72.92%，而 assistant 证据召回只有 14.81%。当全部标注证据都在时，答案准确率为 89.67%；只有部分证据时降到 16.67%，没有任何精确证据时降到
7.45%。这强烈指向检索覆盖与多记录组合、而不是 reader 容量本身，是剩余的主要瓶颈。该审计有意严格，不是官方 LongMemEval 分数。

assistant 类别随后被隔离成一次 56 题诊断。把高置信 assistant 召回线索从字面的 `assistant`、
`you said`、`previous chat` 扩展到 `you
recommended`、`your answer`、`previous conversation` 这类普通指称后，为 46/56 个问题（82.14%）检索到精确证据：assistant 证据召回从整轮运行的 14.81% 升到该隔离类别的 43/51（84.31%）。用同样的 DeepSeek reader 与官方 judge，准确率从 16/56（28.57%）升到
48/56（85.71%）。该线索在 55/56 个 assistant 类别问题上触发，而在其余 444 个 LongMemEval 问题上一次都没触发。

另一项实验把每条 assistant 回复与其前一条用户 prompt 一起嵌入。它达到 47/56 的精确命中，但 assistant 证据召回仍为 43/51，同时平均上下文从 6,792 增至 7,503 字符、平均检索延迟从 172 增至 191 ms。因此这种配对表示被拒绝。NMG 保留原始轮次级证据与 actor 元数据。查询意图线索选择 actor 检索范围；它们不改写证据。

30 题的偏好类别暴露了一个单独的阶段二失败。词法检索只召回 31.82% 的标注证据。记录级
`BAAI/bge-small-en-v1.5` embedding 把精确证据召回提到 86.36%，93.33% 的问题至少有一条标注轮次、83.33% 的问题有全部标注轮次。然而弱 reader 常常拒绝把检索到的偏好应用到新请求，因为所请求的推荐没有在历史里逐字出现。现在一条简短的检索 header 告诉 reader：把检索到的事实、偏好、约束、工具与经验当作个性化的证据，而不要编造用户细节。

在同一批已存上下文上做的三次匹配答案加评判运行，无该 header 时平均 40.2% 准确率，有它时 53.3%，稳定增益约 13.1 点。该 header 每题增加约 278 个上下文字符。一条明确要求给出可执行推荐的更长指令没有改善结果，被拒绝。泛化问题（例如请求广泛相关的刊物或会议）上的剩余失误，指向一种与查询无关的、合并后的偏好／画像表示；它们不支持更多 benchmark 专属的 prompt 规则。

记录级 BGE 路径随后在完整 500 题 LongMemEval 集上评估（`nmg_lme500_bge_merged_20260728`）。500 次检索与答案调用全部成功；官方 judge 接受 491 个答案。它得 **0.7963**
（391/491），词法 F1 0.1754、METEOR 0.2456。严格证据审计发现 94.15% 的问题至少有一条标注轮次、81.63% 有全部标注轮次，全部标注轮次上的召回为 87.28%。assistant 与用户证据召回分别为 85.19% 与 87.41%。

在 BGE、词法 NMG 与无记忆三次运行都成功评判的 482 个问题上，分数为：

| 共同 482 题上的臂 | 准确率 | 正确数 |
| --- | ---: | ---: |
| NMG + 记录 BGE | **0.8008** | 386 |
| NMG 词法/FTS | 0.6473 | 312 |
| 无记忆 | 0.0664 | 32 |

BGE 对词法 NMG 产生 96 胜、22 负、364 平，净增 74 题。对无记忆产生 356 胜、2 负、124 平。增益与证据完整性同步：BGE 在全部标注证据齐备的问题上正确率 88.80%，部分证据时 36.05%，完全没有时 25.00%。

这个质量结果尚未满足延迟目标。整轮检索延迟为均值 12.91 秒、P50 13.13 秒、P95 14.28 秒，而词法运行约为均值／P95 156/175 ms。BGE 运行在每个隔离用户的首次查询时构建其记录索引，所以这些数字主要测量冷启动的逐用户 embedding 构建，而不是热态 ANN 查找。答案 prompt 平均每题 1,114 个报告 token。未来的性能工作必须分别报告冷索引与热检索，并且不得牺牲已测量的证据召回增益。

### 当前代码 BGE 完整重跑（2026-08-01）

当前代码在全部 500 个 LongMemEval 问题上重跑为
`nmg_bge_full_current_merged_20260801`，配一个匹配的
`no_memory_bge_full_current_20260801` 臂。两臂都使用 `deepseek-v4-flash`、temperature 0 以及同样的官方 prompt 与问题集。NMG 使用 `BAAI/bge-small-en-v1.5`、`bge-en` 预处理画像、记录 embedding、`top_k=20` 与默认关闭 QPP 的检索路径。流式检索被切成互不重叠的索引区间，并用受检的分片合并器合并，从而证明全部 500 个索引各出现过一次。

| 臂 | 官方 judge | F1 | METEOR | 检索 均值 / P50 / P95 |
| --- | ---: | ---: | ---: | ---: |
| 当前 NMG + BGE | **0.6278**（312/497） | 0.1675 | 0.2322 | 7.81s / 9.10s / 10.32s |
| 匹配无记忆 | 0.0607（30/494） | 0.0961 | 0.1081 | 0 / 0 / 0 ms |

在两臂都成功评判的 491 个问题上，当前 NMG 得 0.6293（309/491），无记忆得 0.0611（30/491）：绝对增益 56.82 点。NMG 独有地正确回答 280 个问题；基线独有地正确回答一个。全部 500 次检索与全部 500 次答案调用完成。上游严格解析器跳过了三个 NMG 与六个基线 judge 响应。三个被跳过的 NMG judge 载荷都明确包含 `WRONG`，因此保守的 500 题全算 NMG 分数为 0.6240。

严格证据审计报告 83.30% 的标注问题至少有一条证据轮次、51.36% 有全部证据轮次、全部标注轮次上的召回 60.94%。这相对 2026-07-28 的 BGE 运行（94.15%、81.63% 与 87.28%）是真实回退。平均返回上下文也从 3,615 字符降到 1,383 字符。最大的配对 judge 回退是多会话（130 个共同问题上从 98 降到 54 正确）与时间推理（133 个上从 104 降到 75）。因此更短的上下文移除的是有用的多记录证据，而不只是噪声。不要把旧的 0.7963 结果当作当前性能；在共享 Active Graph 预算下恢复证据组合是下一个检索质量门禁。

一次受控的全池重跑随后定位了那道门禁。OmniMemEval 把原始对话证据存在 L2，而共享的 `maxTierBudget` 默认只准入三条 L2/L3 记录，不论 `top_k=20` 还是 `50`。把 benchmark 的总节点预算与冷证据预算对齐到 `top_k=20` 之后，全部 500 次检索成功，严格证据召回恢复到 **87.95%**：94.15% 的标注问题至少包含一条证据轮次，82.67% 包含全部标注轮次。平均上下文增至 3,719 字符。这与 2026-07-28 的检索结果（87.28% / 81.63% / 3,615 字符）持平并略有超出，证实那次回退是预算截断而不是 embedding 或 ANN 质量。面向 Agent 的 L1 检索现在只排序一次并呈现两半；benchmark 显式禁用那一层呈现折叠，因为它测量的是完整检索召回上限，而不是某个 agent 决定展开的行为。

同样的 500 份已存上下文随后用配置的 DeepSeek 答案模型作答、用官方 LongMemEval prompt 评判。全部 500 次答案调用成功。官方解析器接受 499 个 judge 响应并判定
413 个正确，准确率 **0.8277**。剩下那个响应明确写了
`"label": "WRONG"`，但同时带一个上游严格正则拒绝的 `reason` 字段；保守地把它算错则得 **0.8260**（413/500）。这比被截断的当前代码运行（0.6278）高 19.99 点，比 2026-07-28 的全池运行（0.7963）高 3.14 点。答案生成在 500 次调用中共报告 567,656 个 prompt token 与 49,473 个 completion token。最终检查点修复时关闭了语义 NLP 指标，因为上游评估器为每个条目构建一次 BERTScore 权重；这不影响 LLM-as-a-Judge 准确率。

整轮运行使用了持久 embedding 缓存。冷态端到端检索包含逐用户 GPU embedding 构建；NMG core 侧车报告图／检索工作本身的 P50 25.63 ms、P95 59.70 ms、P99 66.26 ms。一次独立的同语料热态检查显示返回上下文完全相同，同时在该 Windows 主机上把端到端检索从 44.73 秒降到 260.09 ms。

NMG 桥把它既有的 `PerfTimer` 快照保存在
`.benchmarks/omnimemeval-nmg/search-perf.jsonl`。该侧车在官方流式 runner 删除逐用户数据库后仍存在。官方
`search_duration_ms` 仍是冷态端到端测量；侧车独立报告热态核心各阶段。用以下命令汇总所有行，或把报告限制到某个 benchmark 版本的用户 ID 前缀：

```powershell
npm run benchmark:report:omni-perf -- `
  .benchmarks/omnimemeval-nmg/search-perf.jsonl `
  lme_exper_user_nmg_lme500_bge_20260728_
```

报告包含总核心检索与每个已记录阶段的最接近秩 P50、P95 与 P99。大规模比较应使用版本前缀，以免把无关运行混在一起。

配置了外部 embedding provider 时，文档与查询向量按 embedding 索引身份、输入种类与文本哈希缓存在**共享**缓存 `.benchmarks/shared-embedding-cache.sqlite` 里——所有 eval 共用一个缓存，而不是每个 eval 目录一个。该缓存独立于一次性的 benchmark 用户数据库，所以重复语料与查询可跨用户、跨运行复用向量。改变模型或预处理契约会改变索引身份，无法复用不兼容的向量。

**边界——不要新建逐 eval 的 embedding 缓存。** 合并之前，5 个缓存持有 906k 行，其中 248k（27%）是各 eval 变体之间的重复（bge-union-k20 与主运行 96% 冗余）。`bridge.ts`
默认使用共享缓存；探针／审计脚本已改指向它。只有真正需要隔离（不同模型或预处理）时才新建独立缓存，之后用
`evals/omnimemeval/merge-embedding-caches.mjs` 合并回去。旧的逐 eval 缓存文件
（每个 eval 目录里的 `embedding-cache.sqlite`）在合并后即作废。

在该 Windows 评估主机上，离线 BGE 服务器从既有的
`uv` 脚本环境运行。把 CUDA PyTorch wheel 装进那个环境后，30 题检索运行从 CPU 上每题大约 50--75 秒降到索引期间每题约四秒。这只是本地评估加速：GPU PyTorch 与 `uv` 都不是 NMG 运行时依赖。

用以下命令复现该诊断：

```powershell
npm run benchmark:audit:longmem -- `
  .benchmarks/official/OmniMemEval/results/lme/nmg-nmg_lme500_bge_merged_20260728/nmg_lme_search_results.json `
  .benchmarks/official/OmniMemEval/results/lme/nmg-nmg_lme500_bge_merged_20260728/nmg_lme_judged.json
```

第一次完整尝试无效：在 Windows 上 Python 到 Node 的 NDJSON 适配器遇到非 ASCII 语料内容后，446 个会话被标为 `skipped`。NMG 适配器现在输出 ASCII 转义的 JSON，既保留 Unicode 内容又让管道可移植。新运行有 500 条 `success` 检索记录、零检索错误、零空上下文。绝不要比较或评分那个无效的 `nmg_lme500_20260728` 工件。

第一次基线尝试暴露了一个 harness 缺陷：transform 清空了 LoCoMo 的 `context` 字段却保留了 LongMemEval 的 `search_context`。
`prepare-no-memory.ts` 现在清空两种 schema 并重置两个时长字段；一个回归测试保护该匹配基线不变量。

### PersonaMem v2

第一次完整的 PersonaMem v2 运行使用记录级
`BAAI/bge-small-en-v1.5` 检索，完成 200/200 个 persona 与
5,000/5,000 个问题，无检索或答案失败。用固定的
DeepSeek v4 Flash reader，它总体得 **34.44%**：

| 类别 | 准确率 |
| --- | ---: |
| 敏感偏好 | 28.57% |
| 要求遗忘 | 12.88% |
| 健康／医疗 | 43.84% |
| 中性 | 39.98% |
| 治疗 | 36.68% |
| 反刻板偏好 | 41.40% |
| 刻板偏好 | 49.72% |

偏低的 `ask_to_forget` 分数暴露的是语义错误而非容量问题。删除活动偏好移除了陈旧证据，但也移除了「存在一条撤回边界」这一事实。它只把 1,048 题的该类别提到 **14.12%**。NMG 现在把逻辑遗忘表示为带类型、可扩展的控制元数据，同时让可检索陈述保持干净：

```json
{
  "statement": "the revoked fact or preference",
  "markers": [{ "kind": "forget", "attributes": { "effect": "revoke" } }]
}
```

原始活动记忆被软删除，不可变来源历史仍可审计，benchmark 适配器只在模型输入边界把标记渲染为
`[forget] statement`。检索指引告诉 reader 这不是活动事实，不得被重建或使用。物理删除仍是一项独立的必要操作，用于隐私擦除；逻辑标记不是删除用户数据的替代品。标记载体有意开放，因此未来集成可以加 `sensitive`、
`pinned`、`exception` 或 `disputed`，而不改变事实陈述或数据库 schema。

两次匹配诊断验证了这种表示：

| `ask_to_forget` 臂 | 准确率 | 相对仅删除的差 | 检索路径 |
| --- | ---: | ---: | --- |
| 仅删除 | 14.12% | -- | 记录 BGE |
| NMG `[forget]`，真实端到端 | **18.70%** | +4.58 | 记录 BGE |
| NMG `[forget]`，最近标签消融 | **20.52%** | +6.40 | BGE 最近撤回 |

完整的记录 BGE 运行完成全部 200 个 persona 生命周期、5,000 次检索与 5,000 次答案，无失败。在 `ask_to_forget` 上，它对仅删除产生 96 次答案胜、48 负、904 平（精确配对二项 `p=7.8e-5`）。最近标签诊断产生 102 胜、35 负、911 平（`p<1e-8`），说明撤回路由精确率仍是主要质量瓶颈。

同一次带标记运行总体得 **34.18%**。一次严格匹配消融只移除被渲染的 `[forget]` 行并恢复先前指引；它总体得
**35.02%**、`ask_to_forget` 得 **13.74%**，而带标记时为 **18.70%**。因此配对差异在遗忘上强正（93 胜、41 负，`p=8.23e-6`），但总体上略负（260 胜、302 负，`p=0.0836`）。无条件暴露每一条检索到的撤回会污染无关问题。下一步应是在 Active Graph 投影时设置选择性撤回门禁，而不是删除标记或施加硬性逐节点条数上限。

第一条投影规则有意比学习式门禁更小：在检索排序之后，每种已注册控制种类最多只暴露排名最高的那一个标记。所有标记记录仍保留在结构化结果与审计 trace 中。在同样的 5,000 题上，只投影 Top-1 `forget` 标记总体得 **35.04%**，并在 `ask_to_forget` 上保住 **18.70%**。相对全标记臂它产生 224 胜、181 负、4,595 平（`p=0.0368`）；在 `ask_to_forget` 内部，胜负恰好 39/39。相对完全剥离臂，总体准确率无法区分（206 胜、205 负），而遗忘仍实质更好（80 胜、28 负，`p=5.65e-7`）。这支持的是 AG 投影预算而不是存储上限：一条记忆可以保留任意多个带类型标记，但模型每类只看到最相关的已注册控制标记。

该投影规则随后经一次全新端到端生命周期重跑
（`nmg_pmv2_marker_top1_e2e_20260728`），而不是只改写旧 search 工件。它完成 200/200 次 persona 摄取与删除、
5,000/5,000 次检索、5,000/5,000 次答案调用，无失败或空上下文。恰好 3,966 个查询暴露了一个 `forget` 标记；没有查询暴露多于一个。该运行总体得 **35.02%**、`ask_to_forget` 得 **18.89%**。它在总体上（96 胜、97 负、4,807 平）与 `ask_to_forget` 上（22 胜、20 负、1,006 平）与先前的答案阶段 Top-1 臂在统计上无法区分。这闭合了消融与实活桥实现之间的差距。

相对全标记臂，新运行以 231 胜、189 负、4,580 平改善整体上了准确率（`p=0.0453`）。相对剥离臂，总体准确率恰好持平，而 `ask_to_forget` 从 13.74% 升到 18.89%（87 胜、33 负，`p=8.68e-7`）。剩余的类别权衡是真实的：与剥离标记相比，遗忘与敏感信息问题改善，而健康类问题回退。更有选择性的门禁以后可能有用，但全历史相似度阈值的上界尚不足以支持现在就增加这份复杂度。

新运行的检索延迟为均值 132 ms、P50 42 ms、P95 85 ms；均值包含每个 persona 的首次冷本地索引构建。答案生成使用 5,892,265 个报告 prompt token（每题 1,178）与 44,340 个 completion token，以 64 个 DeepSeek worker 耗时 25m16s。OmniMemEval 的 token 追踪器记录 provider token 总数，但不记录 DeepSeek 的缓存命中 token 细分，所以本次运行不主张已测缓存命中率。

第二次答案阶段上界消融只在 BGE 相似度至少 0.65 时选择最近的显式撤回。它在 1,383/5,000 个问题上暴露标记，总体得 **35.46%**、`ask_to_forget` 得 **18.03%**。相对 Top-1 的总体增益不显著（206 胜、185 负，`p=0.312`），而且这条臂看到的是该 persona 的完整撤回集合，而不只是 NMG 检索到的候选。因此它不足以支持在运行时加入一个模型专属阈值。

所有答案轮次都使用官方 PersonaMem response 与 metric 脚本，以及 temperature 为零、64 个并发 worker 的 DeepSeek v4 Flash。最近标签臂仍是答案阶段消融而不是端到端排行榜结果：`research/ablations/personamem-forget-tag-ablation.py` 用 BGE 从原始 persona 里选出最接近的显式撤回。最大遗忘目标相似度只能中等地区分遗忘与非遗忘问题
（`AUC=0.796`），所以单一相似度阈值可作为基线，但还不是可靠的生产门禁。

在 Windows 上，官方 response runner 在每次答案后用 `os.replace` 重写其不断增长的 JSON 检查点。运行中读取该文件会锁住目标并使写入方以 `WinError 5` 失败；监控必须使用进程／日志状态或拷贝出的快照。在 5,000 题规模上，这次检查点重写也成为墙钟成本的重要部分。对上文的官方 PersonaMem 协议结果，prompt 为保证可比性保持不变。以下建议仅适用于非官方 NMG runner：把 rubric、模型选项与工具 schema 放在稳定前缀里，把逐题载荷放在其后，并把配对臂相邻调度以改善 provider 前缀缓存复用。

### LoCoMo

锁定的 LoCoMo 仅检索 smoke 在约 3 秒内摄取十个官方会话的全部 272 个 session，随后用十个 worker 在 54 秒内完成全部 1,540 个 category 1--4 查询，无检索失败。逐查询后端延迟为均值 329 ms、P50 267 ms、P95 619 ms、P99 670 ms。返回上下文平均 4,152 字符（P95 为 5,054）。

对 LoCoMo 官方证据 ID 的精确规范化文本审计发现：952/1,540 个问题（61.8%）至少有一条标注证据轮次，764/1,540（49.6%）有全部标注轮次，1,059/2,355（45.0%）的全部标注轮次被覆盖。这是检索诊断而非官方答案分数：改写过的记忆即使没有精确文本也可能有用，而 category 1 与 3 往往需要多轮次或推断。因此下一次可比结果必须用固定 reader 模型与匹配基线跑 OmniMemEval 的官方答案与评分阶段，而不是朝这份辅助审计优化。

一次匹配的检索预算消融为每个设置重建了隔离的 benchmark namespace：

| Top K | 任一证据 | 全部证据 | 证据召回 | 平均上下文字符 | 均值／P95 延迟 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 48.1% | 40.6% | 32.7% | 1,042 | 233 / 496 ms |
| 10 | 55.7% | 46.0% | 39.0% | 2,064 | 256 / 548 ms |
| 20 | 61.8% | 49.6% | 45.0% | 4,152 | 329 / 619 ms |
| 40 | 63.6% | 51.0% | 46.6% | 4,877 | 325 / 609 ms |

`top_k=20` 仍是默认拐点。翻倍到 40 只多恢复 1.6 个证据召回点，却把上下文增加 17.5%。K=40 时多跳与开放域的证据召回仍只有 28.8% 与 15.5%，所以它们的主要限制是排序／组合而不是输出预算过小。更大的默认被拒绝。
OmniMemEval 会在 benchmark 用户 ID 里包含 `version`，并续跑已有 search 工件。因此预算消融必须为摄取与检索都使用全新版本；只改检索版本会查询空 namespace，而复用失败过的版本会重放它的缓存结果。

最初的 LoCoMo 渲染丢掉了 NMG 存储的 `eventTime`。于是像 "I went ... yesterday" 这样被检索到的轮次缺少推导官方答案所需的会话日期。桥现在只为含时间措辞或显式年份的查询加事件时间前缀。在一次全新的 K=20 运行中，这些查询的 450 条被检索标注证据轮次全部携带了日期锚。检索顺序与精确证据召回未变。选择性渲染影响 663/1,540 个问题，为这些问题平均增加 691 字符、其余问题增加零（对整个 benchmark 平均约 297 字符）。这在全局不扩大上下文的前提下恢复了 NMG 里本就存在的信息。

## 官方 LoCoMo 答案阶段结果

所有 NMG 答案阶段运行的评估纪律：

1. **固定弱 reader／judge。** 所有可比的分数都用 temperature 0 的 `deepseek-chat`
   （v4-flash）同时作答与评判。弱 reader 让归因保持干净——它无法用参数知识弥补缺失证据——也符合 Pi 用户面对廉价模型的现实。
2. **始终跑匹配的无记忆基线。** 报告相对
   `no_memory` 的差，而不是绝对分数。绝对分数随 judge 与 harness 版本漂移；差值才是记忆系统的实际贡献。
3. **外部排行榜只是背景。** OmniMemEval 复现表与厂商自报使用不同的 reader、judge、prompt 与预算
   （厂商自己的数字比 OmniMemEval 的复现高 15--30 点）。我们不朝它们调参，也不复现它们。

第一次官方答案与评分轮次把 K=20 记录向量 NMG 运行
（`timefinal`）与匹配的无记忆基线
（`no_memory_timefinal`）相比。两者使用同一固定 reader 与 judge：
经 `.env.nmg` 的 `ANSWER_*`/`EVAL_*` 使用 temperature 0 的
`deepseek-chat`（DeepSeek API，当前为 `deepseek-v4-flash`）。两轮运行中全部 1,540 个问题都被作答；每轮各有一次 judge 调用在 `--skip-failed-judge 1` 下被跳过，因为 judge 把标签 JSON 包在解释里，而上游严格的 `extract_label_json` 正则拒绝它。

| 版本 | LLM-as-Judge | F1 | ROUGE-L | METEOR |
| --- | ---: | ---: | ---: | ---: |
| NMG（记录向量 K=20） | **0.6173** | 0.3424 | 0.3573 | 0.3664 |
| 无记忆下界 | 0.1741 | 0.1309 | 0.1254 | 0.1166 |

| 类别 | NMG | 无记忆 | 题数 |
| --- | ---: | ---: | ---: |
| 单跳 | 0.6813 | 0.2093 | 841 |
| 时间推理 | 0.6854 | 0.0592 | 321 |
| 多跳 | 0.4184 | 0.1423 | 282 |
| 开放域 | 0.4105 | 0.3438 | 96 |

NMG 总体比匹配基线高 44.3 个 judge 点。时间推理收益最大（+62.6 点），验证了选择性事件时间渲染。多跳仍是最弱的记忆类别（0.4184），与检索审计「多跳证据召回受排序／组合而非预算限制」的发现一致。开放域问题只增 6.7 点，因为许多问题可凭参数知识回答。

极性元数据 schema 变更（`memory_records` 上的 `confidence`、`polarity`、
`predicate_key`、`extract_method` 列）之后，一次全流水线重跑
（`records_k20_r2`，全部六步，全新 namespace）确认没有回退：LLM-as-Judge 总体 0.6480（单跳 0.6908、时间 0.6875、多跳 0.5179、开放域 0.5208；1,537/1,540 被评判，3 次 judge 跳过）。相对 `timefinal` 的差部分来自重新生成的检索结果而非代码改动，所以它被读作「无回退、方向为正」，而不是已测量的改进。

复现方式（venv 在 `.benchmarks/bge-venv`、`PYTHONUTF8=1`）：

```powershell
bash scripts/run_locomo_eval.sh --lib nmg --env .env.nmg --version no_memory_timefinal --from-step 3 --skip-failed-judge 1
bash scripts/run_locomo_eval.sh --lib nmg --env .env.nmg --version timefinal --from-step 3 --skip-failed-judge 1
```

环境说明：NLTK 的 `punkt_tab`／`wordnet` 必须手工取进
`~/nltk_data`，因为本地网络拦截 nltk 的下载器；judge 阶段从 `nmg_locomo_judged.json` 续跑已完成分组，所以瞬时 API 错误通过重跑第 4 步即可廉价重试。

## Embedding 粒度消融

一次匹配的 LoCoMo K=20 检索消融通过 `bge_server.py` 里的小型离线 benchmark 服务器使用本地缓存模型
`BAAI/bge-small-en-v1.5`（384 维）。向量仍留在每个用户的 SQLite 数据库里；没有引入向量数据库或 vLLM 服务器。

把模型与启用 CUDA 的依赖装进 benchmark venv 后，本地服务器为：

```bash
.benchmarks/bge-venv/Scripts/python.exe evals/omnimemeval/bge_server.py --device cuda
```

在 OmniMemEval 环境文件里设置 `NMG_EMBED_BASE_URL=http://127.0.0.1:8000/v1`、
`NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5` 与
`NMG_EMBED_PROFILE=bge-en`。

| 检索路径 | 任一证据 | 全部证据 | 证据召回 | 平均上下文字符 | 均值／P95 延迟 |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS5 词法 | 61.8% | 49.4% | 45.1% | 4,450 | 327 / 637 ms |
| 节点 + leaf 摘要（5 个节点） | 23.8% | 17.9% | 16.4% | 3,335 | 281 / 342 ms |
| 节点 + leaf 摘要（10 个节点） | 26.1% | 19.7% | 18.0% | 3,359 | 312 / 371 ms |
| 记录向量 | **68.0%** | **54.1%** | **52.9%** | 4,458 | 314 / 361 ms |
| 节点 + leaf + 记录并集 | 25.7% | 19.4% | 17.7% | 3,358 | 568 / 647 ms |

因此压缩层级不被接受为唯一的证据检索索引。它的摘要丢弃了 LoCoMo 需要的区别，而当前的并集排序让粗粒度路线挤掉了更强的记录候选。对 benchmark 桥而言，启用 embedding provider 时默认使用记录粒度。节点与 leaf 向量作为有界目录或未来大规模路由阶段仍有用，但在一次匹配实验证明召回持平或更好之前，它们不得替代细粒度证据检索。

记录向量路径在不增加平均上下文规模或平均延迟的前提下把整体证据召回提高 7.8 点。category 1 与 3 的召回分别从 26.9% 升到 40.4%、从 14.7% 升到 28.4%。初始的逐用户索引构建确实造成 P99 延迟尖峰（约 2.3 秒），所以生产索引应保持异步或增量，而不是发生在用户的首次查询上。

## BEAM 100K 检索实验

官方 OmniMemEval 流式 runner 在 K=20 下完成全部 20 个 BEAM 100K 会话与 400 个探测问题。辅助审计把 benchmark 的 `source_chat_ids` 对照精确规范化来源消息；它是检索诊断，不是官方 Nugget Score。

| 检索路径 | 任一证据 | 全部证据 | 证据召回 | 平均上下文字符 | 首次查询 | 稳态 P50 / P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS5，用户优先 actor 策略 | 58.3% | 27.9% | 26.2% | 3,451 | 146 ms | 9 / 15 ms |
| BGE 记录，惰性首查询索引 | 65.9% | **34.4%** | **32.9%** | 3,099 | 2,102 ms | 41 / 62 ms |
| BGE 记录，写入时增量索引 | **66.2%** | 33.8% | 32.8% | 3,118 | **193 ms** | **40 / 51 ms** |

因此记录向量可推广到 LoCoMo 之外：它们在 BEAM 上多获 6.7 个证据召回点，同时返回略少的文本。它们被保留。当前精确向量扫描在 100K 规模下仍够用，但逐用户惰性构建不行：首次查询延迟平均 2.1 秒。写入时增量索引在保持检索质量的同时把平均首次查询延迟从 2,102 ms 降到 193 ms。在 90 次会话 add 调用中，embedding 把总摄取时间从 7.0 秒增加到 42.3 秒，但全部 20 个会话的 add 加 search 总时间仍从 73.0 秒降到 68.9 秒。因此共享增量同步器被接受，但 OmniMemEval 适配器现在会把某个 benchmark 用户会话 add 期间的待处理记录累积起来，并在检索之前立即作为一个或多个批次冲刷。这在检索时保住就绪的索引，同时不必为 LongMemEval 会话发出几十个极小的 embedding 请求。Pi 另外在轮次之后于后台调度同一同步器，并在索引就绪前继续使用 FTS。

BEAM 还暴露了一个 actor 路由权衡。在 1,094 条标注证据消息中，253 条是 assistant 消息。在一个共享 K=20 池里检索所有 actor 把证据召回降到 13.3%，并把平均上下文扩到 8,176 字符。为 assistant 消息预留 20 个槽位中的 4 个得到 26.1% 召回，相对 26.2% 的基线基本没有增益，同时上下文与稳态延迟几乎翻倍。两个变体都被拒绝；实验性路由代码被移除，而不是加进 NMG。

用以下命令跑该审计：

```powershell
npm run benchmark:audit:beam -- `
  .benchmarks/official/OmniMemEval/data/beam/beam_100k.json `
  <one-or-more-search-result.json>
```

用以下命令复现精确文本证据审计：

```powershell
npm run benchmark:audit:locomo -- `
  .benchmarks/official/OmniMemEval/data/locomo/locomo10.json `
  <one-or-more-search-result.json>
```

OmniMemEval 不附带用户记忆的 `no-memory` 后端。为了得到内部匹配下界，在保留问题与顺序的前提下转换一个既有 search 工件：

```powershell
npm run benchmark:prepare:no-memory -- `
  .benchmarks/official/OmniMemEval/results/locomo/nmg-nmg_smoke/nmg_locomo_search_results.json `
  .benchmarks/official/OmniMemEval/results/locomo/nmg-no_memory/nmg_locomo_search_results.json
```

用 `--lib nmg --version
no_memory` 运行官方 response 与评分阶段。该基线只改变检索上下文与检索成本；官方问题集、答案 prompt、reader 与 judge 保持相同。它是内部下界，不是 OmniMemEval 记忆后端的排行榜条目。

## 两条评估边界

OmniMemEval 的用户记忆 runner 会强制调用所选后端的
`search()`。因此它测量 NMG 的摄取、检索、删除、证据覆盖与成本。它不检验 Pi 是否决定召回记忆、或是否正确使用结果。本地匹配的 Pi runner 仍是端到端 harness 门禁。

对可比的 backend 运行：

1. 使用与本地匹配运行相同的固定 LongMemEval 问题 ID；
2. 在启用答案阶段时使用相同的 reader 与 judge 配置；
3. 比较证据召回、token 注入与延迟；
4. 验证逐用户隔离与清理；
5. 验证每条返回记忆仍可追溯到 NMG 证据。

在 Windows 上，调用上游 runner 之前设置 `PYTHONUTF8=1`。

## 刻意的非目标

- 不要把 OmniMemEval 内嵌（vendor）进 NMG core。
- 不要维护五个各自独立的 NMG benchmark 适配器。
- 不要为 Pi 采用更重的 AgentBench/OpenClaw agent-memory 轨道。
- 不要仅为该 harness 增加另一套 embedding 或存储实现；它必须使用与 Pi 相同的 NMG 配置。
