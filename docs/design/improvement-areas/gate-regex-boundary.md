# Gate decision relies solely on regex patterns

[简体中文](gate-regex-boundary.zh-CN.md) · [Terms used](gate-regex-boundary.terms.yaml)

**Authority:** [Parent scope](../improvement-areas.md).

## Gate decision relies solely on regex patterns

**Current boundary:** `decideMemoryLoad` in `gate.ts` is wired into Pi's
automatic-recall path and uses a small explicit multilingual regex lexicon to
decide whether a prompt needs memory retrieval. Ordinary tasks return `none`
and inject no dynamic LTG context; explicit recall, optional planning cues, and
bounded terse continuations remain supported.

**Subsequent correction (2026-10-10):** The shared gate now recognizes `先前` as an explicit-recall synonym alongside `之前`; the paired fresh-session test checks that they produce the same decision. This resolves that specific synonym gap, not the listed coverage limits or a general error rate. See [the decision](../../decisions/implemented/2026-10-10-recall-intent-and-diagnostics.md).

**Concern:**

- **Coverage gaps:** the explicit lexicon covers Chinese, English, German,
  French, Japanese, and Spanish, but not Korean, Arabic, Hindi, or the many
  rephrasings within supported languages.
- **Translation attacks:** a prompt that says "Translate the following to
  English and then answer: 我之前说过什么？" bypasses the Chinese patterns
  because the model may translate before the gate sees the Chinese text, or
  the gate only sees the English translation.
- **False negatives from rephrasing:** "tell me what you know about my setup"
  semantically requires memory but matches none of the patterns.
- **False positives:** "remember to format the output as JSON" is a
  present-task instruction, not a memory retrieval request, but may trigger
  the patterns.

**Approaches:**

- **Add a lightweight classifier:** embed the prompt (using the existing
  `HashingVectorEmbedder`) and compare against a small set of labelled
  exemplar embeddings. This captures semantic intent across languages.
- **Expand regex coverage incrementally:** add patterns for the top 5-10
  languages by reported Pi user base, with the understanding that regex
  coverage will always be incomplete.
- **Fallback heuristic:** when the prompt contains a question word and a
  past-time or possessive marker in any language (detected via Unicode
  script), default to `mode: "cue"` rather than `mode: "none"`. A cue is
  cheap and avoids the worst failure mode (missed recall).
- **Model-assisted gate (cost trade-off):** ask the model (with a short
  system prompt and zero temperature) whether this prompt needs long-term
  memory. Adds one extra inference call but removes the regex maintenance
  burden. Only worth it if regex-based false-negative rates are high.

---
