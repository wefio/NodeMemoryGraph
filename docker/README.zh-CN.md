# NMG 容器

Dockerfile 提供一个轻量 NMG 运行时和一个自包含本地嵌入镜像。两者都只为一个
挂载的数据库运行恰好一个 NMG daemon。

## 外部 provider 镜像（推荐的基础镜像）

`external` target 只包含 Node.js 和 NMG。它刻意排除了 Python、PyTorch、CUDA、
sentence-transformers 和模型权重。没有嵌入配置时它使用内置的 SQLite FTS5
检索。

```sh
docker build --target external -t nmg:external .
docker run --rm --name nmg -v nmg-data:/data nmg:external
```

要使用 OpenAI 兼容的嵌入服务，提供它的 URL 和模型。从 Docker Desktop 容器
出发，`host.docker.internal` 可以访问运行在 Windows 或 macOS 宿主机上的服务：

```sh
docker run --rm --name nmg \
  -v nmg-data:/data \
  -e NMG_EMBED_BASE_URL=http://host.docker.internal:8000/v1 \
  -e NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5 \
  -e NMG_EMBED_PROFILE=bge-en \
  nmg:external
```

在 Linux 上，把两个容器放进同一个用户自定义 Docker 网络，并在
`NMG_EMBED_BASE_URL` 里用嵌入容器的名字，或显式映射宿主网关。认证可以用
`NMG_EMBED_API_KEY` 提供。

外部 provider 刻意位于本容器健康边界之外：健康检查只验证 NMG daemon。
provider 故障时 FTS 检索得以保留，失败的嵌入工作保持可观察、可重试，而不是
把记忆库本身标记为死亡。

## 自包含本地 BGE 镜像

最终/默认的 `bge` target 在构建期间下载固定版本的 BGE-small 模型，并把它与
NMG 一起运行。运行时启动不需要模型网络访问。它默认的启用 CUDA 的 PyTorch
栈体积很大，因为即使运行时回退到 CPU，它也包含 CUDA 库、Torch 和 Triton。

```sh
docker build -t nmg:bge .
docker run --rm --name nmg -v nmg-data:/data nmg:bge
```

在配置了 NVIDIA Container Toolkit 时使用 NVIDIA GPU：

```sh
docker run --rm --name nmg --gpus all -v nmg-data:/data nmg:bge
```

更小的自包含纯 CPU 镜像：

```sh
docker build \
  --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu \
  -t nmg:bge-cpu .
```

BGE 启动日志会报出 `device=cuda` 或 `device=cpu`。该 target 的健康检查同时
覆盖本地嵌入端点和 NMG daemon。

## 嵌入同步

两个 target 都启用 `NMG_EMBED_AUTO_SYNC=1`：在配置了嵌入 provider 时，每次
被接受的 `remember` 都会安排一次增量、去重的记录索引更新。在这些镜像之外，
自动同步仍是可选加入的，因此 provider 配置不会静默改变普通的宿主机安装。

provider 配置与索引行为见[在线嵌入设计](../docs/design/online-embeddings.md)。

## 进程与存储边界

- 一个容器为 `/data/nmg.sqlite` 启动一个 NMG daemon。
- 数据库租约拒绝同库的第二个 daemon。
- 每个容器使用独立卷时支持多容器。
- Agent 与会话共享同一个 daemon，并使用 NMG 的所有权/作用域边界；它们不会
  每个会话启动一个 daemon。
- Python benchmark helper 属于评测环境，在 `external` 运行时镜像里不可用。

这些是可复现的 NMG 运行时，不是 Agent Memory Leaderboard 的 Add/Search server。
benchmark adapter 应通过既有的 daemon 客户端接入，而不是对同一个 SQLite 数据库
打开第二个 `NmgService`。
