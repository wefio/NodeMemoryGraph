# Mathematical / physical structural analogies

[简体中文](structural-analogies.zh-CN.md) · [Terms used](structural-analogies.terms.yaml)

**Created:** 2026-07-20

This document records **structural isomorphisms** between engineering already present in NMG and selected mathematical theorems, physical models, or classic algorithms. It does not mean “derive the design from mathematics”; it means “the thing we built happens to have the same shape as a known structure.”

Each item is labeled by **similarity depth**:
- **Isomorphism:** elements map one-to-one; rename them and the structures are the same.
- **Strong similarity:** the overall structure and key properties correspond, but details differ.
- **Weak similarity:** the abstract pattern is shared, but the concrete mechanisms differ.

---

## Delta + compaction = LSM Tree

**Current implementation:** `src/core/store/base.ts` — `markIndexDelta`, `memory_index_delta`; `src/core/store/maintenance.ts` — `rebuildLeafBlocks`, `acknowledgeIndexDelta`.

**Structure:**

```
NMG                              LSM Tree (LevelDB / RocksDB)
────────────────────────────────────────────────────────────
new memory write → Delta table   write → MemTable (memory)
Delta accumulates → mark node dirty   MemTable fills → mark compaction needed
rebuildLeafBlocks → rewrite block    Compaction → merge-write SSTable
compacted = 1 → delete Delta after acknowledgement   merge completes → delete old SSTable
acknowledgeIndexDelta → cleanup     …
```

**Similarities:**
- Writes first reach a fast layer (Delta / MemTable) and are immediately queryable.
- Accumulation past a threshold triggers a local rewrite (single-node block rebuild / compaction).
- Old data is cleaned up only after new data has been written.
- Read and write paths do not block (apart from transaction locks).

**Differences:**
- LSM compaction merges multiple SSTables by key range; NMG rebuilds blocks by node.
- LSM has multiple levels (L0 → L1 → …); NMG has one Delta → Block layer.
- NMG has no Bloom filter to accelerate point lookups.

**Design implication:** If Delta accumulates faster than compression can process it (like an LSM write stall), Delta itself could be layered like RocksDB's Delta L0 / Delta L1 so query cost degrades gradually rather than abruptly.

---

## Node redirects = Union-Find / forwarding pointers

**Current implementation:** `src/core/store/graph.ts` — `mergeNodes`, `splitNode`, `upsertNode`; `src/core/store/schema.ts` and store modules — `node_redirects`.

**Structure:**

```
NMG                              Union-Find
────────────────────────────────────────────────────────────
merge(A, B) → target C          union(A, B) → root C
node_redirects: A → C           parent[A] = C
node_redirects: B → C           parent[B] = C
upsertNode(A) → trace to C      find(A) → path-compress to C
split(C) → {D, E}               (U-F does not handle split)
node_redirects: C → D           —
node_redirects: C → E           —
```

**Similarities:**
- Old nodes do not disappear; the redirect chain is retained.
- `upsertNode` follows the redirect chain until it reaches an active node.
- Ambiguity is rejected when multiple redirect targets are found (after a split).

**Differences:**
- Union-Find uses path compression (amortized O(α(N))); NMG does not compress redirect chains.
- NMG supports split (one-to-many); Union-Find only supports merge (many-to-one).
- NMG retains a historical transform ID for each redirect; Union-Find does not.

**Similarity to garbage collection:**
- `node_redirects` correspond to forwarding pointers in Cheney copying collection.
- Old nodes (`status = 'merged'/'split'`) correspond to copied objects in from-space.

**Design implication:** If redirect chains grow through repeated merges, caching the final target in `upsertNode` (like path compression) could reduce repeated resolution from O(k) to O(1).

---

## Leaf-block content addressing = Git / IPFS / Nix

**Current implementation:** `src/core/store/rows.ts` — `stableLeafBlockId`; `src/core/store/maintenance.ts` — `rebuildLeafBlocks`.

**Structure:**

```
NMG                              Content-Addressable Storage
────────────────────────────────────────────────────────────
block ID = SHA256(concatenated content)   object hash = SHA256(content)
unchanged block content → unchanged ID    unchanged content → unchanged hash
rebuild: old ID = new ID →                rebuild: same hash → cache hit
  keep existing embedding cache
old ID not in new set → delete            unreferenced object → GC
```

