# `agent:verify` 复述失败检查自己的输出，并写出证据文件路径

**Status:** implemented
**Approved:** explicit
**Relates to:** [仓库开发 Skill](../../../skills/repo-development/SKILL.md)、
[CI 与质量设计](../../design/ci-cd-and-quality.md)、
[长检查异步跑](2026-09-18-detached-long-checks.md)

治理 meta-rule：[self-governance meta-rule](2026-09-07-self-governance-meta-rule.md) ——
本变更改动了验证工具的行为，因此自带决策与替代方案。

English version: [2026-09-18-verify-summary-restates-the-failure.md](2026-09-18-verify-summary-restates-the-failure.md)

## 问题

2026-09-18 一次 `npm run agent:verify -- <paths>` 只报出

```text
- [blocking] npm run test:product: failed (command exited with code 1)
```

读者眼前没有别的东西。几分钟后同一套件单独跑是 1433/0，所以这次失败既不能算回归、也不能算 flake、
也不能算真断言失败——分辨这三者所需的证据不在读者面前。

第一次诊断是"失败被吞掉了"，读代码后否掉了。既没有异常被吞，也没有静默路径：

- `runCommand`（`tools/agent-verify.ts`）抓到 stdout+stderr，并且正是为此保留
  `output: ok ? undefined : output.slice(-8000)`。
- `runNpmScriptCheck`（`src/rcp/verification.ts`）在非 quiet 时把捕获的输出**回流**打印，
  而两个调用点传的都是 `!json`——所以路由计划路径**和**窄路都会把失败检查自己的话按执行顺序打印出来，
  位置在摘要**上方**。
- 在这里抹掉它们的是 `| tail -20`，也就是读一次长跑结果最普通的做法。

那之后还剩两个真实缺口：

1. 摘要行只带 `reason`（一个退出码），从不带 runner 特意留下的 `output`。于是"判决"和"原因"之间隔着
   流式输出占掉的那几十行——正好是滚动或管道会吃掉的部分。
2. 文本模式打印了 RCP receipt 路径，却从不打印持有完整结构化证据的 `.nmg/verification/latest.json`
   的位置；只有 `--json` 带 `evidencePath`。

顺带发现第三点：有个测试用 `--root <本仓库> --dry-run` 跑 CLI，而工具连 dry run 也会持久化证据，
于是产品套件会覆盖仓库自己的验证证据。实测：一次真实运行之后，`latest.json` 的内容是
`scopes: [".gitignore"]`、每个检查都是 `skipped` / `dry run`。

## 决策

1. **文本模式复述失败检查的尾部。** 在每条失败检查的摘要行下面，缩进（`| ` 前缀）打印它捕获输出的最后
   10 个非空行，每行截到 300 字符，随后给出一行标记，写明被截断并指向证据文件。通过和跳过的检查不额外打印。
2. **文本模式总是写出证据文件路径**（`Evidence: <path>`）。`--json` 保留它的 `evidencePath` 字段和
   本就完整的 `output`。
3. **测试不许写仓库的证据。** 那个把 CLI 根指向本仓库的 dry-run 用例改为
   `--output <临时目录>/verification.json`，于是跑产品套件不再覆盖 `.nmg/verification/latest.json`。

这**不是**对流式的改动：检查运行时输出照旧实时流式打印；摘要在判决旁边复述一段**有界**的尾部，
因为读者最需要的两个事实——什么失败了、为什么——不应该需要滚动才能同时看到。

## 考虑过的替代方案

- **当成"被吞掉的失败"处理，给检查加日志。** 依据否决：没有东西被吞，`spawnSync` 返回了输出，runner
  存下了它，流式路径也已经打出来了。再加 `try`/`catch` 只会在一个不存在的缺陷上加代码。
- **取消流式，只留摘要尾部。** 否决。长检查运行时的进度值得看，而只在最后才出现的失败更难归因到
  产生它的那一步。
- **在摘要里打印全部捕获输出。** 否决：它与流式重复，且最长 8 000 字符，正是这份摘要要避免的刷屏。
- **只打印证据路径，不复述尾部。** 这是最省的诚实选项，也最接近"工具已经把它写下来了"。否决理由：
  它恰好落回本记录的起因场景——读者手里只有最后一屏，失败已经在屏外，而一个路径本身要让他多跑一次
  工具调用、再在文件里手工找。
- **连 JSON 模式一起改。** 否决：机器消费者本来就拿到完整的 `output` 字段，缺东西的只有给人看的摘要。

## 后果

- 失败变得可在一处读完：判决、退出原因、命令自己的最后几行、完整文本在哪。
- 新增输出有界（每条失败检查 10 行、每行 ≤300 字符），不会刷屏；有多个失败检查的跑相应各增长这么多。
- `.nmg/verification/latest.json` 从此不仅服务机器消费者，也服务人——这正是决策 3 必须同批做的原因。
- **诊断过程本身也是产出**：下一个在管道视图里看到"看起来静默"的失败的人，手里有实测而不是猜测，
  能分清"输出被管道截掉了"和"工具把它丢了"。

## 推迟

- **dry run 仍会持久化证据。** 决策 3 只是让测试不再覆盖仓库证据；`agent:verify --dry-run` 依旧写
  `.nmg/verification/latest.json`，所以人工 dry run 仍可能把最近一次真实结果换成一个所有检查都 `skipped`
  的计划。若真的误导了判断再处理。
- **完整输出的 `--verbose` 旗标。** 摘要尾部是刻意有界的；若某次真实失败需要就地看超过 10 行，
  顺势的扩展是加旗标，而不是把默认值调大。
- **已知的 `test:product` 并行加载失败。** 引起本记录的那次跑可能就是此前记过两次的 flake。本变更让这类
  失败可以就地诊断；它并不识别那个 flake，而现在 flake 与真回归之间的差别从"一次工具调用"缩到"一屏"。
