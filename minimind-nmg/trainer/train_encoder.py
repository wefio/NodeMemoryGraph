"""Training script for MiniMind-NMG Encoder — hardware-optimized for RTX 3060 Laptop (6GB)."""

import argparse
import json
import math
import os
import sys
import time

import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ═══════════════════════════════════════════════════════════════════
# Hardware profile
# ═══════════════════════════════════════════════════════════════════

def print_hardware():
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        print(f"GPU: {p.name} ({p.total_memory/1024**3:.1f} GB)")
        print(f"CUDA: {torch.version.cuda}, Compute: {p.major}.{p.minor}")
        print(f"TF32: {'enabled' if torch.backends.cuda.matmul.allow_tf32 else 'disabled'}")
        print(f"Flash SDPA: {hasattr(F, 'scaled_dot_product_attention')}")
        print(f"torch.compile: supported" if hasattr(torch, 'compile') else "torch.compile: N/A")
    else:
        print("GPU: N/A (CPU training)")

# ═══════════════════════════════════════════════════════════════════
# Model
# ═══════════════════════════════════════════════════════════════════

def create_model(hidden_size=512, num_layers=6, output_dim=256,
                 vocab_size=152064, max_length=2048, use_activation_head=False):
    from model.minimind_encoder import MiniMindEncoderConfig, MiniMindEncoder
    return MiniMindEncoder(MiniMindEncoderConfig(
        hidden_size=hidden_size, num_hidden_layers=num_layers,
        output_dim=output_dim, vocab_size=vocab_size,
        max_position_embeddings=max_length, use_activation_head=use_activation_head,
    ))

# ═══════════════════════════════════════════════════════════════════
# Pre-tokenized dataset (avoids re-tokenizing every epoch)
# ═══════════════════════════════════════════════════════════════════