**Similarities:**
- Identity property: same content → same ID (idempotency).
- Incremental update: recompute embeddings only for changed blocks.
- Old blocks are explicitly deleted and new blocks explicitly written.

**Differences:**
- Git's object graph is a DAG; NMG's block set is flat (a per-node list).
- Git uses content hashes for deduplication and delta compression; NMG uses them only as cache keys.
- NMG has no Merkle tree: there is no hash chain from node → block → memory; a block ID depends only on content.

**Design implication:** Giving a node a content-derived ID (node hash = hash of block hashes) could detect whether its structure changed and further reduce unnecessary embedding recomputation.

---

## State supersession = MVCC / temporal databases

See the full responsibility in [State supersession = MVCC / temporal databases](structural-analogies/state-supersession-and-mvcc.md).

## Co-retrieval = association-rule mining / Hebbian learning

See the full responsibility in [Co-retrieval = association-rule mining / Hebbian learning](structural-analogies/co-retrieval-and-hebbian-learning.md).

## Multi-channel retrieval = Ensemble Stacking

See the full responsibility in [Multi-channel retrieval = Ensemble Stacking](structural-analogies/multi-channel-retrieval-and-ensemble-stacking.md).

---

## MemoryNode = quotient set / equivalence class

**Current implementation:** `src/core/types.ts` — `MemoryNode`, `MemoryRecord.nodeId`; `docs/design/design.md` §7.

**Original design quote:**
> “A node represents an observational equivalence class under current evidence: records stay together while the system lacks reliable information to distinguish their use.”

**Mathematical structure:**

```
Let M = the set of all MemoryRecords
Define an equivalence relation ∼ on M:
  m₁ ∼ m₂  ⇔  current evidence is insufficient to distinguish their semantic use

MemoryNode = one equivalence class in M/∼
canonicalName = a representative/label for the equivalence class
split = new evidence → ∼ becomes finer → one equivalence class splits into several
merge = semantic overlap found → ∼ becomes coarser → several equivalence classes merge into one
```

**Similarities:**
- This is exactly the construction of a quotient set.
- Split / merge correspond to refining / coarsening an equivalence relation.
- `node_redirects` preserves the historical evolution of equivalence classes.

**Similarity to statistical identifiability:**
- “Two parameters cannot be distinguished under given observations” ↔ “Two memories should not be split under given evidence.”
- New query behavior / a new memory → new observation → distinguishable → split.
- This is a dynamic version of parameter identifiability.

**Similarity to clustering:**
- MemoryNode = cluster.
- canonicalName + summary = cluster centroid.
- split = increase k (number of clusters).
- merge = decrease k.

**Design implication:** Formal cluster-validity criteria (silhouette score, Davies–Bouldin index) could measure node “compactness” and help decide whether to split.

---

## Float32VectorCache geometric growth = dynamic-array amortized analysis

**Current implementation:** `src/core/vector-cache.ts` — `#ensureCapacity`.

**Structure:**

```typescript
// Float32VectorCache
#ensureCapacity(required: number): void {
  if (required <= this.#capacity) return;
  while (this.#capacity < required) this.#capacity *= 2;  // ← geometric growth
  const expanded = new Float32Array(this.#capacity * this.dimensions);
  expanded.set(this.#matrix.subarray(0, this.#length * this.dimensions));
  this.#matrix = expanded;
}
```

**Standard amortized analysis:**
- Each capacity expansion costs O(N·d) (N is the current number of entries; d is the number of dimensions).
- Geometric growth (×2) → amortized insertion cost = O(d).
- The mechanism is exactly the same as `std::vector`, `ArrayList`, and `StringBuilder`.

**Similarity depth:** isomorphism. This is textbook dynamic-array growth.

---

## Vector cache = read-only copy + lazy loading

**Current implementation:** `src/core/store/base.ts` — `vectorCaches`, `embeddingCache`; `src/core/store/retrieval.ts` — cache use.

**Structure:**

```
NMG                              CPU Cache Hierarchy
────────────────────────────────────────────────────────────
SQLite embedding table = main memory   RAM = main memory
Float32VectorCache = L1/L2             CPU cache = on-chip cache
lazy load (load all vectors from       cache miss → load from main memory
  SQLite on first use)
invalidate by dropping the entire cache  cache-line invalidation
  (#invalidateVectorCaches)
```

