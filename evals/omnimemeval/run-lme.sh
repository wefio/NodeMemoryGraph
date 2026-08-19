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
#   --from-step <n>    Resume from pipeline step n (search=2, answer=3, judge=4).
#   --prune-stores     After the run, delete user stores from all other runs
#                      (keeps this run's stores + the shared embedding cache).
#   --analyze <dir>    Skip running; print metrics for an existing run dir.
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
FROM_STEP=""
PRUNE=0
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
        --prune-stores) PRUNE=1; shift ;;
        --analyze) ANALYZE_DIR="${2:?--analyze requires a dir}"; shift 2 ;;
        -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; sed -n '2,28p' "$0"; exit 1 ;;
    esac
done

# ────────────────────────────────────────────────────────────────────────────
# Environment that prior ad-hoc runs repeatedly lost (GBK console, NMG_ROOT
# loaded too late for nmg_client imports). Pin it up front. Prefer the
# benchmark venv so nltk (judge metrics) and sentence-transformers resolve.
# ────────────────────────────────────────────────────────────────────────────
if [[ -x "$NMG_ROOT/.benchmarks/omni-venv/Scripts/python.exe" ]]; then
    export PATH="$NMG_ROOT/.benchmarks/omni-venv/Scripts:$PATH"
fi
export NMG_ROOT PYTHONUTF8=1 PYTHONIOENCODING=utf-8

kill_strays() {
    # Node bridge subprocesses and pipeline python processes left over from a
    # crashed run hold the embedding cache / user store files open. Match on
    # distinctive substrings only (never broad node.exe kills).
    powershell.exe -NoProfile -Command \
        "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*evals\omnimemeval\bridge.ts*' -or \$_.CommandLine -like '*scripts\longmemeval\lme_*' -or \$_.CommandLine -like '*run_lme_eval.sh*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
        >/dev/null 2>&1 || true
}

prune_stores() {
    # User stores are keyed by sha256(userId); userId embeds the version label,
    # so every run creates ~500 fresh 12MB stores and they are never reused.
    # Keep only the stores of the current run (identifiable from its search
    # results) plus the shared embedding cache; drop historical stores and any
    # orphaned -shm/-wal files. Without this the eval dir grows ~50GB/year of
    # intermediate stores that ingestion can always rebuild.
    local search_json="$1"
    if [[ ! -f "$search_json" ]]; then
        echo "  prune: no search results, skipping"
        return 0
    fi
    python - "$search_json" "$NMG_ROOT/.benchmarks/omnimemeval-nmg" <<'PY'
import hashlib, json, os, sys
search_json, data_dir = sys.argv[1], sys.argv[2]
users = set()
for uid, entries in json.load(open(search_json, encoding="utf-8")).items():
    users.add(uid)
    for e in entries:
        if e.get("user_id"): users.add(e["user_id"])
keep = {hashlib.sha256(u.encode()).hexdigest()[:24] for u in users if u}
removed = freed = 0
for f in os.listdir(data_dir):
    p = os.path.join(data_dir, f)
    if not os.path.isfile(p):
        continue
    if f.endswith(".sqlite") and f != "embedding-cache.sqlite":
        if f[:-7] in keep:
            continue
    elif not f.endswith(("-shm", "-wal")):
        continue
    try:
        freed += os.path.getsize(p)
        os.remove(p)
        removed += 1
    except OSError:
        pass
print(f"  prune: removed {removed} stale store files, freed {freed/1e9:.2f} GB")
PY
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
const db = new DatabaseSync(process.env.NMG_ROOT + "/.benchmarks/shared-embedding-cache.sqlite", { readOnly: true });
try {
  const rows = db.prepare("SELECT index_id, input_kind, COUNT(*) c FROM embedding_cache GROUP BY index_id, input_kind").all();
  for (const r of rows) console.log(`  cache ${r.index_id} ${r.input_kind}=${r.c}`);
} catch (e) {
  console.log("  embedding cache: not present yet (" + e.message + ")");
}
' 2>/dev/null || true

if [[ "$SKIP_INGEST" == "1" ]]; then
    newest="$(powershell.exe -NoProfile -Command "Get-ChildItem '${NMG_ROOT}/.benchmarks/omnimemeval-nmg/*.sqlite' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty LastWriteTime" 2>/dev/null | tr -d '\r')" || true
    echo "  newest user store: ${newest:-unknown}"
    echo "  WARNING: user stores are keyed by sha256(userId) and userId embeds the"
    echo "           version label, so --skip-ingest only reuses data when the"
    echo "           store belongs to THIS version (resume/crash-recovery)."
    echo "           For a fresh version it yields empty contexts; drop"
    echo "           --skip-ingest to ingest."
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
    if [[ "$PRUNE" == "1" ]]; then
        echo "== pruning stale user stores =="
        prune_stores "$RESULT_DIR/nmg_lme_search_results.json"
    fi
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
