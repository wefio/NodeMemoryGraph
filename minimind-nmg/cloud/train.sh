#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# MiniMind-NMG Cloud Training Script (RTX 4090 / 24GB)
# ═══════════════════════════════════════════════════════════════════
# Run after cloud/setup.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="${1:-/root/autodl-tmp/minimind-nmg}"
cd "$PROJECT_DIR"
source .venv/bin/activate

export PYTHONPATH="$PROJECT_DIR:$PYTHONPATH"

echo "============================================"
echo " MiniMind-NMG Cloud Training"
echo "============================================"
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA {torch.version.cuda}'); print(f'GPU: {torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_memory/1024**3:.0f}GB)')"

python trainer/train_encoder.py \
    --data_path ./out/data/train_full.jsonl \
    --tokenizer_name ./qwen3-embedding \
    --vocab_map ./out/tokenizer/old_to_new.json \
    --output_dir ./out/encoder-cloud \
    \
    --batch_size 64 \
    --grad_accum 2 \
    --max_length 256 \
    --num_epochs 5 \
    --num_workers 4 \
    \
    --hidden_size 512 \
    --num_layers 6 \
    --output_dim 256 \
    \
    --learning_rate 3e-4 \
    --weight_decay 0.01 \
    --temperature 0.05 \
    --margin 0.2 \
    --ranking_weight 0.3 \
    \
    --amp \
    --online_hnm_k 4 \
    --save_steps 2000

echo "=== Training complete ==="
echo "Checkpoints in: ./out/encoder-cloud/"
ls -lh ./out/encoder-cloud/