**Similarities:**
- SQLite is the authoritative source (like main memory is truth).
- The cache is disposable (it can be rebuilt from SQLite after being dropped).
- It loads everything rather than on demand (the current implementation loads all at once).

**Differences:**
- CPU caches operate at cache-line granularity (64B); NMG operates by the whole kind (node/leaf).
- CPU caches have replacement policies (LRU/PLRU); NMG does not evict individual entries.
- CPU caches are automatic hardware; NMG's cache is called explicitly.

**Design implication:** If the vector count grows to millions, the current “load everything” strategy may OOM. On-demand loading with an eviction policy (such as LRU), or mmap over SQLite BLOB columns, may be needed.

---

## Write-policy regex = signature-based intrusion detection

**Current implementation:** `src/core/write-policy.ts`.

**Structure:**

```
NMG                              Snort / Suricata IDS
────────────────────────────────────────────────────────────
SECRET_PATTERNS = [              signature rules = [
  /BEGIN.*PRIVATE KEY/i,           alert tcp any any → any any
  /api[_ -]?key\s*[:=]/i,          (content:"api_key="; …)
  …                               …
]                                 ]
assessMemoryWrite(text) =        detect(packet) =
  iterate pattern set →            iterate rule set →
    any match → reject               any match → alert
```

**Similarities:**
- Signature matching against known patterns.
- A blacklist model (allow by default; block only known threats).
- Regex is the detection language.

**Differences:**
- IDS has anomaly-based detection (statistical models); NMG does not.
- IDS rules have severity, category, and reference; NMG patterns are flat.
- IDS can update its rule base without changing code; NMG patterns are hard-coded.

**Design implication:** Moving the pattern set into a configuration file or SQLite table (like an updateable IDS rule base) could let users customize rules without touching source.

---

## Graph-expansion BFS = epidemic model / diffusion

**Current implementation:** `src/core/store/graph.ts` — `getRelations`.

**Structure:**

```
NMG                              SIR Epidemic Model
────────────────────────────────────────────────────────────
start node = infection source (I₀)   initial infected
hop 1 neighbors = first wave         direct contacts
hop 2 neighbors = second wave        secondary transmission
visited set = already immune (R)     recovered/immune (not reinfected)
maxHops = generation limit           none (SIR endpoint depends on β, γ)
```

**Similarities:**
- BFS's layer-by-layer expansion is structurally isomorphic to generational epidemic spread.
- The visited set corresponds to recovered/immune agents (they do not spread again).
- A hop limit corresponds to a finite number of propagation generations.

**Differences:**
- SIR transmission probability β is random (each person infects a neighbor with probability β); BFS is deterministic.
- SIR has a recovery rate γ; BFS has no concept of “recovery.”
- The SIR endpoint depends jointly on β, γ, and network topology (it may not reach full connectivity); BFS visits all nodes within ≤h hops.

**Design implication:** Probabilistic propagation (each edge propagates with probability p rather than 100%) would be equivalent to a random walk with restart / PPR and could provide smoother relevance decay.

---

## Overview table

| NMG component | Similar structure | Depth | Design implication |
|---|---|---|---|
| Delta + compaction | LSM Tree | isomorphism | Layer Delta to prevent write stalls |
| Node redirects | Union-Find / GC forwarding pointer | isomorphism | Path compression speeds long chains |
| Leaf-block content ID | Content-addressable storage (Git/IPFS) | isomorphism | Node-level hash chain detects structural changes |
| State supersession | MVCC / Event Sourcing | isomorphism | Bitemporal time (valid + transaction time) |
| Co-retrieval signals | Association-rule mining / Hebbian learning | isomorphism | Lift and related measures replace estimatedGain |
| Multi-channel fusion | Ensemble Stacking / Sensor Fusion | strong similarity | Adaptive weights based on noise variance |
| MemoryNode | Quotient set / equivalence class | isomorphism | Cluster-validity metrics inform splits |
| VectorCache growth | Dynamic-array amortized analysis | isomorphism | — (standard practice) |
| VectorCache architecture | CPU cache hierarchy | strong similarity | LRU eviction instead of loading everything |
| Write policy | Signature-based IDS | isomorphism | Configurable rule base |
| Graph expansion BFS | SIR epidemic model | strong similarity | Probabilistic propagation → PPR |
