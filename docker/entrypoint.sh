#!/usr/bin/env bash
set -euo pipefail

bge_pid=""
nmg_pid=""

shutdown() {
  trap - EXIT INT TERM
  if [[ -n "$nmg_pid" ]]; then
    kill -TERM "$nmg_pid" 2>/dev/null || true
  fi
  if [[ -n "$bge_pid" ]]; then
    kill -TERM "$bge_pid" 2>/dev/null || true
  fi
  [[ -z "$nmg_pid" ]] || wait "$nmg_pid" 2>/dev/null || true
  [[ -z "$bge_pid" ]] || wait "$bge_pid" 2>/dev/null || true
}
trap shutdown EXIT INT TERM

mkdir -p "$(dirname "$NMG_DB_PATH")"

if [[ "${NMG_EMBED_LOCAL_SERVER:-0}" == "1" ]]; then
  python /app/evals/omnimemeval/bge_server.py &
  bge_pid=$!

  for _ in $(seq 1 120); do
    if python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${BGE_PORT}/health', timeout=1)" \
      >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$bge_pid" 2>/dev/null; then
      wait "$bge_pid"
    fi
    sleep 1
  done

  python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${BGE_PORT}/health', timeout=3)" \
    >/dev/null
fi

node /app/bin/nmg.mjs daemon run --db "$NMG_DB_PATH" &
nmg_pid=$!

if [[ -n "$bge_pid" ]]; then
  set +e
  wait -n "$bge_pid" "$nmg_pid"
  status=$?
  set -e
  exit "$status"
fi

wait "$nmg_pid"
