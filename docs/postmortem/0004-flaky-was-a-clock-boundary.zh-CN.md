# 0004 - "flaky" 其实是一个时钟边界

[English](0004-flaky-was-a-clock-boundary.md)

**Status:** resolved

## Executive summary

`npm run test:product` 在负载下失败过一次，用例是 `demoteMemory: demotes LTG memory to STG`。上一个会话
在 ledger 里把它记成 *flaky, not fixed* 就走开了：那个标签本身就是全部诊断，并且让这个问题沉寂了一整个
会话。改用循环而不是跑一次之后，它在约 1/1500 次写入中复现：一条记忆以 `valid_from = …38.468Z` 写入，
读回时 SQLite 的 `now` 是 `…38.467Z`，于是读路径的 `valid_from <= now` 为假，行不可见，调用方为一条**刚写
入**的记忆收到 `memory <id> is not active`。这是真实缺陷，位于产品的 current-value 窗口：两个时钟读者
（JavaScript 的 `Date` 与 SQLite 的 `strftime('now')`）在毫秒这一级不一致。

## Summary

current-value 谓词把存储时间戳与 SQLite 自己的时钟比较，在 `src/core/store/base.ts` 与
`src/core/store/retrieval.ts` 中共四处。写入由 JavaScript 打时间戳，于是两个来源会竞争：只要行的时间戳落在
读数连接 `now` 之后 ~1–2 ms 内，一个含义为"该值正在生效"的谓词就会对一条刚刚写入的行回答"否"。机器有
负载时偏差更大；发现它的循环需要 3000 次迭代才看到 2–4 次命中。

修复保留比较，但把窗口按一个有名字的宽限放宽，唯一的归属是新的 `src/core/store/clock.ts`：
`CLOCK_GRACE_MS = 50`，由 `clockNow("later" | "earlier")` 供给四个谓词。宽限只**放宽**"算作生效"的范围，
从不收紧，因此不可能掩盖过期；两个方向分开表达，使这种不对称在每个站点都可见。改后实测：3000 次迭代，
0 失败（此前 2–4）。

SQLite 没有 `milliseconds` 日期修饰符：`'+50 milliseconds'` 会让 `strftime` 返回 `NULL`，比较随后**静默**
排除**每一行**（`ok: null`）——正因如此宽限写成秒的小数（`'+0.050 seconds'`），也正因如此现在有一个 mutant
钉住这个选择。

## Impact

一条在被读之前约一毫秒内写入的记忆，可能在**一次**读中不可见：写入成功、行已存储，而**下一次**读能看见。
没有持久丢失、没有损坏——失效模式是一次假的"not active"回答，它表现为 `requireActiveMemory` 抛错，或在维护、
降级、去重与搜索路径中少一行。它能进到产品测试，只因为那个测试在紧循环里读一条刚写的记忆；在有负载时，
用户对一条刚保存的记忆看到 `not active` 报错是可能的。

第二个、也是本记录存在理由的影响是：这个缺陷被**贴了标签**而不是被诊断。"flaky, not fixed"是关于测试的
陈述，却被当作关于产品的事实写下——而被贴标签的失败，是没人需要再看一眼的失败。

## Timeline

- 负载下 `npm run test:product` 报 1447 中 1 失败：`demoteMemory: demotes LTG memory to STG`。
- 上一个会话单独重跑该套件、看到通过，就在 ledger 里记成 "flaky, not fixed"。
- 本次会话用户拒绝这个标签：出现不止一次的失败必须当成一个案子处理。
- 循环脚本（`.temp/flake-hunt.ts`）写一条记忆后立刻读：3000 次中 2 次失败，都是对一条存在的行报
  `memory … is not active`。
- 把行与 SQLite 的 `now` 并列打印，看到那 1 ms 的先后：时间戳 `…38.468Z`，`now` `…38.467Z`。
- 修复：窗口宽限，落在 `src/core/store/clock.ts`，接入四个谓词。循环：3000 次 0 失败。
- 一个确定性测试（`tests/core/store/current-value-window.test.ts`，6 个用例）钉住两个边界；4 个具名 mutant
  （2 个钉边界、1 个钉宽限、1 个钉 SQLite 时间单位）让这个钉子可被检查：4/4 被抓住。
- ledger 中那一行从 "flaky, not fixed" 更正为已修复的缺陷及其复现率。

## Root cause

又是两条机制，第二条正是第一条能存活下来的原因。

技术上的：那个"该值是否生效"的谓词比较由两个不同时钟读者写下的时间戳。JavaScript 写 `valid_from`，
SQLite 在读时提供 `now`。同一个墙上时钟的两个读者不会返回同一瞬间，而比较是严格的——于是往错误方向差
一毫秒，就足以让一条新行看起来属于未来。代码里没有任何地方说明哪个时钟有权威性，因为两者都被当作"那个时钟"。

流程上的：一个重跑就通过的间歇失败，很容易被归档为 flaky，而 ledger 让这种归档**看起来**像一个结论。
"flaky, not fixed"没有复现尝试、没有比率、没有假设——它是穿着诊断外衣的标签。这个失败在会话稍后再次出现，
那就是标签错了的证据；若没有用户的坚持，它会被贴第二次标签。

## Guardrails added

- `src/core/store/clock.ts` 是 current-value 窗口宽限的唯一归属，未来的谓词有一处可读，而不必再手写一个比较。
- `tests/core/store/current-value-window.test.ts`（6 个用例）让边界确定化：时间戳在未来半个宽限内的算生效；
  未来一分钟的算不生效；过期侧同理；400 轮"写后立刻读"永不失败；窗口在两个边界都放宽、从不收紧。
- `tools/mutation-teeth.ts` 中 4 个具名 mutant（`src/core/store/clock.ts` 拥有独立 target）让这个测试的"牙齿"
  可被检查，其中包括那个会静默排除每一行的 SQLite 时间单位。
- ledger 的 `test:product` 行不再写 "flaky"：间歇失败要么连同复现尝试与比率一起记录，要么记为 open。
  这条规则的归属是 [`skills/repo-development/SKILL.md`](../../skills/repo-development/SKILL.md)。

## Lessons

- 间歇失败在复现给出结论之前，都是"存在时序依赖"的证据。"flaky"是关于测试的说法，不是诊断，更不能当作
  诊断记录。
- 当同一个量的两个读者不一致时，代码必须说明谁有权威性；或者像这里一样，刻意放宽比较，使任何一方都不必被
  要求不可能达到的精度。
- 来自**静默** NULL 表达式的错误答案比异常更糟：`strftime` 遇到未知修饰符会排除每一行并报 `ok: null`。
  一个 mutant 才能让这种"理论上可能"的失误变成永久可见。
- 贴标签很便宜，这正是它危险的原因：错误标签的代价会在之后的会话里、在别人的截止日期下出现。
