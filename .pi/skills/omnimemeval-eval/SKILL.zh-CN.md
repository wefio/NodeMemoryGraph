---
name: omnimemeval-eval
description: Run or resume NMG's OmniMemEval user-memory benchmarks through the config-driven shared workflow. Use for LongMemEval, LoCoMo, BEAM, PersonaMem v2, HaluMem, benchmark regression checks, or result continuation.
---

# OmniMemEval 评测

首次运行之前、忘记流程之后，或要续跑一次运行时，先读这篇。稳定的
事实来源是 `evals/omnimemeval/benchmark.config.json`；不要在命令行上
重建它的参数。

## 运行

对于走嵌入的运行，先用已经准备好的解释器在另一个终端启动那个本地服务，
然后确认 `/health` 报出 `"device":"cuda"`：

```powershell
.benchmarks/bge-venv/Scripts/python.exe evals/omnimemeval/bge_server.py --device cuda
```

在 Windows 上不要对这个服务使用 `uv run --with`：它可能解析出第二个仅有
CPU 的 PyTorch 环境。只有在你确实想要自动选择 GPU 或 CPU 时才省略
`--device`；要显式走 CPU 就用 `--device cpu`。

```powershell
# Inspect without model or embedding work.
npm run benchmark:omni -- longmemeval --dry-run

# Run one complete official suite.
npm run benchmark:omni -- longmemeval
```

支持的套件名是 `longmemeval`、`locomo`、`beam`、`personamem-v2` 和
`halumem`。runner 会生成唯一版本号、加载配置好的 env 文件、建立
NMG/UTF-8/venv 环境，并委托给被固定版本的官方脚本。

## 一次配置

实验策略变化时，改签入仓库的那份配置：

```json
{
  "envFile": ".env.nmg-opencode",
  "commonArgs": ["--workers", "16", "--llm-workers", "16", "--top-k", "20"],
  "suites": {
    "longmemeval": [],
    "beam": ["--scale", "100k"]
  }
}
```

`commonArgs` 对每个套件生效。`suites.<name>` 只转发该套件的官方选项。
provider key、模型名、嵌入端点和 QPP 配置都保存在 env 文件里。不要把
runner 自有的 `--lib`、`--env`、`--version` 或 `--replay` 标志写进配置。

做一次性 canary 时，复制这份配置并显式选中它：

```powershell
npm run benchmark:omni -- beam --config evals/omnimemeval/canary.config.json
```

不要只为避免修改或复制配置就新增一个 CLI 标志。

## 续跑

指向那个确切的既有结果目录：

```powershell
npm run benchmark:omni -- --resume `
  .benchmarks/official/OmniMemEval/results/lme/nmg-<version>
```

runner 从 `experiment_config.sh` 推断套件与版本，校验该运行属于 NMG，并
拒绝配置参数漂移。它在委托之前移除破坏性生命周期标志；官方流水线从自己的
检查点续跑。不要从相似的目录名推断目标。

## 边界

- 常规 NMG 运行不要直接调用那五个官方脚本。
- 不要为某个套件单独做 NMG wrapper；把官方参数加进配置。
- 官方解析、提示词、打分、检查点和报告都保持在上游。
- 让 NMG 证据审计与官方运行保持分离。
- runner 不启动也不杀掉嵌入服务、Pi、daemon 或 Python 进程。
- 用官方结果制品诊断失败；不要只为修复编排而去调产品检索。

历史分数与事故叙述属于 `docs/experiments/`，不属于这份操作手册。
