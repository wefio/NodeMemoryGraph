# MiniMind-NMG Cloud Training — Agent Execution Brief

## Prerequisites

- RTX 4090 or similar (≥16GB VRAM), CUDA 12.x, Ubuntu 22.04
- This repo cloned to working directory
- No pre-installed Python packages needed (use `uv`)

## Execution Steps

### 1. Environment

```bash
cd minimind-nmg
uv venv --python 3.11 && source .venv/bin/activate
uv pip install torch --index-url https://download.pytorch.org/whl/cu124
uv pip install transformers tqdm onnx onnxruntime datasets
```

Verify:
```bash
python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
```

### 2. Tokenizer (download once, ~1.2GB)

```bash
python -c "
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('Qwen/Qwen3-Embedding-0.6B', trust_remote_code=True)
tok.save_pretrained('./qwen3-embedding')
"
```

### 3. Vocab Map (generate once)

```bash
python tokenizer/prune_qwen_vocab.py \
    --tokenizer_dir ./qwen3-embedding \
    --output ./out/tokenizer/old_to_new.json \
    --target_size 32000
```

### 4. Datasets

Download to `./out/data/`:

| File | Source | Size |
|---|---|---|
| `AllNLI.tsv.gz` | `https://sbert.net/datasets/AllNLI.tsv.gz` | 39MB |
| `LCQMC_train.txt` | HuggingFace `shibing624/nli-zh-all` or manual upload | ~15MB |
| `zh_nli_raw.jsonl` | HuggingFace `shibing624/nli-zh-all` NLI subset | ~50MB |

Try HuggingFace first, fall back to wget/manual:

```bash
# LCQMC via datasets
python -c "
from datasets import load_dataset
ds = load_dataset('shibing624/nli-zh-all', 'NLI', trust_remote_code=True, split='train')
with open('./out/data/LCQMC_train.txt','w') as f:
    for item in ds:
        f.write(f\"{item['sentence1']}\t{item['sentence2']}\t{item['label']}\n\")
print('OK')
"
```

### 5. Convert to training format

```bash
# AllNLI
python trainer/convert_allnli.py --input ./out/data/AllNLI.tsv.gz --output ./out/data/all_nli_train.jsonl --max_pairs 200000

# LCQMC  
python trainer/convert_lcqmc.py --input ./out/data/LCQMC_train.txt --output ./out/data/lcqmc_train.jsonl --max_pairs 200000

# Chinese NLI (if zh_nli_raw.jsonl exists)
python trainer/convert_zh_nli.py --input ./out/data/zh_nli_raw.jsonl --output ./out/data/zh_nli_train.jsonl --max_pairs 100000

# Merge
python trainer/merge_datasets.py \
    --inputs ./out/data/all_nli_train.jsonl ./out/data/lcqmc_train.jsonl ./out/data/zh_nli_train.jsonl \
    --output ./out/data/train_full.jsonl --max_total 500000
```

### 6. Train

```bash
PYTHONPATH=. python trainer/train_encoder.py \
    --data_path ./out/data/train_full.jsonl \
    --tokenizer_name ./qwen3-embedding \
    --vocab_map ./out/tokenizer/old_to_new.json \
    --output_dir ./out/encoder-cloud \
    --batch_size 64 --grad_accum 2 --max_length 256 \
    --num_epochs 5 --num_workers 4 \
    --online_hnm_k 4 \
    --amp --save_steps 2000
```

Expected: ~30 min/epoch, 2.5h total.

### 7. Export best ONNX

```bash
python export/export_onnx.py --model_dir ./out/encoder-cloud/epoch-5 --output ./out/onnx/encoder-cloud.onnx
```

### 8. Quick sanity check

```bash
python -c "
import torch, json
from model.minimind_encoder import MiniMindEncoder
from transformers import AutoTokenizer

model = MiniMindEncoder.from_pretrained('./out/encoder-cloud/epoch-5').cuda().eval()
tokenizer = AutoTokenizer.from_pretrained('./qwen3-embedding')
with open('./out/tokenizer/old_to_new.json') as f:
    otn = {int(k):v for k,v in json.load(f).items()}
M = max(otn.keys())
lu = torch.full((M+1,),0,dtype=torch.long)
for o,n in otn.items(): lu[o]=n

texts = ['Hello world','Machine learning tutorial','NMG graph database',
         '你好世界','机器学习教程','数据库查询']
enc = tokenizer(texts, padding='max_length', truncation=True, max_length=256, return_tensors='pt')
ids = lu[enc['input_ids'].clamp(0,M)].cuda()
mask = enc['attention_mask'].cuda()
with torch.no_grad():
    emb = model(ids,mask)['embedding'].cpu().numpy()

# Cross-language semantic pairs should be closer than random pairs
en_ml = emb[1]  # 'Machine learning tutorial'
zh_ml = emb[4]  # '机器学习教程'
en_db = emb[2]  # 'NMG graph database'
zh_db = emb[5]  # '数据库查询'
en_hello = emb[0]
zh_hello = emb[3]

print(f'en_ml-zh_ml (cross-lang similar): {en_ml @ zh_ml:.4f}')
print(f'en_db-zh_db (cross-lang similar): {en_db @ zh_db:.4f}')
print(f'en_hello-zh_hello (cross-lang greeting): {en_hello @ zh_hello:.4f}')
print(f'en_ml-zh_hello (unrelated): {en_ml @ zh_hello:.4f}')
print(f'en_ml-en_db (tech vs db): {en_ml @ en_db:.4f}')
"
```
