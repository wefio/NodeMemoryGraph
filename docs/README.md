# NMG documents

Two kinds of documents live here:

- **`design/`** — design and mechanism records: architecture decisions, data
  models, algorithms, process conventions. Entry point:
  [design/design.md](design/design.md) (normative model and roadmap). The
  requirement-to-evidence ledger is
  [design/completion-audit.md](design/completion-audit.md).
- **`experiments/`** — experiment and evaluation records: benchmark runs,
  audits, probes, regressions. Named `<topic>-<date>.md` whenever they report
  a run. Retrieval-quality series:
  [baseline](experiments/retrieval-quality-baseline-2026-08-16.md) →
  [hybrid](experiments/retrieval-quality-hybrid-2026-08-16.md) →
  [summaries + stacked](experiments/retrieval-quality-summaries-2026-08-18.md).

Rule of thumb: if the document says *how NMG works or should work*, it belongs
in `design/`; if it says *what we measured*, it belongs in `experiments/`.
Mixed documents go by their purpose (a benchmark *design* is design; a run
*report* is an experiment).
