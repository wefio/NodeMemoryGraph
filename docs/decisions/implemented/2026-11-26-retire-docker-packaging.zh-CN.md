# 退役未维护的 Docker 打包配置

[English](2026-11-26-retire-docker-packaging.md) · [术语](2026-11-26-retire-docker-packaging.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Supersedes:** [分离 NMG 运行环境与 embedding 环境](../archived/2026-08-24-external-embedding-container.zh-CN.md)

## 问题

仓库此前长期保留了两份内容完全重复且失修的镜像文件（根目录 `Dockerfile` 与 `docker/Dockerfile`）、`.dockerignore`、`docker/entrypoint.sh` 及仅做正则文本匹配的 `tests/docker/container-definition.test.ts`，与当前 NMG 原生轻量路线相矛盾：

1. `npm run build` 已前置执行 `scripts/generate-prompts.ts`，而原镜像只 `COPY src ./src`、未复制 `scripts/`，导致 `docker build .` 必然失败。
2. `docker/entrypoint.sh` 启动的 `nmg daemon run` 只监听 `127.0.0.1` 随机端口并依赖本地租约文件，容器外部的宿主插件无法接入。
3. 默认构建目标拉取 Python 与 CUDA PyTorch（`cu126`）并打包 `evals/omnimemeval/bge_server.py`，容易让外部读者和工具误以为 NMG 需要重型容器环境。

## 决策

移除 `Dockerfile`、`.dockerignore`、`docker/` 与 `tests/docker/`，清理 `package.json` 中的 `tests/docker/**/*.test.ts` 匹配路径，将 `2026-08-24-external-embedding-container` 移入 `docs/decisions/archived/`，统一采用 Node.js 内置 `node:sqlite` 原生运行、`nmg http` 服务及 `onlion` WASM SQLite 部署形态。

## 考虑过的替代方案

1. **修补 `COPY scripts ./scripts` 并将默认 target 切换为纯 Node 的 `external` 镜像**：拒绝，目前并无现实容器分发需求，继续保留无人使用的 `Dockerfile` 仍会再次失修漂移。
2. **仅为评测 Python 脚本保留 `Dockerfile`**：拒绝，评测脚本已在本地原生运行环境直接调用。

## 后果

- 仓库根目录与测试集合不再保留无法构建且与宿主架构脱节的容器配置，与 `README.md` 中的原生零 Docker 定位保持一致。
- 未来如确有往 Linux 服务器容器化部署 `nmg http` 的需求，可届时围绕 `nmg http --config` 重新编写精简镜像，而不再复用 `daemon run`。
