# 外部来源设计

[English](external-source-design.md) | [简体中文](external-source-design.zh-CN.md) · [术语](external-source-design.terms.yaml)

**状态：**当前设计。**更新：**2026-08-01。相关：[Memory graphs](memory-graphs.zh-CN.md)、[边激活设计](edge-activation-design.zh-CN.md)、[分层披露设计](tiered-disclosure-design.zh-CN.md)、design.md §5a／§9。

## 1. 原则

**外部内容是感知输入，不是记忆本身。**搜索结果与文件内容描述世界当前状态，而非用户历史。NMG 存储的是关于用户及其经历的记忆；外部内容只能作为**带标记、未核实的证据**进入记忆，而不是一等记忆内容，也不应通过后台重新验证管线更新。

外部事实的维护由 Agent 在**推理时**处理：标记告诉 Agent“来源在外部、尚未核实；重要时应重新检查”，由 Agent 决定是否重查。没有定时 re-fetch，也没有 freshness crawler。

## 2. 标记，而非后台复核

| 方案 | 代价与边界 |
|---|---|
| 标记 + Agent 按需重查（采用） | 只在记忆被使用时才验证；Agent 可结合当前任务判断重要性；写入时固定记录来源；不增加后台常驻组件 |
| 后台重新验证（拒绝） | 会反复抓取大多未使用的记忆；调度器不了解任务上下文；freshness 依赖定时任务；可能增加 Lite 不需要的后台子系统 |

关键权衡是**不确定性是否可见**：若后台复核静默失败，freshness 状态可能误导；保留下来的标记则使外部、未核实来源保持可见。但这并不使标记成为真值裁判——其准确性仍取决于写入路径是否正确保留来源信息。

这也符合 memory reconsolidation 视角：记忆在检索并使用时重新验证，而不是按日程复核。未使用的记忆不需要保持最新。

## 3. Marker

外部 provenance 复用开放的 `MemoryMarker` 机制（`src/core/types.ts`；与 PersonaMem 工作中的 `[forget]` 使用同一机制），不新增 schema 或 memory type：

```json
{ "kind": "external_source",
  "attributes": { "source": "web:https://example.com/page",
                  "retrievedAt": "2026-07-31",
                  "hash": "a3f2c9..." } }
```

| 属性 | 文件（`file:`） | Web（`web:`） | 说明 |
|---|---|---|---|
| `source` | `file:src/core/store.ts` | `web:https://example.com` | 路径或 URL；前缀区分来源域 |
| `retrievedAt` | 导入／读取时间 | 搜索时间 | ISO 日期，供 Agent 判断是否过期 |
| `hash` | 内容 hash（可选） | 页面 hash（可选） | Agent 重查时比较；本地文件可做 diff |

`normalizeMarkers` 会去重并验证属性。Resident protocol 只接受有界标量 marker 属性；CLI 暴露 `--external-source`、`--retrieved-at`、`--content-hash`，Pi 提供 typed `externalSource` 写入字段。

## 4. 三个正交维度

| 维度 | 机制 | 内容 |
|---|---|---|
| Provenance | `external_source` marker | 哪个文件／URL、何时获取；写入时记录的静态来源信息 |
| Trust | `truthStatus: "unverified"` | 外部事实默认未核实；用户确认后可以升级为 verified |
| Rendering | adapter 在模型边界渲染 `[external]` | Agent 看见标记，可按需复核 |

`truthStatus` 与 provenance marker 相互独立：用户确认过的 URL 信息仍保留 `external_source`；trust 可提高，但来源 marker 不移除。Core 保存 marker，adapter 决定如何呈现。建议格式：

```text
[external, unverified] <statement>
  source: https://example.com/page (retrieved 2026-07-31)
```

Pi surface 当前会在 compact search header 与 exact memory expansion 中呈现外部来源标记。若调用方未提供 `truthStatus`，CLI 写入路径会将带外部 marker 的记忆默认为 `unverified`；后续明确确认可以提升 trust，但不会移除 provenance。

## 5. 外部内容入口

### 5.1 Web 搜索结果

搜索结果是 tool output，使用既有 `sourceActor: "tool"`。治理写入策略要求对话证据在用户或工具确认前保持 unverified。不会自动将搜索结果写入记忆；用户确认后写入的事实可带：

```text
sourceActor: "tool"       # 既有字段
sourceRef: URL             # 既有字段，未来可结构化
truthStatus: "unverified" # 用户确认前
eventTime: search date     # 既有字段
 evidence: result excerpt
 markers: [external_source web:...]
```

### 5.2 文件内容

同一规则：文件内容本身不是记忆；关于文件的陈述才是。读取文件属于 tool output。经确认的文件事实可带 `external_source file:path` 和可选 `hash`，便于 Agent 重查时检测变化；本地 diff 通常比 Web 重抓取便宜。

### 5.3 永不进入的内容

- 不把原始搜索结果／文件全文作为记忆；不对外部内容做全文索引。NMG 是 memory layer，不是代码索引器或 crawler。
- 不将没有 marker 的 web-scoped memory 放入 tier 0；外部事实始终带标记。
- 不建立后台 freshness pipeline。

## 6. 与现有机制的关系

| 机制 | 交互方式 |
|---|---|
| Retention candidates | `external_source` 不在 protected kinds (`critical`、`pinned`、`protected`、`safety_constraint`、`user_defined`) 中；外部记忆通常可成为 retention candidate。未来若要保护，现有 allowlist 可用 |
| `sourceRef`（HistoryRecord） | 保持不变；marker 是结构化扩展。未来可将 `sourceRef` 结构化，当前 marker 已可用 |
| Confidence posterior | 外部事实从较低 prior 开始；outcome votes 正常更新 confidence，不移除 provenance |
| File/Web node kinds | 以后可增加 `kind: "file"` 节点；当前 marker 不依赖该节点类型 |
| Tiered disclosure | 外部记忆沿用正常 tiers；provenance marker 与 tier 正交 |

## 7. 明确非目标

- 不做重新验证 scheduler、freshness crawler 或 stale-detection pass。
- 检索时不自动抓取外部内容；Agent 可自行选择重查，NMG 不主动 fetch。
- 不将外部文档内容索引进语义 store。
- 不新增 `web_fact`、`file_fact` 等 memory type；memory type 仍为语义类型（`fact`、`state` 等），`external_source` 仅表示 provenance。

## 当前实现参考

- [`src/core/types.ts`](../../src/core/types.ts)
- [`src/core/store/rows.ts`](../../src/core/store/rows.ts)
- [`src/cli/commands.ts`](../../src/cli/commands.ts)
- [`src/cli/service.ts`](../../src/cli/service.ts)
- [`src/integration/agent-surface.ts`](../../src/integration/agent-surface.ts)
