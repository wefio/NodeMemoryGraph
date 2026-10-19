# 图作用域内的组合取回引用

[English](2026-10-11-compound-retrieval-reference.md) · [术语](2026-10-11-compound-retrieval-reference.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [共享披露包装](2026-10-10-shared-disclosure-copy.zh-CN.md)

## Problem

完整 UUID 同时占用候选头与精确读取参数的 token。用户批准的是对照 UUID 的
有界试验，不是修改 ID 生成规则或部署。仅按当前内容确认唯一组合，会在内容
修改或记录删除后把原引用错误转移到另一条记录。

## Decision

隔离原型采用图作用域内的 ID 前缀与内容引用，在现有私有检索 projection 内
保留不可变的原始内容见证。格式、身份与失败行为由
[Agent Surface 契约](../../design/design.md) 拥有。
见证是有界 projection 数据，不是新增别名库或耐久记忆。匹配先确定原始身份，
再检查该 canonical ID 的当前内容。普通 get RPC 与共享库函数承担此逻辑，
不增加工具、模型侧解码步骤或宿主本地 resolver。

[固定试验](../../experiments/retrieval-quality/compound-reference-2026-10-11.md)
计入重复引用文本、get 参数、必要图 ID 与工具说明，不要求优于纯短 ID。
存储身份、compact JSON 的 ID、精确证据、归因与生命周期操作 ID 保持完整。

日常采用情况只通过现有 status 的两个内存计数观察，不另设试用或遥测流程。
两种读取形式始终兼容，不增加持久使用日志、新工具或引用选择策略。
计数作用域与生命周期由设计文档拥有。

## Alternatives considered

- 完整 UUID 保留独立、长期读取能力，并作为回退。
- 未检查的截断与仅按当前内容匹配，不能在碰撞或删改后证明原始身份。
- 独立别名库增加新的权威和生命周期；现有会话 projection 已拥有相关读取快照。
- 原生短 ID 或 UUID 编码涉及额外生成与解析决策，超出本次试验。

## Consequences

正常复制引用的固定样本，在指定离线编码下更省 token；完整 ID 的回退路径
仍承担少量静态说明增长。图过期或内容前缀改变可以导致失效，手动 UUID 恢复
会多一次调用，并可能抵消收益。因此组合引用不是长期 UUID 的替代。
后台额外读取也有本地 CPU 成本。本试验不证明相关性、语义信息增益、账单、
缓存、raw JSON 收益或最终传输确认。

## Deferred

合并、部署、重启 daemon 与长期引用策略仍需单独批准。
不运行 live 模型、embedding、完整 benchmark 或账单实验。
