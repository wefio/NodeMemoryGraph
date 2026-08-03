#!/usr/bin/env bash
# One-shot LongMemEval experiment flow for the NMG bridge: preflight (kill
# strays, pin env), run (or resume) the OmniMemEval pipeline, then analyze the
# judged results. Every knob used in prior ad-hoc runs is fixed here so the
# recipe stops changing between experiments.
#
# Usage:
#   ./run-lme.sh --env-file <file> --version <label> [options]
#   ./run-lme.sh --analyze <results-dir>            # analyze an existing run
#
# Options:
#   --env-file <file>   OmniMemEval env file (e.g. .env.nmg-bgefix). Required.
#   --version <label>   Result version suffix; must be unique per experiment.
#   --skip-ingest       Reuse existing per-user stores; start at the search
#                       step (--from-step 2). Only valid when the stores are
#                       known to match this version's data (same corpus).
#   --workers <n>       Search/ingest worker count. Default 1: parallel bridge
#                       processes race on the embedding cache schema lock.
#   --llm-workers <n>   Answer/judge concurrency. Default 6.
#   --clear             Pass --clear 1 to ingest (recreates user stores).
#   --analyze <dir>     Skip running; print metrics for an existing run dir.
#
# Examples:
#   ./run-lme.sh --env-file .env.nmg-bgefix --version fixed20_rerun
#   ./run-lme.sh --env-file .env.nmg-bgefix --version fixed20_rerun --skip-ingest
#   ./run-lme.sh --analyze results/lme/nmg-lme500_fixed20_rerun

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NMG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OMNI_DIR="$NMG_ROOT/.benchmarks/official/OmniMemEval"

ENV_FILE=""
VERSION=""
SKIP_INGEST=0
CLEAR=0
WORKERS=1
LLM_WORKERS=6
ANALYZE_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
        --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
        --skip-ingest) SKIP_INGEST=1; shift ;;
        --clear) CLEAR=1; shift ;;
        --workers) WORKERS="${2:?--workers requires a number}"; shift 2 ;;
        --llm-workers) LLM_WORKERS="${2:?--llm-workers requires a number}"; shift 2 ;;
        --analyze) ANALYZE_DIR="${2:?--analyze requires a dir}"; shift 2 ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; sed -n '2,24p' "$0"; exit 1 ;;
    esac
done

# ────────────────────────────────────────────────────────────────────────────
# Environment that prior ad-hoc runs repeatedly lost (GBK console, NMG_ROOT
# loaded too late for nmg_client imports). Pin it up front.
# ────────────────────────────────────────────────────────────────────────────
export NMG_ROOT PYTHONUTF8=1 PYTHONIOENCODING=utf-8

kill_strays() {
    # Node bridge subprocesses and pipeline python processes left over from a
    # crashed run hold the embedding cache / user store files open. Match on
    # distinctive substrings only (never broad node.exe kills).
    powershell.exe -NoProfile -Command \
        "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*evals\omnimemeval\bridge.ts*' -or \$_.CommandLine -like '*scripts\longmemeval\lme_*' -or \$_.CommandLine -like '*run_lme_eval.sh*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
        >/dev/null 2>&1 || true
}

if [[ -n "$ANALYZE_DIR" ]]; then
    if [[ ! -f "$ANALYZE_DIR/nmg_lme_judged.json" ]]; then
        echo "No nmg_lme_judged.json in $ANALYZE_DIR" >&2
        exit 1
    fi
    python "$SCRIPT_DIR/audit-lme-judged.py" "$ANALYZE_DIR/nmg_lme_judged.json"
    node "$SCRIPT_DIR/experiment-manifest.mjs" --result-dir "$ANALYZE_DIR"
    exit 0
fi

if [[ -z "$ENV_FILE" || -z "$VERSION" ]]; then
    echo "--env-file and --version are required" >&2
    exit 1
fi
if [[ ! -f "$OMNI_DIR/$ENV_FILE" ]]; then
    echo "Env file not found: $OMNI_DIR/$ENV_FILE" >&2
    exit 1
fi

# ────────────────────────────────────────────────────────────────────────────
# Preflight
# ────────────────────────────────────────────────────────────────────────────
echo "== preflight =="
kill_strays
echo "  strays killed"

# Embedding cache coverage: warn if the bge-en index has no vectors yet (first
# run of a corpus), so the caller can start bge_server instead of failing mid-search.
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.NMG_ROOT + "/.benchmarks/omnimemeval-nmg/embedding-cache.sqlite", { readOnly: true });
try {
  const rows = db.prepare("SELECT index_id, input_kind, COUNT(*) c FROM embedding_cache GROUP BY index_id, input_kind").all();
  for (const r of rows) console.log(`  cache ${r.index_id} ${r.input_kind}=${r.c}`);
} catch (e) {
  console.log("  embedding cache: not present yet (" + e.message + ")");
}
' 2>/dev/null || true

if [[ "$SKIP_INGEST" == "1" ]]; then
    newest="$(powershell.exe -NoProfile -Command "Get-ChildItem '$NMG_ROOT/.benchmarks/omnimemeval-nmg/*.sqlite' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty LastWriteTime" 2>/dev/null | tr -d '\r')"
    echo "  newest user store: $newest"
fi

# ────────────────────────────────────────────────────────────────────────────
# Run
# ────────────────────────────────────────────────────────────────────────────
FROM_STEP_ARGS=()
if [[ "$SKIP_INGEST" == "1" ]]; then
    FROM_STEP_ARGS+=(--from-step 2)
fi
if [[ "$CLEAR" == "1" ]]; then
    FROM_STEP_ARGS+=(--clear 1)
fi

echo "== run: lib=nmg env=$ENV_FILE version=$VERSION workers=$WORKERS llm-workers=$LLM_WORKERS skip-ingest=$SKIP_INGEST =="
cd "$OMNI_DIR"
bash scripts/run_lme_eval.sh \
    --lib nmg \
    --env "$ENV_FILE" \
    --version "$VERSION" \
    --workers "$WORKERS" \
    --llm-workers "$LLM_WORKERS" \
    "${FROM_STEP_ARGS[@]}"

# ────────────────────────────────────────────────────────────────────────────
# Analyze
# ────────────────────────────────────────────────────────────────────────────
RESULT_DIR="$(ls -dt "$OMNI_DIR/results/lme/"*"$VERSION"* 2>/dev/null | head -1 || true)"
if [[ -n "$RESULT_DIR" && -f "$RESULT_DIR/nmg_lme_judged.json" ]]; then
    echo "== metrics: $RESULT_DIR =="
    python "$SCRIPT_DIR/audit-lme-judged.py" "$RESULT_DIR/nmg_lme_judged.json"
    echo "== manifest: $RESULT_DIR/experiment_manifest.json =="
    node "$SCRIPT_DIR/experiment-manifest.mjs" \
        --result-dir "$RESULT_DIR" \
        --env-file "$OMNI_DIR/$ENV_FILE"
else
    echo "No judged results found for version $VERSION" >&2
    exit 1
fi
