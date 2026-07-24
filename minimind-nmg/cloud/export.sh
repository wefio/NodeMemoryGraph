#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# ONNX Export — run after training completes
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="${1:-/root/autodl-tmp/minimind-nmg}"
CHECKPOINT="${2:-epoch-5}"  # default: last epoch
cd "$PROJECT_DIR"
source .venv/bin/activate

export PYTHONPATH="$PROJECT_DIR:$PYTHONPATH"

EPOCH_DIR="./out/encoder-cloud/$CHECKPOINT"
if [ ! -d "$EPOCH_DIR" ]; then
    echo "Checkpoint not found: $EPOCH_DIR"
    echo "Available:"
    ls -d ./out/encoder-cloud/*/
    exit 1
fi

echo "Exporting $CHECKPOINT to ONNX..."

python export/export_onnx.py \
    --model_dir "$EPOCH_DIR" \
    --output "./out/onnx/encoder-cloud.onnx" \
    --opset 17

echo "=== Export complete ==="
ls -lh ./out/onnx/
echo ""
echo "Download: scp -P <port> root@<host>:/root/autodl-tmp/minimind-nmg/out/onnx/encoder-cloud.onnx ."