class PreTokenizedDataset(Dataset):
    """Load JSONL, tokenize with full Qwen vocab, then remap IDs to compact vocab."""

    def __init__(self, data_path: str, tokenizer, max_length: int,
                 old_to_new: dict | None = None):
        self.max_length = max_length
        self.samples = []
        print(f"Loading and tokenizing {data_path}...")

        # Build lookup tensor once for ID remap (fallback=0 for UNK)
        lookup = None
        max_old = 0
        if old_to_new is not None:
            max_old = max(old_to_new.keys())
            lookup = torch.full((max_old + 1,), 0, dtype=torch.long)
            for old, new in old_to_new.items():
                lookup[old] = new

        raw = []
        with open(data_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    raw.append(json.loads(line))

        batch_size = 256
        for start in tqdm(range(0, len(raw), batch_size), desc="  tokenizing"):
            batch = raw[start:start + batch_size]
            queries = [item["query"] for item in batch]
            positives = [item["positive"] for item in batch]
            negatives = [item.get("hard_negative", "") for item in batch]
            all_texts = queries + positives + negatives

            encoded = tokenizer(
                all_texts, padding="max_length", truncation=True,
                max_length=max_length, return_tensors="pt",
            )
            n = len(batch)
            for i in range(n):
                q_ids = encoded.input_ids[i]
                p_ids = encoded.input_ids[n + i]
                n_ids = encoded.input_ids[2 * n + i]
                if lookup is not None:
                    q_ids = lookup[q_ids.clamp(0, max_old)]
                    p_ids = lookup[p_ids.clamp(0, max_old)]
                    n_ids = lookup[n_ids.clamp(0, max_old)]
                self.samples.append({
                    "q_ids": q_ids,
                    "q_mask": encoded.attention_mask[i],
                    "p_ids": p_ids,
                    "p_mask": encoded.attention_mask[n + i],
                    "n_ids": n_ids,
                    "n_mask": encoded.attention_mask[2 * n + i],
                })

        print(f"  {len(self.samples)} pre-tokenized samples ready"
              + (f" (vocab: {len(old_to_new)})" if old_to_new else ""))

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        return self.samples[idx]

# ═══════════════════════════════════════════════════════════════════
# Loss functions
# ═══════════════════════════════════════════════════════════════════

def info_nce_loss(query_emb, pos_emb, neg_emb, temperature=0.05, online_hnm_k=0):
    """InfoNCE: in-batch negatives + explicit hard negatives + optional online HNM.

    When online_hnm_k > 0: for each query, select the K hardest in-batch
    negatives (highest cosine similarity, excluding self) as additional
    hard negatives. This adapts to the model's current embedding quality.
    """
    B = query_emb.shape[0]
    pos_scores = (query_emb * pos_emb).sum(dim=-1) / temperature      # [B]
    neg_in_batch = (query_emb @ pos_emb.T) / temperature               # [B, B]
    neg_hard = (query_emb * neg_emb).sum(dim=-1).unsqueeze(1) / temperature  # [B, 1]

    if online_hnm_k > 0:
        # Find hardest in-batch negatives (excluding self, excluding positive)
        mask = torch.eye(B, device=query_emb.device)
        masked_scores = neg_in_batch.masked_fill(mask.bool(), float("-inf"))
        _, hard_idx = masked_scores.topk(online_hnm_k, dim=1)  # [B, K]
        neg_online = torch.gather(neg_in_batch, 1, hard_idx)   # [B, K]
        all_scores = torch.cat([neg_in_batch, neg_hard, neg_online], dim=1)  # [B, B+1+K]
    else:
        hard_idx = None
        all_scores = torch.cat([neg_in_batch, neg_hard], dim=1)  # [B, B+1]

    mask = torch.eye(B, device=query_emb.device)
    all_scores[:, :B] = all_scores[:, :B].masked_fill(mask.bool(), float("-inf"))
    logits = torch.cat([pos_scores.unsqueeze(1), all_scores], dim=1)   # [B, N]
    return F.cross_entropy(logits, torch.zeros(B, dtype=torch.long, device=query_emb.device))

def ranking_loss(query_emb, pos_emb, neg_emb, margin=0.2):
    """Pairwise margin ranking."""
    pos_sim = (query_emb * pos_emb).sum(dim=-1)
    neg_sim = (query_emb * neg_emb).sum(dim=-1)
    return F.relu(margin - pos_sim + neg_sim).mean()

# ═══════════════════════════════════════════════════════════════════
# Training
# ═══════════════════════════════════════════════════════════════════

def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Enable TF32 for Ampere tensor cores (RTX 3060 = SM86)
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    print_hardware()
    print(f"Device: {device}")
    print(f"Batch size: {args.batch_size} × {args.grad_accum} accumulation "
          f"= effective {args.batch_size * args.grad_accum}")

    # Tokenizer (always full Qwen, no pruning of tokenizer itself)
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer_name)
    print(f"Tokenizer: {args.tokenizer_name} (vocab: {tokenizer.vocab_size})")

    # Vocab mapping (old→new); model uses compact vocab, tokenizer stays untouched
    old_to_new = None
    model_vocab = len(tokenizer)
    if args.vocab_map:
        with open(args.vocab_map, "r") as f:
            old_to_new = {int(k): v for k, v in json.load(f).items()}
        model_vocab = max(old_to_new.values()) + 1
        print(f"Vocab map: {len(tokenizer)} → {model_vocab}")

    # Pre-tokenized dataset (remaps IDs if vocab_map is set)
    dataset = PreTokenizedDataset(args.data_path, tokenizer, args.max_length, old_to_new)

    # Model
    model = create_model(
        hidden_size=args.hidden_size, num_layers=args.num_layers,
        output_dim=args.output_dim, vocab_size=model_vocab,
        max_length=args.max_length, use_activation_head=args.use_activation_head,
    )
    model = model.to(device)

    # torch.compile for faster training (PyTorch 2.6+)
    if device.type == "cuda" and hasattr(torch, 'compile') and not args.no_compile:
        print("Compiling model with torch.compile (mode: reduce-overhead)...")
        model = torch.compile(model, mode="reduce-overhead")
    else:
        print("torch.compile: skipped")

    param_count = sum(p.numel() for p in model.parameters())
    print(f"Model: {param_count/1e6:.1f}M params")

    # DataLoader
    dataloader = DataLoader(
        dataset, batch_size=args.batch_size, shuffle=True,
        num_workers=args.num_workers, pin_memory=True,
        prefetch_factor=2, persistent_workers=(args.num_workers > 0),
    )
    print(f"Steps/epoch: {len(dataloader)}, Workers: {args.num_workers}")

    # Optimizer
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate,
        weight_decay=args.weight_decay, betas=(0.9, 0.98), fused=True if device.type == "cuda" else False,
    )

    # AMP scaler
    scaler = torch.amp.GradScaler("cuda") if args.amp else None

    # LR schedule
    total_steps = args.num_epochs * len(dataloader) // args.grad_accum
    warmup_steps = int(total_steps * 0.1)

    def lr_lambda(step):
        if step < warmup_steps:
            return step / max(1, warmup_steps)
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1 + math.cos(math.pi * progress))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)

    # ── Training loop ──
    model.train()
    global_step = 0
    accum_step = 0
    best_loss = float("inf")

    for epoch in range(args.num_epochs):
        epoch_loss = 0.0
        epoch_ctr = 0.0
        epoch_rank = 0.0
        epoch_start = time.perf_counter()

        optimizer.zero_grad()
        pbar = tqdm(dataloader, desc=f"Epoch {epoch+1}/{args.num_epochs}")

        for batch in pbar:
            q_ids = batch["q_ids"].to(device, non_blocking=True)
            q_mask = batch["q_mask"].to(device, non_blocking=True)
            p_ids = batch["p_ids"].to(device, non_blocking=True)
            p_mask = batch["p_mask"].to(device, non_blocking=True)
            n_ids = batch["n_ids"].to(device, non_blocking=True)
            n_mask = batch["n_mask"].to(device, non_blocking=True)

            # AMP forward
            with torch.amp.autocast("cuda") if args.amp else torch.no_grad():
                q_out = model(q_ids, q_mask)
                p_out = model(p_ids, p_mask)
                n_out = model(n_ids, n_mask)
                loss_ctr = info_nce_loss(q_out["embedding"], p_out["embedding"],
                                          n_out["embedding"], args.temperature,
                                          args.online_hnm_k)
                loss_rank = ranking_loss(q_out["embedding"], p_out["embedding"],
                                          n_out["embedding"], args.margin)
                loss = (loss_ctr + args.ranking_weight * loss_rank) / args.grad_accum

            # Backward with AMP
            if args.amp:
                scaler.scale(loss).backward()
            else:
                loss.backward()

            accum_step += 1

            # Gradient accumulation step
            if accum_step >= args.grad_accum:
                if args.amp:
                    scaler.unscale_(optimizer)
                    torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
                    optimizer.step()
                optimizer.zero_grad()
                scheduler.step()
                accum_step = 0
                global_step += 1

            epoch_loss += loss.item() * args.grad_accum
            epoch_ctr += loss_ctr.item()
            epoch_rank += loss_rank.item()

            pbar.set_postfix({
                "loss": f"{loss.item() * args.grad_accum:.4f}",
                "ctr": f"{loss_ctr.item():.4f}",
                "rank": f"{loss_rank.item():.4f}",
                "lr": f"{scheduler.get_last_lr()[0]:.2e}",
            })

            # Checkpoint
            if global_step > 0 and global_step % args.save_steps == 0:
                avg = epoch_loss / (accum_step + global_step * args.grad_accum)
                if avg < best_loss:
                    best_loss = avg
                    save_checkpoint(model, tokenizer, args.output_dir, "best")

        # End of epoch
        steps = len(dataloader)
        elapsed = time.perf_counter() - epoch_start
        avg = epoch_loss / steps
        print(f"Epoch {epoch+1} — avg loss: {avg:.4f} "
              f"(ctr: {epoch_ctr/steps:.4f}, rank: {epoch_rank/steps:.4f}) "
              f"| {elapsed:.0f}s ({elapsed/steps*1000:.0f}ms/step)")

        save_checkpoint(model, tokenizer, args.output_dir, f"epoch-{epoch+1}")

    print(f"Training complete. Best loss: {best_loss:.4f}")
    return model


