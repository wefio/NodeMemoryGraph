#!/usr/bin/env bash
# One-shot HaluMem eval flow for the NMG bridge: preflight (kill strays, pin
# env), run (or resume) the OmniMemEval halumem pipeline, then analyze.
# Mirror of run-lme.sh for the halumem dataset.
#
# Usage:
#   ./run-halumem.sh --env-file <file> --version <label> [options]
#   ./run-halumem.sh --analyze <results-dir>            # analyze an existing run
#
# Options:
#   --env-file <file>   OmniMemEval env file (e.g. .env.nmg-bgefix). Required.
#   --version <label>   Result version suffix; must match baseline exactly when
#                       doing a no-regression rerun (userId embeds it).
#   --skip-ingest       Reuse existing per-user stores; start at search step.
#   --workers <n>       Search/ingest worker count. Default 1.
#   --llm-workers <n>   Answer/judge concurrency. Default 16.
#   --from-step <n>     Resume from pipeline step n (search=2, answer=3, judge=4).
#   --clear             Pass --clear 1 to ingest (recreates user stores).
#   --analyze <dir>     Skip running; print metrics for an existing run dir.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NMG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OMNI_DIR="$NMG_ROOT/.benchmarks/official/OmniMemEval"

ENV_FILE=""
VERSION=""
SKIP_INGEST=0
CLEAR=0
WORKERS=1
LLM_WORKERS=16
FROM_STEP=""
ANALYZE_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
        --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
        --skip-ingest) SKIP_INGEST=1; shift ;;
        --clear) CLEAR=1; shift ;;
        --workers) WORKERS="${2:?--workers requires a number}"; shift 2 ;;
        --llm-workers) LLM_WORKERS="${2:?--llm-workers requires a number}"; shift 2 ;;
        --from-step) FROM_STEP="${2:?--from-step requires a number}"; shift 2 ;;
        --analyze) ANALYZE_DIR="${2:?--analyze requires a dir}"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; sed -n '2,25p' "$0"; exit 1 ;;
    esac
done

# ────────────────────────────────────────────────────────────────────────────
# Environment pinning (GBK console, NMG_ROOT, venv) - same as run-lme.sh.
# ────────────────────────────────────────────────────────────────────────────
if [[ -x "$NMG_ROOT/.benchmarks/omni-venv/Scripts/python.exe" ]]; then
    export PATH="$NMG_ROOT/.benchmarks/omni-venv/Scripts:$PATH"
fi
export NMG_ROOT PYTHONUTF8=1 PYTHONIOENCODING=utf-8

kill_strays() {
    powershell.exe -NoProfile -Command \
        "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*evals\omnimemeval\bridge.ts*' -or \$_.CommandLine -like '*scripts\halumem\hm_*' -or \$_.CommandLine -like '*run_halumem_eval.sh*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
        >/dev/null 2>&1 || true
}

# ────────────────────────────────────────────────────────────────────────────
# Analyze-only mode
# ────────────────────────────────────────────────────────────────────────────
if [[ -n "$ANALYZE_DIR" ]]; then
    echo "== (no audit script for halumem yet - see exp_report.md)"
    exit 0
fi

if [[ -z "$ENV_FILE" || -z "$VERSION" ]]; then
    echo "--env-file and --version are required" >&2
    exit 1
fi

# ────────────────────────────────────────────────────────────────────────────
# Run
# ────────────────────────────────────────────────────────────────────────────
FROM_STEP_ARGS=()
if [[ -n "$FROM_STEP" ]]; then
    FROM_STEP_ARGS+=(--from-step "$FROM_STEP")
elif [[ "$SKIP_INGEST" == "1" ]]; then
    FROM_STEP_ARGS+=(--from-step 2)
fi
if [[ "$CLEAR" == "1" ]]; then
    FROM_STEP_ARGS+=(--clear 1)
fi

echo "== run: lib=nmg env=$ENV_FILE version=$VERSION workers=$WORKERS llm-workers=$LLM_WORKERS skip-ingest=$SKIP_INGEST =="
cd "$OMNI_DIR"
bash scripts/run_halumem_eval.sh \
    --lib nmg \
    --env "$ENV_FILE" \
    --version "$VERSION" \
    --workers "$WORKERS" \
    --llm-workers "$LLM_WORKERS" \
    "${FROM_STEP_ARGS[@]}"

# ────────────────────────────────────────────────────────────────────────────
# Analyze
# ────────────────────────────────────────────────────────────────────────────
RESULT_DIR="$(ls -dt "$OMNI_DIR/results/halumem/"*"$VERSION"* 2>/dev/null | head -1 || true)"
if [[ -n "$RESULT_DIR" && -f "$RESULT_DIR/nmg_hm_search_results.json" ]]; then
    echo "== (no audit script for halumem yet - see exp_report.md)"
fi
