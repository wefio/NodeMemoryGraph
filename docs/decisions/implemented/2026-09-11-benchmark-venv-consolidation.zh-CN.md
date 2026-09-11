# 一个 benchmark venv，以及一条能移动的 venv 路径

[English](2026-09-11-benchmark-venv-consolidation.md)

**Status:** implemented  
**Approved:** explicit

## 问题

`.benchmarks/` 下曾有两个虚拟环境，两个都装着 CUDA 版 torch：`omni-venv`（Python 3.12，3.5 GB，官方 runner 的依赖）和 `bge-venv`（Python 3.13，4.4 GB，本地 BGE 嵌入服务）。仓库里没有任何地方记录过它们是怎么建的——没有安装步骤、没有 setup 脚本、没有一句说明——所以对它们内容的唯一描述就是那两个目录本身。

harness 用硬编码路径找第一个：`evals/omnimemeval/run.ts` 在 `existsSync` 守卫内把 `.benchmarks/omni-venv/Scripts` 前置进 `PATH`，而 `evals/halumem/score.ts` 默认用它下面的 `python.exe`、不存在就抛错。

于是在一次磁盘清理里删掉 `omni-venv` 会造成两种不同的失败。`eval:halumem:score` 是响亮地失败。`benchmark:omni` 则是**静默地**用 `PATH` 上恰好存在的那个 `python` 跑——用错解释器跑出来的不是错误，是错的数字。而那些写了已删 venv 名字的 docstring 和 README 是第三种失败：它们只是错了。

## 决策

一个 venv 兼两职：`.benchmarks/bge-venv`（Python 3.13，`torch 2.13.0+cu126`），把官方 runner 的 `requirements_user_memory.txt` 装进它。

- `evals/omnimemeval/run.ts` 从 `NMG_BENCH_VENV` 读 venv 目录名，默认 `bge-venv`；缺失时往 stderr 打一行警告，**不再静默回退**。
- `evals/halumem/score.ts` 默认指向同一个 venv；`--python` 和 `NMG_HALUMEM_PYTHON` 仍可覆盖。
- `evals/omnimemeval/README.md` 记录这个 venv 里有什么、怎么重建，以及下面那个 torch 陷阱；research 脚本的 docstring 写明同一个路径。
- 该门登记在 `docs/design/hidden-features-registry.md`。

## 考虑过的替代方案

**重建一个瘦 `omni-venv`，用 CPU 版 torch。** 不改代码，那两条硬编码路径也会自己恢复。否掉的原因是它保留了两个环境，并且要重新下载 torch、transformers、scipy、scikit-learn——而正是这份重复让两个目录难以分辨。

**用目录 junction 把 `.benchmarks/omni-venv` 指向 `bge-venv`。** 同样不改代码，但 junction 会被当成目录，于是引发这次事故的清理遍历（对 `.benchmarks/` 的 `rm -rf`）会顺着它进到真 venv 里。复用造成问题的机制不算修好。

**把 `requirements_agentbench.txt` 也装进去。** 那个文件会带来 `swebench`、`pyserini`（要 Java）、`faiss-cpu`、来自 git 的 `tevatron`，以及 `accelerate`/`peft`；只有 BEAM 那套用它，别的不需要，而装它会在一个正在工作的 CUDA 环境里改写 `transformers` 周边版本。留到真要跑那套的时候再说。

**让代码继续指向 `omni-venv`，用环境变量迁移。** 否掉，因为它保留了本记录要消除的那个静默回退失败模式。

## 后果

- 磁盘上只有一个 CUDA torch，而不是两个。
- harness 仍然需要一个 torch：官方评审依赖里有 `sentence-transformers` 和 `bert-score`。如果哪天环境收窄到 CPU 版 torch 也够用——`bge_server.py` 只在省略 `--device` 或传 `cuda` 时选 CUDA，而显式 `--device cuda` 在没有 CUDA 时会响亮失败，不会降级。
- `fsspec` 从 2026.7.0 变成 2026.6.0，因为 `datasets` 要求如此；之后重新验证过嵌入链路（加载模型并在 `cuda:0` 上编码）。
- 两份 requirements 里的 `torch` 和 `torchvision` 都没钉版本。用 `-r` 装它们有可能把 CUDA 版换成 PyPI 默认版，所以 README 告诉读者排除它们、改用 CUDA 索引装 torch。
- 环境本身不在 git 里（`.benchmarks/` 被忽略），所以本记录和 README 那一节是对该 venv 内容的唯一描述。
- 检查能看见的部分是登记行和路径默认值；「该 venv 存在且是正确的那个」仍然是个本地条件。
