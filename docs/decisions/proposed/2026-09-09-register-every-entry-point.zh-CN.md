# 每个入口登记一句话

[English](2026-09-09-register-every-entry-point.md)

**Status:** proposed  
**Relates to:** 2026-09-09-gates-assert-results-not-tools

## 问题

`package.json` 声明了 93 个脚本，而没有任何地方说明它们各自是干什么的。现有四处
**部分**登记：根 `README.md` 12 个、`evals/README.md` 30 个、
`docs/design/ci-cd-and-quality.md` 22 个、`AGENTS.md` 6 个，合计 59 个；各目录自带的
README 覆盖 28 个 eval 目录中的 16 个。有 **9 个脚本任何地方都不出现**：
`index:qwen3`、`hotspot:modules`、`perf:hotspots`、`eval:recall-compression`、
`eval:perf-overhead`、`eval:concurrency`、`benchmark:ablate:reverse-retrieval`、
`benchmark:merge:longmem`、`lint:fix`。

可调用的面比 `package.json` 更宽。`bin/` 有 2 个入口，RCP CLI 有 10 个子命令。对
`tools/`、`scripts/`、`evals/`、`bin/` 下 178 个候选文件的普查发现：**有 23 个文件的
名字在仓库里任何其他文件都不出现**——主要是 `evals/omnimemeval/research/**` 下的
探针与审计，以及 `tools/fork-merge-demo.ts`、`evals/retrieval/profile-*.ts`。RCP 本身
是干净的：它的 10 个子命令**全都有文档**（1 到 47 处）。

代价不是整洁问题。2026-09-09，一个 Agent 问「哪些脚本没有消费者？」，为此写了一次性
脚本；而它不得不写了三个，因为前两个都算错了——第二个漏掉了组合在 `verify:static` 里
的脚本，第三个漏掉了根 `README.md`。它一次都没跑过 `AGENTS.md` 要求作为改动第一步的
`npm run agent:context`。而当同一个问题问到 `scripts/hotspot-files.ts` 时，答案只有打开
文件才看得到：*「这就是当初促成拆分的那次分析……改动之后重跑它，看热点有没有迁移。」*
**一个只活在文件头注释里的用途，没有读者。**

## 提案

一个文件 `docs/scripts.yaml`，作为「怎么调用它、什么时候该用它」的唯一归属。每个可调用
入口一条——可以是包脚本、`bin` 命令，或独立文件：

```yaml
- entry: hotspot:modules
  when: 想知道 store 模块的调用热点有没有迁移
- entry: nmg-rcp reconcile
  when: 改完仓库要一条能复算的验证收据
- entry: tools/fork-merge-demo.ts
  when: 想看图合并分支的实际行为
```

`entry` 是**触发提示词**，不是描述：它回答的是「什么时候该去用它」，与 Skill 的
description 同一个思路。

`docs:check` 增加两项检查：

- **错误级** —— 每个 `package.json` 脚本恰好一条登记，且每条指向脚本的登记都能解析。
  这个集合可以从 `package.json` 精确枚举，所以这项检查不可能算错。
- **警告级** —— `tools/`、`scripts/`、`evals/`、`bin/` 下名字在任何其他已跟踪文件里都不
  出现的文件；以及 `src/cli/main.ts`、`src/rcp/cli/main.ts` 里在任何文档中都不出现的
  子命令字符串。两者都意味着「没有任何地方解释它」。这项检查**按构造就是近似的**——
  它看不见以包名被 import 的 Python 模块，也把「被提到」当成「被解释」——所以它只警告，
  等这个集合清空后再升级。

**写出这句话，就是入口是否值得存在的检验。** 写不出 `when` 的脚本、或 `when` 与别的
脚本重复的脚本，一律删除而不是登记。`index:qwen3` 是第一个：它的命令与
`index:embeddings` 逐字相同，所以它的句子也必然相同。

## 考虑过的替代方案

**扩展现有的四处登记。** 它们是讲 CI 策略和评测策略的散文文档，一份完整清单得在每一处
重述一遍。否决：一个事实四个归属。

**把句子写进每个文件的头部注释。** 那正是 `hotspot-files.ts` 藏起用途的地方。否决：
不打开每个文件就发现不了。

**在 `package.json` 里加 `scriptsMeta` 块。** npm 没有逐脚本描述的标准。否决：在工具
自己的文件里放非标准形状。

**靠各目录 README 的约定。** 它已经是部分的（28 个 eval 目录里只有 16 个），而这 9 个
未登记脚本正是它漏掉的部分。

**只加门禁、不加登记表。** 一个只会说「这个文件在某处被引用了」的检查，告诉不了任何人
它是干什么的。否决：这 9 个全都能通过，因为它们唯一的引用就是它们自己。

**只对 `package.json` 加门。** 否决：`bin/` 和 CLI 分发器同样不可见，而普查在
`package.json` 之外找到了 23 个没有任何解释的文件。

**用 import 分析精确定位入口点。** 能让第二项检查变成精确的，但需要按语言解析
（`import`、`require`、Python 的 `from x import`），而且仍然无法判断一个叶子文件是入口
还是库。否决：名字提及检查用十行代码就能覆盖绝大部分。

## 验收标准

- `docs/scripts.yaml` 存在，且与 `package.json` 脚本一一对应。
- `docs:check` 在「脚本没有登记」「登记指向不存在的脚本」「脚本有两条登记」时失败；
  `tests/docs/verify-docs.test.ts` 覆盖这三种情况。
- 警告级检查报告今天这 23 个无解释文件与未登记的子命令，并在该集合清空前保持警告级。
- 当前这 9 个未登记脚本，要么登记，要么删除。
- 根 `README.md` 与 `skills/nmg-memory/SKILL.md` 指向该登记表。

## 风险

- 登记表可能腐烂成 `package.json` 的复述。缓解：它只承载 `package.json` 表达不了的
  `when` 句子，且错误级检查只强制集合相等、不强制内容。
- 105 条的文件一次性评审 diff 很大。接受：只写一次，之后每次只改一行。
- `when` 句子无法机械校验，写得含糊也能过。接受：会腐烂的那部分是完整性。
- 警告级检查有误报——包里的 `__init__.py`、只被另一种语言 import 的模块。接受：它只是
  警告，且集合小到可以人工读一遍。
- 登记可能变成一种仪式，给死脚本一句话就能续命。缓解：句子必须指向一个还有人问的问题；
  这是评审判断，不是检查。
- **本决策回答的是「这是干什么的」，不是「它会不会被用」。** 2026-09-09 的证据表明，Agent 写
  一次性脚本是因为偏好是模型层面的、且奖励结构在鼓励它，任何登记表都改不了这一点。强制手段在
  `2026-09-09-gates-assert-results-not-tools`，本决策从属于它。

## 推迟

- 等这 23 个文件的集合清空后，把警告级检查升级为错误级。
- 覆盖 `nmg` CLI 的子命令字符串——它用 `command ===` 比较分发而非 `case`，等枚举可靠后
  再纳入。
