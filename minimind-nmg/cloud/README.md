# MiniMind-NMG Cloud Training Guide

## Hardware

| Requirement | Recommended | Minimum |
|---|---|---|
| GPU | RTX 4090 (24GB) | RTX 3090 (24GB) |
| VRAM | ≥16GB | 12GB |
| Disk | 20GB | 10GB |

## Quick Start (AutoDL)

### 1. Create Instance

1. [AutoDL](https://www.autodl.com/) → **Create Instance**
2. GPU: **RTX 4090** (24GB VRAM)
3. Image: **CUDA 12.4 + Miniconda** (Ubuntu 22.04)
4. Data disk: **30GB** (system + datasets + checkpoints)

### 2. Upload Project

```bash
# From your local machine:
cd NodeMemoryGraph
tar czf minimind-nmg.tar.gz minimind-nmg/
scp -P <port> minimind-nmg.tar.gz root@<host>:/root/autodl-tmp/
```

Or use AutoDL's built-in file upload (via JupyterLab or web terminal).

### 3. Setup & Train

```bash
ssh -p <port> root@<host>

cd /root/autodl-tmp
tar xzf minimind-nmg.tar.gz
cd minimind-nmg

# One-time setup (~10 min, downloads datasets & tokenizer)
bash cloud/setup.sh

# Train (~2-3 hours for 500K pairs × 5 epochs)
bash cloud/train.sh

# Export ONNX (~1 min)
bash cloud/export.sh epoch-5
```

### 4. Download Results

```bash
# ONNX model (~142MB)
scp -P <port> root@<host>:/root/autodl-tmp/minimind-nmg/out/onnx/encoder-cloud.onnx .

# All checkpoints (~740MB)
scp -r -P <port> root@<host>:/root/autodl-tmp/minimind-nmg/out/encoder-cloud/ .
```

## Dataset Composition

| Dataset | Pairs | Language | Type |
|---|---|---|---|
| AllNLI | 200K | English | SNLI + MultiNLI entailment |
| LCQMC | 250K | Chinese | Question matching |
| Chinese NLI | 150K | Chinese | NLI entailment/contradiction |
| **Total** | **~500K** | **EN+ZH** | **Balanced** |

## Training Config (RTX 4090)

| Parameter | Value | Notes |
|---|---|---|
| batch_size | 64 | Per-GPU |
| grad_accum | 2 | Effective batch = 128 |
| max_length | 256 | Sweet spot for 24GB VRAM |
| epochs | 5 | ~30 min/epoch |
| learning_rate | 3e-4 | Cosine schedule w/ 10% warmup |
| temperature | 0.05 | InfoNCE |
| amp | true | FP16 mixed precision |

Expected training time: **2-3 hours total**.

## Cost Estimate (AutoDL)

| GPU | Price/Hour | Train Time | Cost |
|---|---|---|---|
| RTX 4090 | ¥1.64 | 3h | **≈¥5** |
| RTX 3090 | ¥1.18 | 4h | ≈¥5 |
| A6000 | ¥2.50 | 3h | ≈¥8 |

## Alternative Platforms

### Vast.ai
```bash
# Search: RTX 4090, CUDA 12.4, min 24GB VRAM
# Price: ~$0.30/hr
# Upload same tarball, run setup.sh + train.sh
```

### RunPod
```bash
# Template: PyTorch 2.4 + CUDA 12.4
# GPU: RTX 4090 ($0.44/hr)
# Same workflow
```

## Troubleshooting

### OOM (Out of Memory)
Reduce `--batch_size 64` → `32` and `--grad_accum 2` → `4` (same effective batch).

### Dataset download fails
Some datasets require authentication. Manually download:
- **LCQMC**: `https://huggingface.co/datasets/shibing624/nli-zh-all`
- **AllNLI**: `https://sbert.net/datasets/AllNLI.tsv.gz`

Place them in `./out/data/` and re-run setup.

### torch.compile errors
Add `--no_compile` flag. Not all PyTorch versions support `torch.compile` on all GPUs.
