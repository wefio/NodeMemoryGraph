#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# AutoDL Setup Script — MiniMind-NMG Cloud Training
# ═══════════════════════════════════════════════════════════════════
# 
# Usage on AutoDL:
#   1. Create instance: RTX 4090 (24GB), CUDA 12.x image
#   2. Upload this project directory to /root/autodl-tmp/
#   3. Run: bash cloud/setup.sh
#
# AutoDL pre-installed: CUDA 12.4, Miniconda, git
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_DIR="${1:-/root/autodl-tmp/minimind-nmg}"
cd "$PROJECT_DIR"

echo "=== Step 1: System packages ==="
apt-get update -qq && apt-get install -y -qq curl git wget pigz pv 2>&1 | tail -1

echo "=== Step 2: Install uv ==="
if ! command -v uv &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
echo "uv: $(uv --version)"

echo "=== Step 3: Python environment ==="
uv venv --python 3.11
source .venv/bin/activate

# Install PyTorch with CUDA 12.4 (AutoDL default)
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

# Install other dependencies
uv pip install transformers tqdm onnx onnxruntime onnxconverter-common datasets

# Verify
python -c "import torch; print(f'PyTorch {torch.__version__}, CUDA {torch.version.cuda}, GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}')"
python -c "import transformers; print(f'Transformers {transformers.__version__}')"

echo "=== Step 4: Tokenizer (Qwen3-Embedding-0.6B) ==="
TOKENIZER_DIR="./qwen3-embedding"
if [ ! -d "$TOKENIZER_DIR" ]; then
    echo "Downloading Qwen3-Embedding-0.6B tokenizer..."
    python -c "
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('Qwen/Qwen3-Embedding-0.6B', trust_remote_code=True)
tok.save_pretrained('$TOKENIZER_DIR')
print(f'Tokenizer saved ({tok.vocab_size} vocab)')
"
fi

echo "=== Step 5: Vocab map (if not already present) ==="
VOCAB_MAP="./out/tokenizer/old_to_new.json"
if [ ! -f "$VOCAB_MAP" ]; then
    echo "Building vocab map (Qwen 151k → 32k)..."
    python tokenizer/prune_qwen_vocab.py \
        --tokenizer_dir "$TOKENIZER_DIR" \
        --output "$VOCAB_MAP" \
        --target_size 32000
fi

echo "=== Step 6: Download datasets ==="
DATA_DIR="./out/data"
mkdir -p "$DATA_DIR"

# AllNLI (English NLI: SNLI + MultiNLI)
if [ ! -f "$DATA_DIR/AllNLI.tsv.gz" ]; then
    echo "Downloading AllNLI (981K pairs, ~39MB)..."
    wget -q --show-progress -O "$DATA_DIR/AllNLI.tsv.gz" \
        "https://sbert.net/datasets/AllNLI.tsv.gz" || \
        echo "WARNING: AllNLI download failed — try manual upload"
fi

# LCQMC (Chinese Question Matching)
if [ ! -f "$DATA_DIR/LCQMC_train.txt" ]; then
    echo "Downloading LCQMC (238K pairs)..."
    python -c "
from datasets import load_dataset
ds = load_dataset('shibing624/nli-zh-all', streaming=True)
# ... 
" 2>/dev/null || true

    # Alternative: direct download from modelscope/huggingface mirrors
    echo "Attempting LCQMC via HuggingFace datasets..."
    python -c "
import sys
try:
    from datasets import load_dataset
    # LCQMC is available as 'lcqmc' or through shibing624
    ds = load_dataset('shibing624/nli_zh', 'NLI', trust_remote_code=True, split='train', streaming=True)
    count = 0
    with open('$DATA_DIR/LCQMC_train.txt', 'w', encoding='utf-8') as f:
        for item in ds:
            f.write(f\"{item['sentence1']}\t{item['sentence2']}\t{item['label']}\n\")
            count += 1
    print(f'Saved {count} LCQMC pairs')
except Exception as e:
    print(f'LCQMC via datasets failed: {e}')
    print('Falling back to manual upload...')
    # Create a placeholder - user should upload manually
    with open('$DATA_DIR/LCQMC_train.txt', 'w', encoding='utf-8') as f:
        f.write('# Please upload LCQMC_train.txt manually\n')
" || echo "WARNING: LCQMC download failed — upload manually"
fi

# Chinese NLI (supplement)
if [ ! -f "$DATA_DIR/zh_nli_train.jsonl" ]; then
    echo "Downloading Chinese NLI (shibing624/nli-zh-all)..."
    python -c "
import json
try:
    from datasets import load_dataset
    ds = load_dataset('shibing624/nli-zh-all', 'NLI', trust_remote_code=True, split='train')
    count = 0
    with open('$DATA_DIR/zh_nli_raw.jsonl', 'w', encoding='utf-8') as f:
        for item in ds:
            f.write(json.dumps({
                'sentence1': item['sentence1'],
                'sentence2': item['sentence2'],
                'label': item['label']
            }, ensure_ascii=False) + '\n')
            count += 1
    print(f'Saved {count} Chinese NLI pairs')
except Exception as e:
    print(f'Chinese NLI via datasets failed: {e}')
    print('Falling back...')
" || echo "WARNING: Chinese NLI download failed"
fi

echo "=== Step 7: Convert datasets to training format ==="

# AllNLI → training triples
if [ -f "$DATA_DIR/AllNLI.tsv.gz" ] && [ ! -f "$DATA_DIR/all_nli_train.jsonl" ]; then
    echo "Converting AllNLI (200K triples)..."
    python trainer/convert_allnli.py \
        --input "$DATA_DIR/AllNLI.tsv.gz" \
        --output "$DATA_DIR/all_nli_train.jsonl" \
        --max_pairs 200000
fi

# LCQMC → training triples
if [ -f "$DATA_DIR/LCQMC_train.txt" ] && [ ! -f "$DATA_DIR/lcqmc_train.jsonl" ]; then
    echo "Converting LCQMC (250K triples)..."
    python trainer/convert_lcqmc.py \
        --input "$DATA_DIR/LCQMC_train.txt" \
        --output "$DATA_DIR/lcqmc_train.jsonl" \
        --max_pairs 250000
fi

# Chinese NLI → training triples
if [ -f "$DATA_DIR/zh_nli_raw.jsonl" ] && [ ! -f "$DATA_DIR/zh_nli_train.jsonl" ]; then
    echo "Converting Chinese NLI (150K triples)..."
    python trainer/convert_zh_nli.py \
        --input "$DATA_DIR/zh_nli_raw.jsonl" \
        --output "$DATA_DIR/zh_nli_train.jsonl" \
        --max_pairs 150000
fi

# Merge all
echo "=== Step 8: Merge & balance datasets ==="
python trainer/merge_datasets.py \
    --inputs \
        "$DATA_DIR/all_nli_train.jsonl" \
        "$DATA_DIR/lcqmc_train.jsonl" \
        "$DATA_DIR/zh_nli_train.jsonl" \
    --output "$DATA_DIR/train_full.jsonl" \
    --max_total 500000

TOTAL=$(wc -l < "$DATA_DIR/train_full.jsonl")
echo "=== Ready: $TOTAL training samples ==="
echo ""
echo "Next: bash cloud/train.sh"
