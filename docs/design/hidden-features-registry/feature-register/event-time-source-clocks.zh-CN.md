# 历史事件来源时钟

[English](event-time-source-clocks.md) · [术语](event-time-source-clocks.terms.yaml)

**权威范围：**[功能注册表](../feature-register.zh-CN.md)。

## 注册选项

| 功能 | Gate／开关 | 默认值 | 含义摘要 | 状态／owner |
| --- | --- | --- | --- | --- |
| 历史事件来源时钟 | `referenceTime`、`timeZone`；RPC 能力 `event-time-reference`；CLI `--reference-time`、`--time-zone` | 未设置；采用写入时钟和宿主本地时区 | 按各来源日历解释显式事件短语，保留写入时间；客户端拒绝向缺少能力的旧 owner 发送该类写入 | 隔离契约验证；真实部署和 benchmark 未执行；[来源时钟契约](../../design/event-time-source-clocks.zh-CN.md) |
