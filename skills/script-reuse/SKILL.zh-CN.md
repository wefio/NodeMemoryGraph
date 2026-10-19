# 一次性脚本怎么写才正确

[English](SKILL.md) · [术语](SKILL.terms.yaml)

一次性问题通常用一次性脚本解决。**写出来即可。** 本 Skill 不是要劝你不要写脚本；它只约束两件事：

- 不要编写已有部件的第二份副本；
- 不要提交会悄悄算出错误数字的脚本——数字可能在脚本删除很久之后仍被引用。

[部件清单](../../docs/guides/parts.zh-CN.md)是另一半方案：如果现成部件适合，就导入使用，例如百分位函数、`mapConcurrent`、原子 JSON 写入或控制面 API，而不是重新实现。这是捷径，不是要求。只要是该功能的第一份实现，脚本自带三行辅助函数也可以。

## 正确性要点

按这些问题最常造成的影响排序：

1. **一条命令即可运行，无需编辑文件。** 输入来自 flags，而不是每次运行前要修改的常量。`node:util` 已经提供 `parseArgs`，不要另写一份。
2. **缺输入时拒绝运行。** 缺少 flag、缺少文件或数据集为空时应抛错。零行运行不得输出数字。
3. **对结果做断言。** 计数相加一致、值有限、部分之和等于整体等。一个 `if (...) throw` 就够；它能区分“得到了测量结果”和“脚本只是运行过”。
4. **在输出中说明测量内容。** 脚本可以是一次性的，但输出不是。将输入路径、行数和时间戳与数字一起写出，以便脚本删除后仍可解释该数字。
5. **明确失败并使用非零退出码。** 不要用空 `catch {}`，不要在失败后 `process.exit(0)`，也不要在测量流程中用 `?? 0` 掩盖缺失值。

```ts
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { writeJsonAtomic } from "../tools/parts/fs.ts";
import { mean } from "../tools/parts/stats.ts";

const { values } = parseArgs({
  options: { input: { type: "string" }, out: { type: "string" } },
});
if (!values.input || !values.out) throw new Error("usage: --input <file> --out <file>");

const rows = JSON.parse(readFileSync(values.input, "utf8")) as number[];
if (rows.length === 0) throw new Error(`${values.input} has no rows`);
if (!rows.every(Number.isFinite)) throw new Error(`${values.input} has a non-finite value`);

writeJsonAtomic(values.out, {
  input: values.input,
  rows: rows.length,
  measuredAt: new Date().toISOString(),
  mean: mean(rows),
});
```

## Routine 的结构（仓库中的现有例子）

`scripts/pi-paths.ts`、`scripts/pi-turns.ts` 和 `scripts/pi-timeout.ts` 展示了现有模式：每个文件一个 routine，只导出函数，由 `scripts/pi-control.ts` 导入，并分别有对应的 `tests/scripts/*.test.ts`。

- 一个文件只放一个 routine，并以其用途命名。入口应导入该 routine，而不是把实现内联。
- 文档注释说明**为何需要它**，而不是重复签名已经表达的内容。例如 `pi-timeout.ts` 说明 Pi 的事件超时不涵盖一直不确认的 prompt 请求。
- 在输入边界处拒绝坏输入：`parsePiPromptTurns` 会拒绝空消息和位置错误的 `--turn`。
- 它有测试。

这就是 **routine** 与**一次性入口**的区别。入口可以丢弃；只要第二个脚本也需要 routine，它就应保留。此前只有一个调用方时，将它与唯一调用方放在一起。

## 关于 reusable parts 的规则

- **Part 是导入，不是命令。** 不要因某个任务需要一次组合操作，就新增 `nmg-rcp` 子命令、npm script 或 `tools/*.ts` 入口。没有其他调用方时，这些入口会逐渐失去维护。
- **第二份定义是抽取信号。** 如果刚写的辅助函数已存在于另一个文件，就把它移到两边都能导入的位置。具体放在哪里由你判断；只要不放在已经拥有该概念的模块内部即可。
- **不要把判断塞进 part。** 选择 narrow 或 full，或决定更改是否可接受，应留在一个经过审查的位置。替你做此决定的 part，其实只是披着库外衣的 gate。
- **一次性脚本就是一次性的。** 不要提交脚本。只有在第二个脚本也需要时，才提交共享 part。

## 缺少合适部件时

先写脚本，然后确认是否有第二个脚本也需要同一功能。确有第二个调用方时，再把它提取到 shelf；清单条目应说明用途、签名和最小调用示例。

## 哪些事情没有自动化

单靠文件本身，没有 gate 能判断脚本是否正确或是否包含有效的 self-check。当前 parts-shelf 检查只确认清单命名的函数仍由 `src/rcp` 或 `tools/parts` 导出；它不会检查签名、示例或重复的辅助函数实现。这些属性仍由脚本作者负责。自然语言说明本身较弱——提供上述模板，是为了让遵循它比忽略它更省力。
