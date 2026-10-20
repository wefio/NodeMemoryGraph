# UUID 重复与标识符替代方案 — 2026-10-11

[English](uuid-dedup-2026-10-11.md) | [简体中文](uuid-dedup-2026-10-11.zh-CN.md) · [术语](uuid-dedup-2026-10-11.terms.yaml)

**证据边界（2026-10-17）：**这是所列基线上的历史隔离对比。分支状态、宿主接线与
测试／LSP／DAP 读数描述当时检查点，不是当前脏文档工作树的验收。本轮文档审阅未独立
重验或重跑所引实验产物、外部来源及运行回执。

## 冻结的范围

用户选择了移除重复 ID，并要求研究替代方案，且不新增工具或解码。基线为 `97977028772da81d2a2a9f758c2f83b41d7483d6`，位于隔离的 `perf/shared-recall-output` 分支。本切片及其父切片都没有合入主 checkout。

只改动 YAML prompt 源码中的共享反馈提示位。它的 `activeGraphId` 在该提示位的可操作反馈指令中出现一次，而不是两次。search header 仍为精确读取命名自己的图；因此一条完整的 header 加反馈消息会有两处出现，而不是承诺在全部职责中只出现一次。ID 格式、查找、生成、记录预算、适配器策略与历史替换均不改变。

## 固定的比较与退出条件

- 前后单元：单独提示位、search header 加提示位、空结果文本加提示位。复用同一个未改动的完整 UUID。
- 保护反馈动作、图的精确取值、该提示位点名的六个标签、建议性措辞、在猜测标签时省略，以及不发明标签。完成与可独立归因的 claim-outcome 职责保持不变。
- 只有当提示位中出现该 ID 一次、每个完整样本都变短、单独／空的反馈仍可归因，且 prompt／Pi 回归、LSP、构建与选定的阻塞性验证通过时才接受。否则回退文案；不要扩到别名、新格式或 ID 生成。
- 在提交之后采集干净修订的验证。依赖仍是指向主 checkout 的 junction；这不是新装依赖。

已安装的 Python `tiktoken` 允许一个独立的、固定的离线研究矩阵：100 个随机 UUIDv4 值；成对的 UUID、无短横线十六进制、无填充 Base64url 与十进制表示；裸值与 `memory=<value>` 上下文；`cl100k_base` 与 `o200k_base`。存储所有输入与软件版本以便复现。统计实际编码 token，而不是字符估计；不要把任一编码等同于未经验证的当前答案模型或计费。不使用任何包安装、live 模型、embedding 或 benchmark。公开词表文件可以由既有 tokenizer 抓取。本研究矩阵不采纳任何替代表示；既有规范 UUID 保持不变。

## 来源与兼容性边界

1. [RFC 9562 §4](https://www.rfc-editor.org/rfc/rfc9562.html#section-4)
   允许二进制／整数表示，同时描述的是十六进制加短横线的文本。
2. [Alternate UUID Encoding Methods §4.12](https://www.ietf.org/archive/id/draft-davis-uuidrev-alt-uuid-encoding-methods-00.html#section-4.12)
   是一份 Internet-Draft，不是已批准的替代标准。它保留十六进制加短横线文本供默认 UUID 解析器使用，并讨论显式的替代编码解析。更小的拼写并不消除解析支持。
3. [Nano ID](https://github.com/ai/nanoid#comparison-with-uuid)
   生成原生的 21 字符不透明 ID，为 126 个随机位，对比 UUIDv4 的 122 位。那是生成选择，不是对既有 UUID 的免解码拼写。缩减字母表／长度会改变碰撞概率。
4. [OpenAI tokenizer 源码](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py)
   在这两种编码中包含至多三位数字的数字组。这为测试数字标识符提供了动机；正则本身并不证明 token 成本或对 NMG 的适用性。

本研究所检查的字面规范 ID 路径会 trim 非空字符串，并使用精确的 `WHERE id = ?` store 比较。独立的[组合引用路径](compound-reference-2026-10-11.zh-CN.md)通过显式图和原始见证解析显示的选择器；这不使任意无短横线、Base64 或十进制拼写成为有效 UUID 查找。仅仅删去 UUID 短横线或显示 Base64／十进制，并不会取回既有规范 UUID 记录。原生紧凑或数字 ID 只有在那个精确字符串本身就是存储标识符时，才能避免查找时的解码。改变生成方式、遗留共存、跨消费者的假设以及碰撞／安全属性，需要它自己的决策与验证；此处没有任何一项被授权或实现。

## 结果

`tiktoken` 0.13.0 完成了冻结矩阵：100 个成对的随机 UUIDv4 值、16 个聚合单元（4 种表示 × 2 种上下文 × 2 种编码）与 1,600 次 ID tokenization（100 个配对 UUID × 16 个单元），不是 1,600 个独立随机 ID。所有表示在研究 probe 中都回环到其源 UUID。probe 的输入、源码与逐样本计数保留在 `.nmg/verification/id-dedup/token-probe.json`；一次性 Python 源码已移除。

平均 token（实际点名编码，不是字符估计）：

| 表示 | 字符数 | 裸值 cl100k / o200k | `memory=` 字段 cl100k / o200k |
| --- | --- | --- | --- |
| UUID | 36 | 22.79 / 22.78 | 24.55 / 24.54 |
| 无短横线十六进制 | 32 | 18.51 / 18.58 | 20.27 / 20.34 |
| 无填充 Base64url | 22 | 15.87 / 15.08 | 17.39 / 16.68 |
| 十进制 128 位值 | 38.66 均值 | 13.00 / 13.00 | 15.00 / 15.00 |

前三种拼写的字符长度固定；十进制长度可变，因此 38.66 是样本均值，不是固定长度或 token 估计。

在这个样本中，更长的十进制字符串比更短的 Base64url 字符串花费更少 token。这支持评估原生数字字符串标识符，而不是当前模型保证，也不是改变既有记录的许可。数字标识符必须保持为精确字符串，而不是 JavaScript 数字。Nano ID 依据其官方文档研究，既未作为第五个测量单元加入，也未作为依赖安装。

对于固定的反馈 UUID，提示位从 473 字符缩到 387 字符，在两种编码下都从 139 token 缩到 104 token。三种消息组合各自节省 86 字符／35 token。图的出现次数变为：单独 2 → 1，带 header 3 → 2，带空结果 2 → 1。图取值、反馈动作与六个点名标签都存活。这不测量所有 UUID、XML／tool envelope、答案模型计费、cache 行为或模型接受度。

新的图计数测试在基线上是红的（2 而不是 1）。在 YAML 改动之后，prompt、Pi 与共享 surface 套件通过 79/79。LSP 对触及的测试、生成的 prompt 与一次性 Python probe 报告零诊断。DAP 在真实 prompt 测试中暂停，检查了一个图占位符、一处渲染出的图出现、可操作 ID 与不发明标签的边界。完整的阻塞性与干净修订验证单独采集。实现不包含任何解析／生成改动、新工具、别名表、live 模型／embedding、benchmark、合并或共享 daemon 重启。
