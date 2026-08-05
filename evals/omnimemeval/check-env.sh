#!/usr/bin/env bash
# OmniMemEval 评测环境检查 —— 跑任何评测（LME/pmv2/locomo/halumem）之前先跑这个。
# 一遍过的保障：GPU / bge-server / CUDA torch / env 文件 / wrapper / 残留进程。
# 用法: bash evals/omnimemeval/check-env.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NMG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0; FAIL=0; WARN=0
ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN+1)); }

echo "== OmniMemEval 环境检查 =="

# 1. GPU
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
if [[ -n "$GPU_NAME" ]]; then
    ok "GPU: $GPU_NAME"
else
    bad "无 NVIDIA GPU —— embedding 会 CPU（慢）"
fi

# 2. omni-venv CUDA torch
VENV_PY="$NMG_ROOT/.benchmarks/omni-venv/Scripts/python.exe"
if [[ -x "$VENV_PY" ]]; then
    if "$VENV_PY" -c "import torch; exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
        ok "omni-venv CUDA torch 可用"
        # CUDA 驱动 vs torch 匹配（nvidia-smi 一查就清楚）
        CUDA_UMD="$(nvidia-smi 2>/dev/null | grep -oP 'CUDA UMD Version:\s*\K[\d.]+' | head -1)"
        TORCH_CUDA="$("$VENV_PY" -c "import torch; print(torch.version.cuda or '')" 2>/dev/null)"
        if [[ -n "$CUDA_UMD" && -n "$TORCH_CUDA" ]]; then
            if [[ "${TORCH_CUDA%%.*}" -le "${CUDA_UMD%%.*}" ]]; then
                ok "CUDA 匹配: 驱动 $CUDA_UMD ≥ torch $TORCH_CUDA"
            else
                bad "torch $TORCH_CUDA 需要更高驱动（当前 $CUDA_UMD）——升级驱动或换 cu 版本"
            fi
        else
            warn "CUDA 版本无法比较（驱动=$CUDA_UMD torch=$TORCH_CUDA）"
        fi
    else
        bad "omni-venv 的 torch 无 CUDA（bge-server 会回退 CPU）"
    fi
    "$VENV_PY" -c "import sentence_transformers, fastapi" 2>/dev/null \
        && ok "omni-venv 依赖齐（sentence-transformers/fastapi）" \
        || bad "omni-venv 缺依赖（pip install fastapi \"uvicorn[standard]\"）"
else
    bad "omni-venv 不存在（$VENV_PY）"
fi

# 3. bge-server（8000 + device）
HEALTH="$(curl -s -m 3 localhost:8000/health 2>/dev/null)"
if [[ -n "$HEALTH" ]]; then
    DEV="$(echo "$HEALTH" | "$VENV_PY" -c "import sys,json; print(json.load(sys.stdin).get('device','?'))" 2>/dev/null)"
    case "$DEV" in
        cuda) ok "bge-server health OK (device=cuda)" ;;
        cpu)  bad "bge-server 在 CPU —— 重启: cd evals/omnimemeval && ../../.benchmarks/omni-venv/Scripts/python.exe bge-server.py" ;;
        *)    warn "bge-server health OK 但 device=$DEV（旧 server？重启后才有 device 字段）" ;;
    esac
else
    bad "bge-server 不在 8000 —— 启动: cd evals/omnimemeval && ../../.benchmarks/omni-venv/Scripts/python.exe bge-server.py"
fi

# 4. env 文件
for f in .env.nmg-bgefix; do
    [[ -f "$NMG_ROOT/$f" ]] && ok "env 文件 $f 存在" || bad "env 文件 $f 缺失"
done

# 5. wrapper 脚本
for w in run-lme.sh run-pmv2-quick.sh run-locomo.sh run-halumem.sh; do
    [[ -f "$SCRIPT_DIR/$w" ]] && ok "wrapper $w 存在" || warn "wrapper $w 缺失"
done

# 6. 残留评测进程（文件锁风险——wrapper 的 kill_strays 会自动清）
STRAYS="$(powershell.exe -NoProfile -Command \
    "(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*run_*_eval.sh*' -or \$_.CommandLine -like '*\\longmemeval\\lme_*' -or \$_.CommandLine -like '*\\locomo\\locomo_*' -or \$_.CommandLine -like '*\\halumem\\hm_*' -or \$_.CommandLine -like '*\\omnimemeval\\bridge.ts*' }).Count" 2>/dev/null | tr -d '\r')"
if [[ "${STRAYS:-0}" =~ ^[0-9]+$ ]] && [[ "$STRAYS" -gt 0 ]]; then
    warn "$STRAYS 个残留评测进程 —— 会被 wrapper 的 kill_strays 清掉"
else
    ok "无残留评测进程"
fi

echo ""
echo "== 结果: $PASS 通过 / $FAIL 失败 / $WARN 警告 =="
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
