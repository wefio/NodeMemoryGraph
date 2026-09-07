# Literature scan: is a cost-aware, history-sensitive context-injection router a sound premise?

**Date:** 2026-09-07
**Status:** external-literature synthesis (Exa/TinyFish web search); not a formal survey.
**Purpose:** test the premises behind
`docs/experiments/context-live-comparison-preregistration-2026-09-07.md` before running.
**Scope:** adaptive/selective retrieval, context cost-quality tradeoffs, long-term
memory injection for agents, context selection/compression. English academic focus.

## Headline

The experiment's **core premise is well supported**: indiscriminate retrieval
(our fixed fallback F0 = retrieve-always) is documented as suboptimal, and
cost-aware, per-query injection routing is an active and supported direction
that matches exactly our `utility − λ·cost` framing. What is **not** established
by the literature — and is genuinely open — is whether a *learned, outcome/history-
sensitive* four-action router (our H1/H2) beats a fixed fallback; most adaptive-RAG
work decides by *query complexity or model uncertainty*, not by measured history
and verified outcomes. That is the novel claim our pre-registration is designed to
test, and it remains unproven (a valid null is expected to be common).

## What supports the premise

- **"When NOT to retrieve" is a real, studied problem.** Mallen et al. (2023)
  adapt retrieval by query entity frequency; *Retrieval Helps or Hurts?*
  (NAACL 2024) shows indiscriminate retrieval can degrade answers, especially on
  popular entities; *When Do LLMs Need Retrieval Augmentation?* (Findings-ACL
  2024) gates retrieval on model overconfidence; *Self-RAG* (ICLR 2024) trains
  retrieve-on-demand; *Adaptive-RAG* routes by question complexity.
  → F0 being suboptimal on some queries is empirically grounded.
- **Cost-aware budget routing is directly our framing.** *Know-Before-You-Fetch*
  (closed-book vs k=1 vs k=5 vs abstain), *Cost-Aware RAG query routing*,
  *Fast-or-Better* (accuracy-cost control), *SAGE* (SLO-aware), and
  *Adaptive-k* (matches/outperforms fixed-k with up to ~10× fewer tokens) all
  model `quality − cost` per query. Our `Q = E[utility] − λ·cost` and the λ sweep
  align with an established literature.
- **Diminishing returns and a "completeness" floor exist.** The getzep 50-run
  study reports diminishing accuracy returns from more retrieved context and that
  under-retrieval leads to guessing (accuracy running ahead of completeness). Our
  canary's `none` arm hallucinating/refusing and the LoCoMo need for the gold
  reinforce that pure cost minimization would hurt quality → the quality NI margin
  and F1 floor are necessary, and an optimal policy is query-dependent (not
  "always none" nor "always retrieve").

## Caveats and controls this implies for the run (design-level, before any outcome)

1. **Position/order confound (Lost in the Middle, Liu et al. 2023):** when
   retrieval is chosen, where the relevant evidence sits in the injected block
   (U-shaped attention) can dominate the retrieve-vs-none effect. Must fix the
   rendering/ordering (whole-fragment, deterministic order) across policies so the
   tested effect is the injection decision, not evidence position. Our executor
   already preserves source order — make it an explicit control.
2. **This experiment isolates the injection decision, holding retrieval fixed**
   (replayed/rendered context). It complements, and does not replace, retrieval-
   quality work. State that boundary explicitly (already implied; make it a line).
3. **Differentiation from the literature:** most adaptive-RAG routers decide by
   query complexity or uncertainty *now*, often via a second LLM/reflection; our
   design decides via a cheap offline-trained 132-parameter head on *observed
   actions with measured history and verified outcomes* — a bandit/sequential
   framing that is comparatively under-explored. This is the genuinely novel,
   untested part (H1/H2), so it should not be over-claimed.

## Does the literature recommend running or not?

**Run — it is not idiosyncratic.** The problem (retrieve-always suboptimal,
cost-quality tradeoff real) is supported; the method (cheap learned history-
sensitive router) is a legitimate, under-tested alternative worth measuring
against a fixed fallback. Expect and pre-register that a null (router no better
than retrieve-always, or degenerate to it) is a plausible and valid outcome.

## Selected sources

- Liu et al., *Lost in the Middle*, TACL 2024 (aclanthology 2024.tacl-1.9).
- Asai et al., *Self-RAG*, ICLR 2024 (arxiv 2310.11511).
- *Adaptive-RAG*, NAACL 2024 (aclanthology 2024.naacl-long.389).
- *Retrieval Helps or Hurts?*, NAACL 2024 (2024.naacl-long.308).
- *When Do LLMs Need Retrieval Augmentation?*, Findings-ACL 2024.
- *Know Before You Fetch: Calibrated Retrieval-Budget Allocation* (arxiv 2606.29959).
- *Cost-Aware Query Routing in RAG* (arxiv 2606.02581); *Fast or Better?* (2502.12145).
- *SAGE: SLO-Aware Adaptive Retrieval* (arxiv 2608.08237).
- *Efficient Context Selection / Adaptive-k* (arxiv 2506.08479).
- getzep, *The retrieval tradeoff: what 50 experiments taught us about context engineering*.
- *AttnComp*, Findings-EMNLP 2025; *SARA* (ACL 2026) fixed token budget.
- Agent memory: *PGMem*, *PPRO*, *RippleMem*, *MemMachine* (retrieval relevance,
  not storage, is the bottleneck for user-memory injection).
