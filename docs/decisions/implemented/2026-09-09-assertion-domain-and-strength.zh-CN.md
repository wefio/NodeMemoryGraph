# 断言记录它的定义域、假设与证据强度

[English](2026-09-09-assertion-domain-and-strength.md)

**Status:** implemented  
**Approved:** explicit

## Problem

`ContractAssertion` 记录了一条性质（`statement`）并把它绑到证据（`check`）上。它没有记录这条
性质声称覆盖的定义域，也没有记录声称所依赖的假设。2026-09-08 的追溯工作建起了这本账，但没
注意到缺的两列，因为没有东西消费它们。

后果是一处具体的过度声称：`rtm:check` 打印 `12 verified`。测试通过只是在它跑过的输入上的
**见证**，不是对断言所声称范围的证明，所以 `verified` 说得比证据能承载的多。缺口一直看不见，
因为范围从来没被写下来——读者无法检查一条定义域不存在的声称。

目标形式写在 `docs/design/verification-claims.md`：

```
∀ x ∈ D,  A(x) ⇒ P(x)
```

## Decision

给 `ContractAssertion`（`src/rcp/types.ts`）加三个可选字段：

```ts
interface ContractAssertion {
  // 已有：id, statement, check?, documentedOnly?, kind?, stage?, context?
  domain?: string; // D —— 这条性质声称覆盖的情况
  assumes?: string[]; // A —— 假设册里的 id
  strength?: "decision" | "witness"; // 证据买到多少；缺省即 witness
}
```

`documentedOnly` 保持不变。「完全没有证据」与「证据买到多少」是两个轴，两个字段说同一件事就多
了一个。

加一个登记册 `docs/design/assumptions.yaml`，每条含 id、一句话、owner、以及这条假设**怎么被
证伪**。

`tools/rtm-check.ts` 随之：

- 非 `documented-only` 的断言缺 `domain` → 失败；
- `assumes` 的 id 不在登记册里 → 失败；
- 分别报告 `bound` 与 `proven`，并给出强度分布，例如
  `12 bound (0 proven / decision, 12 witness), 1 documented-only`；
- `documented-only` 仍不计入 bound。

`strength` 缺省视为 `witness`，所以回填没做完时报告也不会夸大。

## Alternatives considered

- **只改措辞**（`verified` → `bound`）。最便宜，而且它本身就能消掉那处过度声称。作为完整答案被
  否：它让定义域依旧没有归宿，下一个读者仍看不出证据没覆盖什么。作为**第一块**保留：它先于
  schema 变更落地，不会白做。
- **复用已有的 `context?: string`**。字段已存在，13 条里用了 3 次。否：`assumes` 必须能解析成
  名字才可检查，自由文本不行。
- **引入形式化规范语言**（Dafny、TLA+）生成验证条件。2026-09-08 已为控制平面否过一次，这里再
  次否：它要求 13 条断言的 D 与 P 全部形式化，为了其中少数几条重写整套契约。
- **不加字段，只写 skill 提醒**。本仓库已经有过 prompt-only 的失败经验，而且这条提醒会住在读者
  **相信了绿灯之后**才打开的那个文件里。

**现在必须成立的：**

- `rtm:check` 输出含 `bound`，不再出现 `verified`；
- 新增断言不带 `domain` 会让 `rtm:check` 失败，且报错信息点名该断言 id；
- `assumes` 指向登记册中不存在的 id 会让 `rtm:check` 失败；
- 输出里的强度分布与契约中的计数一致；
- 现有 13 条断言都有 `domain`，且都有显式 `assumes`（可以是 `[]`）；
- `proven` 只统计证据是决策过程的断言。**今天是 0 条**——代码里那两个决策过程没有被绑到任何断言
  上——报告会这么说，而不是默认掉。

## Consequences

- `ContractAssertion` 新增 `domain`、`assumes`、`strength`；前两个由编译器强制，因此任何能编译
  通过的契约都会写明证据覆盖什么、依赖什么。
- 现有 13 条断言全部带 `domain` 与显式 `assumes`。
- `tools/rtm-check.ts` 报 `12 bound (0 proven / decision, 12 witness), 1 documented-only`，并把
  `assumes` 解析到 `docs/design/assumptions.yaml`（5 条）。
- `proven` 是 0：代码里两个决策过程都没有绑到任何断言。这个缺口现在是可见的，不是被默认掉的。
- 代价：共享契约上多了两种失败模式；而 `domain` 过期没有任何东西能发现。

## Risks

- **含糊的定义域也能通过检查。** 存在性可检查，具体性不可。反制手段是变异测试而不是检查：一个
  存活的 mutant 若其改动落在声称的定义域之外，就是那条 domain 写错了的证据。
- **回填会诱导写出「贴合测试而不是贴合意图」的话。** 没有检查能发现，这是评审工作，争论的地方
  就是那行 domain。
- **契约 schema 变更会波及控制平面。** 字段可选、IR 有版本，旧契约仍合法；风险在于读者把
  「没有 domain」读成「没有定义域声称」而不是「还没填」。
- **共享契约上新增两种失败模式会挡住无关改动。** 接受，理由与术语索引当时相同。
- **`domain` 那一列会过期。** 证据变了，没有人会回头重读 domain。**撤销条件：若三个月内没有
  任何反例指向某条 domain 声明，也没有任何存活 mutant 被归因到某条 domain，则去掉该字段**，只
  保留 `bound` 这个措辞修正；它修掉的那处过度声称本身是立得住的。
