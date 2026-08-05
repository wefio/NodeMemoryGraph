#!/usr/bin/env bash
# ============================================================
# run-pmv2-quick.sh —— pmv2 快速评测（固化流程，修 benchmark 基础设施坑）
# ------------------------------------------------------------
# 解决的问题（subagent 跑评测时反复踩的坑）：
#   1. GBK 控制台崩溃（rich 进度条）   -> PYTHONUTF8/PYTHONIOENCODING 提前设
#   2. 全量误跑（5000 用户）           -> 截断 benchmark.csv 限范围（trap 恢复）
#   3. WinError 5 os.replace（~0.4%） -> 失败自动重跑（计算只要 ~1 分钟，重跑便宜）
#   4. 每次手动截断/恢复 csv          -> 脚本内完成（备份 + trap）
#
# 用法:
#   bash evals/omnimemeval/run-pmv2-quick.sh [N] [--llm-workers W]
#     N             问题数（默认 60，即用户 0..59）
#     --llm-workers 并发（默认 16——asyncio 单进程并发 + 原子写，安全）
#
# 注意：必须在主仓库根目录（NodeMemoryGraph）下运行；OMNIMEMEVAL_REPO
#   环境变量指向评测仓库（默认 .benchmarks/official/OmniMemEval）。
# ============================================================
set -euo pipefail

N="${1:-60}"
LLM_WORKERS="16"
for arg in "$@"; do
  case "$arg" in
    --llm-workers=*) LLM_WORKERS="${arg#*=}" ;;
    --llm-workers) shift; LLM_WORKERS="$1" ;;
  esac
done

# 1. 环境（在 python 启动前生效——env 文件里设太晚，解释器已启动）
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

REPO="${OMNIMEMEVAL_REPO:-.benchmarks/official/OmniMemEval}"
cd "$REPO"

CSV="data/personamem_v2/benchmark/text/benchmark.csv"
BACKUP="$CSV.quick-bak"
if [ ! -f "$CSV" ]; then
  echo "✗ benchmark.csv not found: $CSV" >&2
  exit 1
fi

# 2. 范围限制：截断 csv 为表头 + 前 N 数据行（trap 保证恢复）
TOTAL=$(wc -l < "$CSV")
if [ "$N" -lt "$TOTAL" ]; then
  cp "$CSV" "$BACKUP"
  restore() { cp "$BACKUP" "$CSV" && rm -f "$BACKUP"; }
  trap restore EXIT INT TERM
  head -n 1 "$CSV" > "$CSV.tmp"
  sed -n "2,$((N + 1))p" "$CSV" >> "$CSV.tmp"
  mv "$CSV.tmp" "$CSV"
  echo "→ benchmark.csv 截断为 ${N} 行（原 ${TOTAL} 行，跑完自动恢复）"
fi

# 3. 跑评测（失败自动重跑——计算 ~1 分钟/次，重跑比修锁便宜）
#    注意：normal mode 必须 --lib nmg（官方脚本要求）
attempt=0
while :; do
  attempt=$((attempt + 1))
  if bash scripts/run_pmv2_eval.sh --lib nmg --env .env.nmg-bgefix --llm-workers "$LLM_WORKERS"; then
    break
  fi
  echo "⚠️  第 ${attempt} 次尝试失败（WinError 5 / 网络 / 其他），重跑..." >&2
  if [ "$attempt" -ge 3 ]; then
    echo "✗ 连续 3 次失败——停止（结果目录保留，可手动 --from-step 续跑）" >&2
    exit 1
  fi
done

# 4. 最新结果目录
NEWEST=$(ls -dt results/pmv2/nmg-pmv2_* | head -1)
echo ""
echo "✅ 完成：$NEWEST"
echo "   数据集范围: 前 ${N} 问（benchmark.csv 已恢复，$(wc -l < "$CSV") 行）"
echo "   accuracy:   $(python -c "
import json
d = json.load(open('${NEWEST}/nmg_pm_responses.json', encoding='utf-8'))
ok = sum(1 for u in d.values() for r in u.get('results', []) if r.get('is_correct'))
n = sum(1 for u in d.values() for r in u.get('results', []))
print(f'{ok}/{n} = {ok/n:.3f}')
" 2>/dev/null || echo 'n/a')"
