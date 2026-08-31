# Write-path scope index and batching experiment — 2026-08-31

## Question

Can a disposable in-memory index eliminate repeated same-scope tokenisation and
candidate scans, and can ordered transaction batches amortise SQLite commit cost,
without changing persisted memory semantics?

## Method

The reproducible runner is `npm run eval:ingest-ablation`. Its checked-in config
uses 1,000 deterministic records, batches of 32, one discarded warm-up and three
measured repetitions. Every arm runs in a fresh child process and fresh SQLite
database. History is appended first, matching the OmniMemEval bridge; memory
records are then written individually or through `rememberMany`.

The four arms are:

1. baseline: SQL candidate discovery and one memory transaction per record;
2. scope-index: process-local per-scope candidate index, individual transactions;
3. batch: SQL candidate discovery, ordered batches of 32 in one transaction;
4. both: scope index plus ordered transaction batches.

No LLM and no external embedding service participate. The runner rejects the run
unless all arms produce the same stable projection of statements, statuses,
state keys, supersession targets, nodes and evidence.

## Results

With write-time supersession candidate discovery enabled:

| Arm | Median wall time | Records/s | Speed-up | Median CPU | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 4,592 ms | 217.8 | 1.00x | 4,656 ms | 167.5 MiB |
| scope-index | 2,539 ms | 393.9 | 1.81x | 2,564 ms | 111.7 MiB |
| batch | 4,063 ms | 246.2 | 1.13x | 4,187 ms | 174.1 MiB |
| both | 2,296 ms | 435.5 | 2.00x | 2,547 ms | 113.8 MiB |

All four arms persisted 969 unique memories and passed the equivalence oracle.
The scope index reduced rather than increased peak RSS in this workload: retaining
normalised strings and tokens avoided substantially more short-lived allocation
from repeated SQL scans and tokenisation. Batch transactions added a smaller but
repeatable benefit after history append cost remained in the measurement.

With supersession candidate discovery disabled, the same bridge-shaped workload
still benefited: scope-index was 1.47x, batch was 1.37x, and both was 2.15x
(1,412 records/s versus 656 baseline). The combined arm used 98.1 MiB peak RSS
versus 91.0 MiB baseline: about 7.1 MiB additional resident memory for 969 stored
memories, while CPU fell from 1,563 ms to 688 ms. This second run also passed the
same persisted-output equivalence oracle.

## Interpretation and boundary

- The per-scope index is a disposable acceleration layer. SQLite remains the
  authority; the index is built lazily and invalidated after deletes, retention
  transitions, expiry and node transforms.
- `rememberMany` preserves input order. Later items see earlier batch writes, so
  exact duplicate and state-supersession semantics match repeated `remember`.
  Any failure rolls back the full batch and invalidates touched scope caches.
- `NmgStore` keeps the scope index opt-in. The OmniMemEval bridge enables it and a
  batch size of 32 by default because this controlled workload matches its write
  shape. `NMG_SCOPE_WRITE_INDEX=0` and `NMG_WRITE_BATCH_SIZE=1` retain the baseline.
- This is controlled benchmark evidence, not natural long-running daemon evidence.
  Memory growth across many scopes and cache rebuild behaviour after rare
  maintenance operations still require observation in ordinary Agent use.

Raw generated reports live under ignored `evals/results/`; the checked-in runner,
config and this summary are the reproducible evidence surface.
