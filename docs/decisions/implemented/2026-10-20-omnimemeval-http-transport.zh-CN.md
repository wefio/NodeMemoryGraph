# 面向已部署记忆服务的 OmniMemEval HTTP 传输

[English](2026-10-20-omnimemeval-http-transport.md) · [Terms](2026-10-20-omnimemeval-http-transport.terms.yaml)

**Status:** implemented
**Approved:** auto

## 问题

本地桥 benchmark 不能测量已部署的 AML Add/Search 服务。复制套件 runner，或从本地数据库检索，会绕过待测的网络、持久化与隔离边界。

## 决策

共享 Python 客户端在默认 NDJSON 子进程之外提供显式启用的 HTTP 传输。[集成 owner](../../../evals/omnimemeval/README.zh-CN.md#集成边界)定义配置、身份映射、响应校验与不支持的操作。HTTP 运行跳过本地 embedding provider 预检，因为该依赖由已部署服务负责。

每个远程 benchmark 用户都有显式实验 namespace。内容派生的 Add 请求标识支持确定性重放，客户端不增加抽取或检索逻辑。凭据留在进程环境中，客户端拒绝重定向，并发送透明的应用 User-Agent，避免普通 API 请求被识别成 Python-urllib。

远程失败通过现有异常／日志路径携带有大小上限、已脱敏的诊断信息，在传输 owner 保留证据，不改变调度或重试策略。仅有 HTTP 状态不能确定 API 错误码；没有保存响应体的历史错误仍保持未知。

## 考虑过的替代方案

- 继续使用本地桥：不能证明已部署服务的行为。
- 每个套件各写一份 HTTP 包装器：会复制传输与协议处理。
- 把 benchmark 删除映射到远程回收：不采用，因为 AML 没有定义 Delete 契约，服务 token 也不代表任意清理授权。
- 把 Add 回执当成物化记录：不采用，因为操作级评分需要 AML 回执未提供的证据。

## 后果

本地与远程 Add/Search 评测共用一个 runner，保留上游解析、答案 prompt、评分与检查点。远程 HaluMem 操作评分及带删除的 streaming 生命周期仍不受支持。namespace 复用仅用于有意的续跑；回收需要另行授权。

合成探针成功只证明连通性及所覆盖的契约。数据集成绩、吞吐、尾延迟与负载下隔离需要各自的实测工件。
