# 共享披露文案瘦身

[English](2026-10-10-shared-disclosure-copy.md) · [术语](2026-10-10-shared-disclosure-copy.terms.yaml)

**Status:** implemented
**Approved:** auto

## Problem

search/get 每次披露重复行格式图例和字段说明，而候选／证据正文已有具名字段。
这些包装持续占据上下文；削减预览或条数则会把展示改动与信息／检索预算混在一起。

## Decision

只压缩共享 YAML 披露文案，不改变底层 surface。保留解释边界、精确读取和撤回指引，
删除重复行模板及冗余元数据标题。沿用现有生成流程，不添加宿主专属替换策略。
反馈文案仅在可操作调用处写一次完整 graph ID，保留所有已列反馈标签及不猜测边界。
搜索头仍可独立携带同一 ID 用于精确读取，不跨职责删除引用，也不缩短 ID。

规范归 [Agent Surface](../../design/design.md) 所有；
[固定对照](../../experiments/retrieval-quality/shared-output-2026-10-10.md)
记录夹具范围、测量和验证边界；
[UUID 重复对照](../../experiments/retrieval-quality/uuid-dedup-2026-10-11.md)
区分已实施的文案去重与尚未实施的标识符研究。

## Alternatives considered

- 缩短预览、减少候选或引入短 ID：会改变可用信息或检索契约，不在本切片内。
- 新压缩行／表格格式：已有具名行携带数据，不必增加格式兼容工作。
- 删除历史消息或接入宿主压缩钩子：改变历史／缓存行为，而非减小每块体积。
- 删除 nudge 或反馈／claim-outcome 职责：属于独立责任，不是压缩 search/get 包装的必要条件。

## Consequences

使用共享文案的消费者获得更短的后续披露。候选和精确证据正文、结构化 RPC／JSON、
完整 ID、预览上限与选入集合保持不变；裸渲染及调用者自带包装不被重写。
前后文的字面措辞属于展示，不构成 wire 版本。

本改动不证明相关性、任务成功、provider token、缓存命中或 compact 频率改善。
历史消息及正在运行的宿主部署不在本切片范围内。
