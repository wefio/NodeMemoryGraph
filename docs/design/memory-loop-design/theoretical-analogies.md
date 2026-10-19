# Theoretical analogies for the memory loop

[English](theoretical-analogies.md) | [简体中文](theoretical-analogies.zh-CN.md) · [Terms](theoretical-analogies.terms.yaml) · Parent: [Memory loop](../memory-loop-design.md)

## Status and scope

These comparisons are design analogies: they can suggest questions, but do not establish that NMG implements the cited theory, shares its guarantees, or produces its effects. The references below were carried over from the previous Chinese draft and were not independently verified or reproduced in this audit. No external research result is used as evidence for NMG runtime behavior.

| Memory-loop concern | Cited analogy | Boundary for NMG |
| --- | --- | --- |
| Retaining unresolved experience for later reuse | Case-based reasoning (Aamodt & Plaza, 1994), including near-miss cases | NMG's open records and retrieval attachments do not constitute a complete CBR system. |
| Making prior failures reachable when related work recurs | Schank's *Dynamic Memory* (1982); Riesbeck (1981) | Related-memory anchoring is an explicit NMG relation, not a claim that NMG implements the cited exception-memory model. |
| Keeping unresolved structures available over time | Zeigarnik (1927) and Ovsiankina (1930s) effects | These are not assumptions about human memory that NMG relies on. A previous draft's replication caution lacked a complete reference and is not repeated as a verified finding. |
| Tracking contradictions and revisable conclusions | TMS/ATMS (Doyle, 1979; de Kleer, 1986), non-monotonic reasoning (Reiter, 1980), and AGM belief revision (1985) | NMG records explicit open/resolved/reopened state; this does not make it a theorem-proving or belief-revision engine. |
| Updating a remembered conclusion after retrieval | Memory reconsolidation / prediction-error accounts (Nader et al., 2000; reviews cited as 2014/2015) | Any relation to NMG learning signals is metaphorical; no neuroscientific equivalence or causal effect is claimed. |
| Retrieval from related concepts | Spreading activation (Quillian, 1967; Collins & Loftus, 1975; ACT-R) | The documented NMG open-record path attaches records through explicit `relatedMemoryIds`; this is not evidence of a spreading-activation algorithm. |
| Contrasting recency-based forgetting | Ebbinghaus (1885) and ACT-R time decay | NMG's retention predicates are software policy, not a model of human forgetting. |

The implementation boundaries and current retrieval/retention behavior are owned by the [parent design](../memory-loop-design.md). The separate [supersession design](../supersession-design.md) owns replacement chains, and the [feedback-loop design](../feedback-loop-design.md) owns evidence and feedback signals.