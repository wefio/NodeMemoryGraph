"""Prune Qwen tokenizer vocabulary to ~32k tokens for NMG domain."""

import json
import argparse
from collections import Counter
from pathlib import Path
from transformers import AutoTokenizer


def collect_nmg_corpus(project_root: str, max_chars: int = 5_000_000) -> str:
    """Gather NMG-relevant text for frequency counting."""
    import os, re, sqlite3

    texts = []
    total_chars = 0

    # NMG memory store
    try:
        db = sqlite3.connect(os.path.join(project_root, '.nmg', 'nmg.sqlite'))
        rows = db.execute("SELECT statement FROM memory_records UNION ALL SELECT summary FROM memory_nodes").fetchall()
        for r in rows:
            texts.append(r[0] or "")
            total_chars += len(texts[-1])
        db.close()
        print(f"NMG store: {len(texts)} texts, {total_chars} chars")
    except Exception:
        pass

    # Project source code and docs
    exclude = {'.git', '.benchmarks', '.nmg', 'node_modules', '.venv', '__pycache__',
               '.pi', 'minimind', 'minimind-nmg', 'coverage', 'out'}
    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if d not in exclude and not d.startswith('.')]
        for fname in files:
            if fname.endswith(('.ts', '.py', '.md', '.json')):
                try:
                    with open(os.path.join(root, fname), 'r', encoding='utf-8') as f:
                        content = f.read()
                    texts.append(content)
                    total_chars += len(content)
                except Exception:
                    pass
            if total_chars >= max_chars:
                break

    return "\n".join(texts)


def prune_vocab(tokenizer_path: str, corpus: str, target_vocab: int,
                 output_dir: str):
    """
    Prune Qwen tokenizer vocabulary:
      1. Keep all special tokens (≥ vocab_size)
      2. Rank base tokens by frequency in NMG corpus
      3. Keep top (target_vocab - num_special) base tokens
      4. Build new tokenizer with pruned vocab + remapped IDs
    """
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path)
    vocab = tokenizer.get_vocab()
    special_tokens = {k: v for k, v in vocab.items() if v >= tokenizer.vocab_size}
    base_tokens = {k: v for k, v in vocab.items() if v < tokenizer.vocab_size}

    print(f"Base tokens: {len(base_tokens)}, Special tokens: {len(special_tokens)}")

    # Count token frequencies in NMG corpus
    encoded = tokenizer.encode(corpus[:1_000_000])  # Sample for speed
    counter = Counter(encoded)

    # Sort base tokens by frequency (keep all special tokens)
    num_special = len(special_tokens)
    num_base_keep = target_vocab - num_special
    print(f"Keeping {num_base_keep} base tokens + {num_special} special = {target_vocab}")

    # Rank by frequency, keep top
    token_freq = [(tid, counter.get(tid, 0)) for tid in range(tokenizer.vocab_size)]
    token_freq.sort(key=lambda x: -x[1])
    kept_base_ids = set(tid for tid, _ in token_freq[:num_base_keep])

    # Build new vocab: compact IDs 0..target_vocab-1
    new_vocab = {}
    new_id = 0
    old_to_new = {}

    # First: base tokens that we're keeping
    for token, old_id in sorted(base_tokens.items(), key=lambda x: x[1]):
        if old_id in kept_base_ids:
            new_vocab[token] = new_id
            old_to_new[old_id] = new_id
            new_id += 1

    # Then: special tokens (at the end, like original)
    for token, old_id in sorted(special_tokens.items(), key=lambda x: x[1]):
        new_vocab[token] = new_id
        old_to_new[old_id] = new_id
        new_id += 1

    print(f"New vocab size: {len(new_vocab)}")
    print(f"Coverage: {sum(1 for tid in counter if tid in kept_base_ids) / max(1, len(counter)) * 100:.1f}% of tokens covered")

    # Save new tokenizer
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Save vocab + old_to_new mapping
    with open(out / "vocab.json", "w", encoding="utf-8") as f:
        json.dump(new_vocab, f, ensure_ascii=False)
    with open(out / "old_to_new.json", "w", encoding="utf-8") as f:
        json.dump({str(k): v for k, v in old_to_new.items()}, f)

    # Save tokenizer config (copy from original, update vocab_size)
    config = tokenizer.backend_tokenizer.to_str()
    import copy
    tok_config = json.loads(config)
    tok_config["model"]["vocab"] = new_vocab
    with open(out / "tokenizer.json", "w", encoding="utf-8") as f:
        json.dump(tok_config, f, ensure_ascii=False)

    # Copy special tokens map and config
    for fname in ["special_tokens_map.json", "tokenizer_config.json"]:
        src = Path(tokenizer_path) / fname
        if src.exists():
            import shutil
            shutil.copy(src, out / fname)

    print(f"Pruned tokenizer saved to {output_dir}")
    return str(out), old_to_new


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer_path", type=str, default="./qwen3-embedding")
    parser.add_argument("--project_root", type=str, default="..")
    parser.add_argument("--target_vocab", type=int, default=32768)
    parser.add_argument("--output_dir", type=str, default="./out/tokenizer")
    args = parser.parse_args()

    print("Collecting NMG corpus...")
    corpus = collect_nmg_corpus(args.project_root)

    print(f"Pruning to {args.target_vocab} tokens...")
    prune_vocab(args.tokenizer_path, corpus, args.target_vocab, args.output_dir)
