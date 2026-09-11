# One benchmark venv, and a venv path that can move

[中文](2026-09-11-benchmark-venv-consolidation.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

Two virtual environments lived under `.benchmarks/`, both carrying a CUDA build of
torch: `omni-venv` (Python 3.12, 3.5 GB, the official runners' requirements) and
`bge-venv` (Python 3.13, 4.4 GB, the local BGE embedding server). Nothing in the
repository recorded how either was built — no requirements step, no setup script, no
note — so the only description of their contents was the directories themselves.

The harness resolved the first one by hard-coded path: `evals/omnimemeval/run.ts`
prepended `.benchmarks/omni-venv/Scripts` to `PATH` inside an `existsSync` guard, and
`evals/halumem/score.ts` defaulted to its `python.exe` and threw when it was absent.

Deleting `omni-venv` during a disk cleanup therefore failed in two different ways.
`eval:halumem:score` failed loudly. `benchmark:omni` **silently** ran with whatever
`python` happened to be on `PATH` — a wrong-interpreter run that produces wrong
numbers rather than an error. The docstrings and README that named the deleted venv
failed a third way: they were simply wrong.

## Decision

One venv serves both roles: `.benchmarks/bge-venv` (Python 3.13, `torch 2.13.0+cu126`)
with the official runners' `requirements_user_memory.txt` installed into it.

- `evals/omnimemeval/run.ts` reads the venv directory from `NMG_BENCH_VENV`,
  defaulting to `bge-venv`, and warns on stderr when it is missing instead of falling
  back silently.
- `evals/halumem/score.ts` defaults to the same venv; `--python` and
  `NMG_HALUMEM_PYTHON` still override it.
- `evals/omnimemeval/README.md` records what the venv contains, how to rebuild it, and
  the torch hazard below; the research scripts' docstrings name the same path.
- The gate is registered in `docs/design/hidden-features-registry.md`.

## Alternatives considered

**Rebuild a slim `omni-venv` around a CPU torch.** No code change, and the hard-coded
paths would work again by themselves. Rejected because it keeps two environments and
re-downloads torch, transformers, scipy and scikit-learn — the duplication that made
the two directories confusable in the first place.

**Point `.benchmarks/omni-venv` at `bge-venv` with a directory junction.** Also needs
no code change, but a junction is reported as a directory, so the cleanup walk that
started this (`rm -rf` over `.benchmarks/`) would follow it into the real venv.
Reusing the mechanism that caused the problem is not a fix.

**Install `requirements_agentbench.txt` alongside it.** That file adds `swebench`,
`pyserini` (which needs Java), `faiss-cpu`, `tevatron` from git, and
`accelerate`/`peft`; the BEAM suites need it and nothing else does, and installing it
would rewrite `transformers`-adjacent packages in a working CUDA environment. Left
for when those suites are actually run.

**Keep the code pointing at `omni-venv` and require the environment variable.**
Rejected because it preserves the silent-fallback failure mode this record exists to
remove.

## Consequences

- One CUDA torch on disk instead of two.
- The harness still needs a torch: the official judge requirements include
  `sentence-transformers` and `bert-score`. A CPU-only torch would be enough if the
  environment is ever shrunk, because `bge_server.py` selects CUDA only when
  `--device` is omitted or `cuda` is passed, and an explicit `--device cuda` without
  CUDA fails loudly rather than degrading.
- `fsspec` moved from 2026.7.0 to 2026.6.0 because `datasets` requires it; the
  embedding stack (model load plus encode on `cuda:0`) was re-verified afterwards.
- The requirement files list `torch` and `torchvision` unpinned. Installing them with
  `-r` can replace the CUDA build with the default PyPI one, which is why the README
  tells the reader to exclude them and install torch from the CUDA index instead.
- The environments are not in git (`.benchmarks/` is ignored), so this record and the
  README section are the only description of what the venv contains.
- The registry row and the path default are the parts a check can see. "The venv
  exists and is the right one" stays a local condition.
