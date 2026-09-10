# 每个入口登记一句话

[English](2026-09-09-register-every-entry-point.md)

**Status:** rejected  
**Relates to:** 2026-09-09-gates-assert-results-not-tools

## Problem

`package.json` 声明了 93 个脚本，没有任何地方说明它们各自是做什么的。存在四处**部分**登记：根
`README.md` 列了 12 个、`evals/README.md` 30 个、`docs/design/ci-cd-and-quality.md` 22 个、
`AGENTS.md` 6 个，合计覆盖 59 个；加上各目录 README 覆盖 28 个 eval 目录中的 16 个。有九个脚本
在任何地方都找不到：`index:qwen3`、`hotspot:modules`、`perf:hotspots`、`eval:recall-compression`、
`eval:perf-overhead`、`eval:concurrency`、`benchmark:ablate:reverse-retrieval`、
`benchmark:merge:longmem`、`lint:fix`。

可调用面比 `package.json` 宽。`bin/` 有两个入口，RCP CLI 有十个子命令。对 `tools/`、`scripts/`、
`evals/`、`bin/` 下 178 个候选文件做普查，**23 个文件名在仓库其它文件里一次都没出现**——多数是
`evals/omnimemeval/research/**` 的探针与审计，外加 `tools/fork-merge-demo.ts` 和
`evals/retrieval/profile-*.ts`。RCP 自己是干净的：十个子命令都有文档（1 到 47 次提及）。

代价不是整洁问题。2026-09-09 一个 Agent 问「哪些脚本没有消费者」，写了个一次性脚本去答，然后又
写了两个——第二个漏掉了 `verify:static` 里组合进去的脚本，第三个漏掉了根 `README.md`。它一次都
没跑过 `npm run agent:context`，而 `AGENTS.md` 要求那必须是任何仓库改动的第一步。

## Proposal

一个文件 `docs/scripts.yaml`，作为「怎么调用它、什么时候该用它」的唯一归属。每个可调用入口一条
——package 脚本、`bin` 命令，或独立文件：

```yaml
- entry: hotspot:modules
  when: 想知道 store 模块的调用热点有没有迁移
- entry: nmg-rcp reconcile
  when: 改完仓库要一条能复算的验证收据
```

`when` 是触发提示，不是描述。`docs:check` 增加两条检查：**错误级**——与 `package.json` 脚本集合
相等（可精确枚举，所以不会判错）；**警告级**——某个文件或 CLI 子命令字符串的名字在任何其它受跟踪
文件里都不出现。写不出 `when` 的脚本、或 `when` 与别人重复的脚本，一律删除而不是登记。
`index:qwen3` 被点名为第一个候选，因为它的命令与 `index:embeddings` 字节相同。

## Alternatives considered

**扩展现有的四处登记。** 它们是讲 CI 策略和评测策略的散文文档；一份完整清单得在每一处重述。
否决：一个事实四个家。

**把这句话写进每个文件的头部注释。** 当时否决的理由是 `hotspot-files.ts` 已经那样藏起了用途，
而「只活在文件头注释里的用途没有读者」。这个前提是错的——见下。

**在 `package.json` 里加 `scriptsMeta` 块。** npm 没有逐脚本描述的标准。否决：在工具拥有的文件里
放非标准形状。

**靠各目录 README 的约定。** 它已经是部分的（28 个 eval 目录里只有 16 个），而那九个未登记的脚本
正是它漏掉的。

**只加门禁、不加登记表。** 一个只会说「这个文件在某处被引用了」的检查，告诉不了任何人它是做什么
的。否决：它对那九个全都会通过，因为每个的唯一引用就是它自己。

**只对 `package.json` 加门。** 否决：`bin/` 和 CLI 分发器同样不可见，普查在 `package.json` 之外
找到 23 个无解释文件。

**用 import 分析精确定位入口点。** 能让第二项检查变成精确的，但需要按语言解析，而且仍然判不出一个
叶子文件是入口点还是库。

## Why rejected

- **登记表已经存在，只是高一层。** `agent-context.yaml` 带 `capabilities:`（id、aliases、summary、
  entrypoints、supports）和 `routes:`（paths、owners、tests、verify）；`agent:context:check` 在检查
  它，`npm run agent:context` 在读它，而 `AGENTS.md` 已经把它定为仓库改动的第一步。
  `docs/scripts.yaml` 会是**第二个**目录，用不同粒度回答同一个问题——五个能力对九十三个脚本。
  一个事实两个家，多了一个。
- **可检查的形态和有用的形态尺寸不同。** 要在「缺一条」时失败，文件必须枚举**每一个**脚本；要有用，
  它只该列「别处没解释的」。九十三行散文，换九行价值。
- **用来否掉最便宜方案的那个前提是错的。** 「文件头注释里的用途没有读者」预设了注释已经存在。2026-09-09
  实测：`tools/`、`scripts/`、`bin/` 下 **33 个入口文件里有 24 个完全没有头部注释**。所以那个替代方案
  并非免费——但它的代价是**一次写下的 24 行**，写在用得到的地方，读者就是打开文件的那个人。
- **那九个多数本来就有解释，缺的是 npm 别名。** `benchmark:ablate:reverse-retrieval` 在
  `evals/omnimemeval/README.md` 里有描述，那里打印的是底层的
  `python …reverse-retrieval-ablation.py` 命令。那次普查测的是「对**别名**的引用」缺失，却当成
  「解释」缺失报了出​​来。
- **测引用而不是测使用的警告永远不会清空。** 那 23 个文件里有 `evals/omnimemeval/research/**`，它会
  长期不被引用。没人能清空的警告会变成忽略列表，然后检查就没了。

## What was done instead

- 从 `package.json` 删掉 `index:qwen3`——唯一可证明是死的别名，与 `index:embeddings` 字节相同。
  `scripts/index-qwen3.ts` 保留，因为 `index:embeddings` 跑的就是它。
- 其余八个写进读者本来就在的地方，各一行：`evals/README.md` 增加一张
  「One-off measurement scripts」表（五条），`docs/design/ci-cd-and-quality.md` 增加三个仅本地的
  命令。
- 没有新文件、没有新检查、没有常设规则。上面的普查留在这里，作为「将来再有人提议建中央登记表时
  不必重做」的依据。
