# 隐藏功能注册表

[English](hidden-features-registry.md) | [简体中文](hidden-features-registry.zh-CN.md) · [术语](hidden-features-registry.terms.yaml)

**常设台账：**任何默认不启用的能力（由环境变量 gate 或模式 flag 控制），无论 owner 或状态为何，都必须在此有一行记录。规则见[决策记录](../decisions/implemented/2026-09-07-register-hidden-features.zh-CN.md)。

添加或变更 gate 的同一改动中，必须同步更新本台账。2026-09-07 的扫描方法：在 `.pi/extensions/nmg`、`dsh/dsh-nmg/src`、`src/` 中搜索 `process.env.NMG_*`，并检查 `src/integration/config.ts` 中的 mode helper（它们通过 `environment` 参数读取，因此字面量 `process.env` 搜索会漏掉）。

## Feature register

请阅读完整职责：[功能注册表](hidden-features-registry/feature-register.zh-CN.md)。

## 约定

- 新增 gate 时同一改动增加一行；gate 名称、默认值、owner、模式集合或状态变化时更新该行。
- 通过 `environment` 参数而非字面量 `process.env.X` 读取的 gate 也必须登记——这类最容易丢失。
- 允许存在 “Planned / open” 行：即使目标能力只剩死链接，也要让它继续可见，避免再次静默消失。