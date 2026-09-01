# Implementation lineage

**Status:** documentation convention and curated recovery index  
**Authority:** this document maps implementation history to owners; it does not
replace the normative [system design](design.md), decisions, experiments, or the
[completion audit](completion-audit.md).

## Why this index exists

Git is the complete implementation history, but a hash alone does not say which
current contract owns the change. Topic documents therefore keep a short
`Implementation lineage` section only when a commit helps a future Agent recover
the origin of a mechanism, understand a hardening fix, or avoid repeating a
discarded design. This index is curated navigation, not a second changelog and not
an obligation to copy every commit into documentation.

## Lineage notation

Topic owners use four labels rather than reproducing a changelog:

- **Introduced** — first commit that establishes the capability.
- **Hardened** — fixes or completes the contract that remains current.
- **Validated** — supplies tests or measured evidence; does not imply default
  activation.
- **Superseded** — historical implementation whose current replacement is named.

Mechanical formatting, generated artifacts, dependency refreshes, ordinary tests,
merge commits, session metadata, and implementation details that are easy to find
from the owning code remain in Git. Experiment-only commits stay with their run
report. Record a hash only when it materially lowers rediscovery or regression
risk.

## Current contract owners

| Capability | Durable lineage | Current owner |
| --- | --- | --- |
| Base Pi memory, governed writes, typed records and Lite package | **Introduced** `3e67c6ca`; **Hardened** `19d284bb`, `a17fdfdd`, `199da9bd`, `412219b7` | [System design](design.md), root README |
| Agent-independent CLI and resident daemon | **Introduced** `87cbc3d5`, `39516537`; **Superseded** gRPC `9444a3c1` → HTTP JSON-RPC `692fe85c`; **Hardened** `80167da9`, `11e2101f`, `9a911d00`, `ac2d1114` | [System design](design.md), [daemon lifecycle](daemon-lifecycle-design.md) |
| Shared STG with session row isolation | **Introduced** `1d8b21df`; **Hardened** `48d64e29`, `25260270`, `6f755217`, `9a911d00` | [STG shared-store v2](stg-shared-store-v2-2026-08-12.md) |
| QPP, progressive recall and learned-controller channel | **Introduced** `dd41829e`, `2bb92098`, `1ae9e501`; **Hardened** `c369fa0b`, `4074eb19`, `9e7168e7`, `4a2f7ff1`; **Validated** `87d02423` | [Retrieval confidence controller](retrieval-confidence-controller.md) |
| Supersession, claims, posterior and reversible consolidation | **Introduced** `7b9849a3`, `a689c6e7`, `0b9a91e0`; **Hardened** `172a80ef`, `3e3b5eda`, `536f3439`, `a14f7828`, `12903701` | [System design](design.md), [supersession](supersession-design.md) |
| Session hooks and bounded reasoning scratchpad | **Introduced** `06d3f8ac`, `14cf0e89`; **Hardened** `fd086859`, `d05c3cfd`, `86d80c4e` | [Session lifecycle hooks](session-memory-lifecycle-hooks-2026-08-10.md) |
| Cross-harness Lab capability leases and daemon-owned reasoning/MGR invocation | **Introduced** `f8cbb9f` | [System design](design.md), [completion audit](completion-audit.md) |
| Task Board and local A2A-style discovery/delivery | **Introduced** `79a099de`, `5d09c4e1`; **Hardened** `9e097253`, `7b2bda5a`, `80506586`, `3641b3af`, `3f9d62be`, `b792f3af` | [Board/A2A compatibility](board-find-serial-a2a-compat-2026-08-13.md) |
| Temporal/logical memory chains | **Introduced** `155d88c9`; **Hardened** `d0a1cc03`, `fbc45e51`, `a126382a`, `cb4a858a`, `6db50df8`; **Validated** `2f068cfc`, `f5598a8c`, `f4977cf2` | [Temporal/logical chains](temporal-logical-chains-design-2026-08-13.md) |
| Leaf/node summaries and summary routing | **Introduced** `1feb008d`, `ecde4e45`; **Hardened** `796439ed`, `5a0edbf5`, `20de2efc` | [Tiered disclosure](tiered-disclosure-design.md), node-summary experiment series |
| Natural evidence and activation gates | **Introduced** `cc0fa383`, `c815dfd1`; **Hardened** `f49db9d1`, `9fa0872c`, `a14f7828`; **Validated** `fd62ed06`, `571e4bbf` | [Retrieval confidence controller](retrieval-confidence-controller.md), [completion audit](completion-audit.md) |
| Documentation, CI and Agent development workflow | **Introduced** `00d4a285`, `40c8e22e`, `75d9da39`; **Hardened** `8319e7e0`, `8b4ac943`, `11ab3b56`, `8061679`, `ea98ea4` | [Documentation index](../README.md), [CI and quality](ci-cd-and-quality.md) |
| Session Active Graph runtime (daemon-owned working memory) | **Introduced** protocol v9 + `SessionActiveGraphRuntime` core; **Hardened** task-frame/branch lifecycle, unified session-wide budget, TTL reasoning artifacts, disclosure ledger | [Session AG runtime](session-active-graph-runtime-design.md), [AG runtime decision](../decisions/proposed/2026-08-29-session-active-graph-runtime.md) |
| File content source for search | **Proposed** (2026-09-01): bounded passive scan of `.nmg-search-scope` hot zones; scope learned from Agent grep/read behaviour; lexical-first FTS index; memory+file fusion | [File content source](file-content-source-design.md) |

The Pi dependency boundary is intentionally represented by the package manifest
and its contract test rather than a new subsystem: the harness API is an optional
peer/type dependency, while `pi-tui` remains runtime only for the adapter UI and
lazy `nmg inspect` TUI.

## Maintenance rule

For a new commit, update the existing topic owner only when its durable contract,
rationale, evidence status, public operation, or a costly failure mode changes.
Add the hash to that owner's lineage using the labels above. If the commit is
experiment-only, mechanical, or easy to rediscover from the code, leave it in Git
or its experiment report instead of expanding normative design. The
[`doc-maintenance` Skill](../../skills/doc-maintenance/SKILL.md) owns this workflow.
