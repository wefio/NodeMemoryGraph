# 分离 NMG 运行环境与 embedding 环境

[English](2026-08-24-external-embedding-container.md)

**Status:** implemented

## 问题

原 Docker 镜像同时包含 NMG、Python、CUDA 版 PyTorch、Triton、sentence-transformers 和 BGE-small。NMG 应用与模型本身较小，但 GPU 运行环境使 Docker Desktop 的存储统计达到约 11.62 GB。已有本地或在线 embedding 服务的用户仍要承担全部体积。

## 决策

在同一 Dockerfile 中构建两个运行 target：

- `external` 只包含 Node/NMG，可纯 FTS 运行，也可连接外部 OpenAI-compatible embedding provider；不包含 Python、PyTorch、CUDA 或模型权重。
- `bge` 在同一 NMG runtime 上叠加固定版本的本地 BGE 服务。它仍是最终及默认 target，保持现有 `docker build .` 行为兼容。

共享 entrypoint 仅在镜像设置 `NMG_EMBED_LOCAL_SERVER=1` 时启动本地 embedding。外接版健康检查只负责 NMG daemon；独立 provider 故障不应把持久记忆库标记为死亡。

## 考虑过的替代方案

- 只提供 CPU 与 CUDA 版本：已有 provider 的用户仍被迫携带 embedding 环境和模型。
- 立即把 external 设为隐式默认：体积更小，但会静默改变已有构建命令的含义。
- 维护两个 Dockerfile：会复制 NMG runtime，更容易发生依赖与 entrypoint 漂移。

## 后果

推荐的集成基础镜像是 `nmg:external`，自包含 BGE 镜像继续作为便利选择。external target 若要语义检索需要显式配置 provider，但无配置时仍可使用 FTS。Python benchmark 辅助工具有意不放入该运行镜像。
