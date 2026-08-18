#!/usr/bin/env bash
# Unified retrieval-benchmark runner — one entry point for every arm so runs
# stop depending on hand-assembled env. Docs: evals/retrieval/README.md.
#
# Usage:
#   evals/retrieval/bench.sh <arm> <dataset[,dataset...]> [extra run.ts flags]
#   evals/retrieval/bench.sh server
#
# arms:     lexical | hybrid | summaries | stacked (= hybrid + summaries)
# datasets: locomo | beam | longmemeval (comma-separated for several)
#
# Examples:
#   evals/retrieval/bench.sh lexical beam
#   evals/retrieval/bench.sh stacked beam,locomo
#   evals/retrieval/bench.sh lexical longmemeval --full
#   evals/retrieval/bench.sh server          # foreground; run as its own task
#
# LLM provider defaults to the OpenCode Go subscription endpoint
# (OPENCODE_API_KEY in .env; deepseek-v4-flash is included in Go). Override by
# exporting NMG_SUMMARY_BASE_URL / NMG_SUMMARY_MODEL / NMG_SUMMARY_API_KEY
# before calling — e.g. the DeepSeek official endpoint
# (https://api.deepseek.com, model deepseek-chat, DEEPSEEK_API_KEY) as fallback
# when Go quota (5h/$12 · week/$30 · month/$60) is exhausted. Summaries persist
# per store (membersKey fingerprint) and the prompts keep a constant
# system-prefix, so repeat runs hit both our own summary cache and the
# provider's prefix cache instead of regenerating.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "server" ]]; then
  PY="$ROOT/.benchmarks/bge-venv/Scripts/python.exe"
  if [[ ! -x "$PY" ]]; then
    echo "BGE venv missing. Create it once (CUDA torch, ~3GB download):" >&2
    echo "  uv venv .benchmarks/bge-venv" >&2
    echo "  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu126" >&2
    echo "  uv pip install --python .benchmarks/bge-venv/Scripts/python.exe sentence-transformers fastapi \"uvicorn[standard]\"" >&2
    exit 1
  fi
  exec "$PY" evals/omnimemeval/bge-server.py
fi

ARM="${1:?arm required: lexical|hybrid|summaries|stacked|server}"
DATASETS="${2:?dataset(s) required: locomo,beam,longmemeval}"
shift 2

set -a; source .env; set +a

# LLM endpoint (summaries + judge). Zen first, overridable via env.
export NMG_SUMMARY_BASE_URL="${NMG_SUMMARY_BASE_URL:-https://opencode.ai/zen/go/v1}"
export NMG_SUMMARY_MODEL="${NMG_SUMMARY_MODEL:-deepseek-v4-flash}"
export NMG_SUMMARY_API_KEY="${NMG_SUMMARY_API_KEY:-${OPENCODE_API_KEY:-}}"
export NMG_JUDGE_BASE_URL="${NMG_JUDGE_BASE_URL:-$NMG_SUMMARY_BASE_URL}"
export NMG_JUDGE_MODEL="${NMG_JUDGE_MODEL:-$NMG_SUMMARY_MODEL}"
export NMG_JUDGE_API_KEY="${NMG_JUDGE_API_KEY:-$NMG_SUMMARY_API_KEY}"

FLAGS=()
case "$ARM" in
  lexical)   ;;
  hybrid)    FLAGS+=(--hybrid) ;;
  summaries) FLAGS+=(--summaries) ;;
  stacked)   FLAGS+=(--hybrid --summaries) ;;
  *) echo "unknown arm: $ARM" >&2; exit 1 ;;
esac

if [[ "$ARM" == "hybrid" || "$ARM" == "stacked" ]]; then
  set -a; source .env.nmg-bgefix; set +a
  if ! curl -sf -m 5 http://127.0.0.1:8000/health >/dev/null; then
    echo "BGE embedding server is down. Start it as its own task:" >&2
    echo "  evals/retrieval/bench.sh server" >&2
    exit 1
  fi
fi

# LME ingest needs a bigger heap; harmless for the other datasets.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=8192"

LOGDIR="evals/results/retrieval/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date -u +%Y-%m-%dT%H-%M-%SZ)-${ARM}-${DATASETS//,/+}.log"

echo "arm=$ARM datasets=$DATASETS model=$NMG_SUMMARY_MODEL log=$LOG"
node --experimental-strip-types evals/retrieval/run.ts \
  --dataset "$DATASETS" "${FLAGS[@]}" "$@" 2>&1 | tee "$LOG"
