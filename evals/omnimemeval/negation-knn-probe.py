import numpy as np
from sentence_transformers import SentenceTransformer

PAIRS = [
    ("The code runs successfully", "The code never runs successfully"),
    ("I have set up the database", "I have never set up the database"),
    ("She passed the certification exam", "She never passed the certification exam"),
    ("We deployed the service yesterday", "We never deployed the service"),
    ("He knows how to configure nginx", "He does not know how to configure nginx"),
    ("The tests cover the payment module", "The tests do not cover the payment module"),
    ("I have visited Rome", "I have never visited Rome"),
    ("She speaks fluent Japanese", "She does not speak fluent Japanese"),
    ("The server handles HTTP requests", "The server never handles HTTP requests"),
    ("I wrote Flask routes for this project", "I never wrote Flask routes for this project"),
]

texts = [t for pair in PAIRS for t in pair]  # [pos0, neg0, pos1, neg1, ...]

for model_name in ["BAAI/bge-small-en-v1.5", "Qwen/Qwen3-Embedding-0.6B"]:
    m = SentenceTransformer(model_name, device="cpu")
    V = np.asarray(m.encode(texts, normalize_embeddings=True), dtype=np.float32)
    sim = V @ V.T
    np.fill_diagonal(sim, -1)

    twin_hits = 0
    twin_sims, other_neg_sims = [], []
    print(f"\n=== {model_name} ===")
    for i in range(len(PAIRS)):
        neg_idx = 2 * i + 1
        order = np.argsort(-sim[neg_idx])
        top1 = order[0]
        is_twin = top1 == 2 * i
        twin_hits += is_twin
        twin_sims.append(sim[neg_idx, 2 * i])
        other_negs = [2 * j + 1 for j in range(len(PAIRS)) if j != i]
        other_neg_sims.append(max(sim[neg_idx, j] for j in other_negs))
        top_text = texts[top1][:50]
        print(f"  neg[{i}] top1={'TWIN-POS' if is_twin else 'other'} ({sim[neg_idx, top1]:.3f})  {top_text}")

    print(f"  --> twin-as-top1: {twin_hits}/{len(PAIRS)}")
    print(f"  --> mean cos(neg, its pos twin)   = {np.mean(twin_sims):.3f}")
    print(f"  --> mean cos(neg, best other neg) = {np.mean(other_neg_sims):.3f}")