def save_checkpoint(model, tokenizer, output_dir, name):
    path = os.path.join(output_dir, name)
    os.makedirs(path, exist_ok=True)
    model.save_pretrained(path)
    tokenizer.save_pretrained(path)

# ═══════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train MiniMind-NMG Encoder")

    # Hardware
    hw = parser.add_argument_group("Hardware")
    hw.add_argument("--batch_size", type=int, default=64,
                    help="Per-GPU batch size (RTX 3060 6GB: 64 is safe)")
    hw.add_argument("--grad_accum", type=int, default=1,
                    help="Gradient accumulation steps (effective batch = batch_size × grad_accum)")
    hw.add_argument("--num_workers", type=int, default=4,
                    help="DataLoader workers (20-core CPU: 4-8 is good)")
    hw.add_argument("--amp", action="store_true", default=True,
                    help="Automatic Mixed Precision (FP16, uses tensor cores)")
    hw.add_argument("--no_compile", action="store_true",
                    help="Disable torch.compile (debugging)")

    # Model
    mdl = parser.add_argument_group("Model")
    mdl.add_argument("--hidden_size", type=int, default=512)
    mdl.add_argument("--num_layers", type=int, default=6)
    mdl.add_argument("--output_dim", type=int, default=256)
    mdl.add_argument("--max_length", type=int, default=512,
                     help="Phase 1 data is short; 512 is plenty, 2048 wastes GPU/compute")
    mdl.add_argument("--use_activation_head", action="store_true")

    # Data
    dat = parser.add_argument_group("Data")
    dat.add_argument("--data_path", type=str, required=True)
    dat.add_argument("--tokenizer_name", type=str, default="Qwen/Qwen3-Embedding-0.6B")
    dat.add_argument("--vocab_map", type=str, default=None,
                     help="old_to_new.json for vocab pruning")

    # Training
    tr = parser.add_argument_group("Training")
    tr.add_argument("--num_epochs", type=int, default=3)
    tr.add_argument("--learning_rate", type=float, default=3e-4)
    tr.add_argument("--weight_decay", type=float, default=0.01)
    tr.add_argument("--max_grad_norm", type=float, default=1.0)
    tr.add_argument("--temperature", type=float, default=0.05)
    tr.add_argument("--margin", type=float, default=0.2)
    tr.add_argument("--ranking_weight", type=float, default=0.3)
    tr.add_argument("--online_hnm_k", type=int, default=0,
                    help="Online hard negative mining: extra K hardest in-batch negatives (0=off)")

    # Checkpoint
    chk = parser.add_argument_group("Checkpoint")
    chk.add_argument("--output_dir", type=str, default="./out/encoder")
    chk.add_argument("--save_steps", type=int, default=2000)

    args = parser.parse_args()
    train(args)
