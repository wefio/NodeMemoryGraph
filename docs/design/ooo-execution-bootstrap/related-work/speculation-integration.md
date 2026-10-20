# Where speculation could fit (the decision owns the rules; this section lists only candidates)

[中文](speculation-integration.zh-CN.md) · [Terms used](speculation-integration.terms.yaml)

**Status:** draft; historical planning snapshot. The measurements below belong to the runs and receipt set described here; later experiments are separate, sample-bounded evidence.
**Authority:** [Parent scope](../related-work.md).

## Candidate locations and cost classes

Whether to enable speculation, and under what conditions, belongs to the [speculation break-even decision](../../../decisions/implemented/2026-09-11-ooo-speculation.md); this section only answers “where might it fit?” That decision was implemented on 2026-09-11: token-free host-side work may be done, while guessing to hide a wait remains prohibited until measured break-even supports it. The decisive factor is **what a wrong guess costs**:

| Class | Cost of a wrong guess | Candidate in this project | Recorded position |
| --- | --- | --- | --- |
| **A. Free host-side work** | CPU seconds, no tokens, no reversible side effect | Pre-create a candidate directory that will certainly be needed; run checks needed by both branches (composition checks, mutant matrix); prebuild frozen envelopes for dependent tasks under both assumptions; audit token/lease consistency | Nonnegative return; can be done directly |
| **B. Event outcome; costs tokens** | One worker call (measured at 40–56 s) | Guess “the external check will pass” and start A's branch early | **Not adopted:** in the repository's ordinary waits, the largest was whole-round verification (23 receipts under `.rcp/receipts/`: median 80.7 s, minimum 15.9 s, maximum 134.5 s). Twenty minutes is nine times that historical maximum, more like a hung process than work worth hiding. Also, the only high-probability premise is nearly certain; a nearly certain premise usually means the dependency should be **removed**, not bypassed. A wait long enough to make guessing worthwhile is abnormal or should be **decoupled** (submit asynchronously and collect later), removing it from the critical path. |
| **C. Value prediction** | Low hit rate plus misclassification contaminating the dependent chain | Guess A's patch contents so C can assemble early | Prohibited in this design: processor value prediction has remained a research topic for decades |

**Class D is not speculation.** Work that must happen anyway but is blocked only by dependency order is **dependency relaxation/reordering**. It needs finer plan granularity (for example, split “A's nonblocking portion” into an independent node), not a speculation mechanism. Prioritize it above A/B/C: its cost is zero and it directly shrinks the waits that B would otherwise try to speculate over.

**Measurements in this snapshot.** The latest run recorded a 1.92 s check, B at 56 s, 1.92 s of overlap, and a wait that occupied about 3% of the round and was already filled by required work. The repository's ordinary external-wait maximum here was 134.5 s for whole-round verification (receipt measurement). For those inputs, only class A was worth doing; class B was not adopted for the reasons in the decision record. Later reports, including the [OOO arms pilot](../../../experiments/execution/ooo-arms-pilot-2026-09-18.md), do not by themselves establish a general cost model or break-even point.

**A counterintuitive rule.** If a dependency premise is correct almost every time, the right response is usually to **remove the dependency**, not speculate around it: the wait carries little information.

**Get the numbers first.** A gated dependency needs per-round token cost, step-by-step wall time, covered wait, and wasted-work cost. The round report at this snapshot contained check outcomes but no token field. Instrument those values before starting speculation; otherwise there is no basis for deciding whether a candidate is worthwhile.