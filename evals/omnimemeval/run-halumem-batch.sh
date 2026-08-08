#!/usr/bin/env bash
# Batched HaluMem eval for the NMG bridge.
#
# Runs the full HaluMem dataset in batches (default 2 users each) so that:
#   - each batch has its own ingest+search step (--to-step 2), producing
#     per-batch progress and partial results that survive Ctrl-C / crashes,
#   - ingest (the slow / failure-prone step) never runs all users in one shot,
#   - after every batch, one final answer+judge+metric+report pass runs over
#     all accumulated search results (checkpoint resume makes it idempotent).
#
# All batches share one --version (store userId embeds it). Only the very
# first batch passes --clear; later batches must NOT clear or they would wipe
# earlier stores. Rerun with --start-batch <n> to resume after an interrupt.
#
# Usage:
#   ./run-halumem-batch.sh --env-file <file> --version <label> [options]
#
# Options:
#   --env-file <file>   OmniMemEval env file (e.g. .env.nmg-opencode). Required.
#   --version <label>   Result version; shared across all batches. Required.
#   --batch-size <n>    Users per batch. Default 2.
#   --users <n>         Total users to process. Default 20.
#   --start-batch <n>   Batch index to start from (0-based, resume). Default 0.
#   --workers <n>       Ingest/search workers. Default 8.
#   --llm-workers <n>   Answer/judge concurrency. Default 16.
#   --ingest-only       Stop after ingest+search batches (skip final answer/judge).
#   -h|--help           Show this help.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NMG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE=""
VERSION=""
BATCH_SIZE=2
TOTAL_USERS=20
START_BATCH=0
WORKERS=8
LLM_WORKERS=16
INGEST_ONLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
        --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
        --batch-size) BATCH_SIZE="${2:?--batch-size requires a number}"; shift 2 ;;
        --users) TOTAL_USERS="${2:?--users requires a number}"; shift 2 ;;
        --start-batch) START_BATCH="${2:?--start-batch requires a number}"; shift 2 ;;
        --workers) WORKERS="${2:?--workers requires a number}"; shift 2 ;;
        --llm-workers) LLM_WORKERS="${2:?--llm-workers requires a number}"; shift 2 ;;
        --ingest-only) INGEST_ONLY=1; shift ;;
        -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; sed -n '2,40p' "$0"; exit 1 ;;
    esac
done

if [[ -z "$ENV_FILE" || -z "$VERSION" ]]; then
    echo "--env-file and --version are required" >&2
    exit 1
fi

TOTAL_BATCHES=$(( (TOTAL_USERS + BATCH_SIZE - 1) / BATCH_SIZE ))

if [[ "$START_BATCH" -ge "$TOTAL_BATCHES" ]]; then
    echo "start-batch=$START_BATCH >= total-batches=$TOTAL_BATCHES; nothing to do" >&2
    exit 1
fi

echo "== batched run: users=$TOTAL_USERS batch=$BATCH_SIZE batches=$TOTAL_BATCHES start-batch=$START_BATCH env=$ENV_FILE version=$VERSION =="

# Ctrl-C: stop cleanly after the current batch. Completed batches keep their
# stores + search results; rerun with --start-batch <N> to continue.
trap 'echo; echo "!! Interrupted after batch $((BATCH+1))/$TOTAL_BATCHES."; echo "!! Rerun with --start-batch $((BATCH+1)) to continue (or run the final answer/judge via --from-step 3)."; exit 130' INT

BATCH=$START_BATCH
while [[ "$BATCH" -lt "$TOTAL_BATCHES" ]]; do
    START_USER=$(( BATCH * BATCH_SIZE ))
    BATCH_USERS=$BATCH_SIZE
    REMAIN=$(( TOTAL_USERS - START_USER ))
    if [[ "$REMAIN" -lt "$BATCH_USERS" ]]; then
        BATCH_USERS=$REMAIN
    fi
    CLEAR_ARGS=()
    if [[ "$BATCH" -eq 0 && "$START_BATCH" -eq 0 ]]; then
        CLEAR_ARGS=(--clear)
    fi

    echo
    echo "────────────────────────────────────────────────────────────────"
    echo "  [batch $((BATCH+1))/$TOTAL_BATCHES] users ${START_USER}..$((START_USER + BATCH_USERS - 1)) (${BATCH_USERS} users)"
    echo "────────────────────────────────────────────────────────────────"
    cd "$SCRIPT_DIR"
    # --from-step 1 forces ingest/search to actually run: the official script
    # writes .step_1_done/.step_2_done markers after the first batch and would
    # otherwise skip every later batch (0s). --start-user offsets keep each
    # batch touching only its own users, so nothing is ingested twice.
    bash ./run-halumem.sh \
        --env-file "$ENV_FILE" \
        --version "$VERSION" \
        --start-user "$START_USER" \
        --users "$BATCH_USERS" \
        --workers "$WORKERS" \
        --llm-workers "$LLM_WORKERS" \
        --from-step 1 \
        --to-step 2 \
        "${CLEAR_ARGS[@]}"

    echo "== batch $((BATCH+1))/$TOTAL_BATCHES done: users 0..$((START_USER + BATCH_USERS - 1)) ingested+searched =="
    BATCH=$(( BATCH + 1 ))
done

if [[ "$INGEST_ONLY" == "1" ]]; then
    echo "== --ingest-only: stopping after ingest+search. Run --from-step 3 later for answer/judge. =="
    exit 0
fi

echo
echo "== all $TOTAL_BATCHES batches done — final answer+judge+metric+report over accumulated results =="
cd "$SCRIPT_DIR"
bash ./run-halumem.sh \
    --env-file "$ENV_FILE" \
    --version "$VERSION" \
    --workers "$WORKERS" \
    --llm-workers "$LLM_WORKERS" \
    --from-step 3
echo "== batched run complete: $(ls -dt "$NMG_ROOT/.benchmarks/official/OmniMemEval/results/halumem/"*"$VERSION"* | head -1) =="
