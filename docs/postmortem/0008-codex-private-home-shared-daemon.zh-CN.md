# 私有 Codex home 连接到了共享 NMG daemon

[English](0008-codex-private-home-shared-daemon.md) · [术语](0008-codex-private-home-shared-daemon.terms.yaml)

**Status:** resolved

## Executive summary

分发包探针在父进程环境设置私有 NMG 目录，Codex 却从 MCP 子进程过滤了该变量。
Hook 连接私有 owner，显式工具回落到默认 owner。身份检查通过，状态承载失败。
修复显式传递数据目录，并验证各写入路径实际到达私有 daemon。

## Summary

并发测试聊天在不同 daemon 上使用了正确原生 ID。共享 owner 接收了两条合成记忆及
临时 AG／在场记录，私有 owner 的请求日志只有 hook，没有显式工具写入。

## Impact

核对合成记忆的精确 ID 与内容后，已通过 resolveRemember 撤回。九个测试 AG 已释放。
较旧的共享 daemon 缺少撤下在场操作，临时注册通过心跳过期处理。
探针使用本地确定性响应，保留既有用户记录。

## Timeline

分发包安装与显式工具成功，恢复时缺少经 MCP 写入的 Owner 状态。
检查私有 RPC 日志及原生输出后发现 owner 分离。修正的包在同一私有 daemon 上通过
并发聊天、恢复、分叉、自动召回和显式写入检查。

## Root cause

CODEX_HOME 隔离宿主状态，MCP 子进程环境继承则由另一层控制。
实现假定 NMG_DATA_DIR 能跨越该边界。此前检查确认身份和输出文本，却没有确认接收写入的 daemon。

## Guardrails added

- [插件清单](../../codex-plugin/.mcp.json)显式传递 NMG_DATA_DIR。
- [分发契约测试](../../tests/scripts/build-codex-plugin.test.ts)检查传递变量及打包启动。
- [原生探针](../experiments/runtime/codex-distribution-probe.mjs)要求在私有 RPC 日志中看到
  显式状态写入与合成记忆保存。

## Lessons

测试启动多个子运行时的宿主时，需要验证每个组件的副作用接收方。会话身份无法单独确定存储位置。
