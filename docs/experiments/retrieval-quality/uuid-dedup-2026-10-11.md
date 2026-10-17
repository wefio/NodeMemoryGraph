# UUID repetition and identifier alternatives — 2026-10-11

## Frozen scope

The user selected duplicate-ID removal and requested research into alternatives
without new tools or decoding. Baseline is `97977028772da81d2a2a9f758c2f83b41d7483d6`
on the isolated `perf/shared-recall-output` branch. Neither this slice nor its
parent is merged into the main checkout.

Change only the shared feedback affordance in the YAML prompt source. Its
`activeGraphId` appears once in the actionable feedback instruction instead of
twice in that affordance. A search header still names its own graph for exact
reading; a complete header-plus-feedback message therefore has two occurrences,
not a promised single occurrence across all responsibilities. No ID format,
lookup, generation, record budget, adapter policy, or history replacement changes.

## Fixed comparison and exit conditions

- Before/after cells: standalone affordance, search header plus affordance, and
  empty-result text plus affordance. Reuse one unchanged full UUID.
- Protect the feedback action, exact graph value, six labels named in the
  affordance, advisory wording, omission on guessed labels, and no invented labels.
  Keep completion and independently attributable claim-outcome duties unchanged.
- Accept only if the affordance contains that ID once, each complete sample
  gets shorter, standalone/empty feedback remains attributable, and prompt/Pi
  regressions, LSP, build and selected blocking verification pass. Otherwise
  revert the copy; do not widen into aliases, new formats or ID generation.
- Collect clean-revision verification after committing. Dependencies remain a
  junction to the main checkout; this is not a fresh dependency installation.

An installed Python `tiktoken` permits a separate, fixed offline research matrix:
100 random UUIDv4 values; paired UUID, undashed hex, unpadded Base64url and decimal
representations; bare value and `memory=<value>` contexts; `cl100k_base` and
`o200k_base`. Store all inputs and software versions for reproduction. Count
actual encoding tokens, not a character estimate; do not equate either encoding
with the unverified current answer model or billing. No package install, live
model, embedding, or benchmark is used. Public vocabulary files may be fetched
by the existing tokenizer. No format in this research matrix is implemented.

## Sources and compatibility boundary

1. [RFC 9562 §4](https://www.rfc-editor.org/rfc/rfc9562.html#section-4)
   permits binary/integer representations while describing hex-and-dash text.
2. [Alternate UUID Encoding Methods §4.12](https://www.ietf.org/archive/id/draft-davis-uuidrev-alt-uuid-encoding-methods-00.html#section-4.12)
   is an Internet-Draft, not an approved replacement standard. It preserves
   hex-and-dash as the default UUID parser and discusses explicit alternate
   encoding parsing. A smaller spelling does not eliminate parsing support.
3. [Nano ID](https://github.com/ai/nanoid#comparison-with-uuid)
   generates a native 21-character opaque ID, with 126 random bits compared
   with UUIDv4's 122. That is a generation choice, not a decoder-free spelling
   of an existing UUID. Reducing alphabet/length changes collision probability.
4. [OpenAI tokenizer source](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py)
   includes numeric groups of at most three digits in these two encodings.
   This motivates testing numeric identifiers; the regex alone does not prove
   token cost or suitability for NMG.

Current NMG get parsing trims nonempty string IDs, and store retrieval uses an
exact `WHERE id = ?` comparison. Merely deleting UUID dashes or displaying
Base64/decimal will not retrieve an existing canonical UUID record. A native
compact or numeric ID could avoid lookup-time decoding only if that exact string
were the stored identifier. Changing generation, legacy coexistence, assumptions
across consumers and collision/security properties needs its own decision and
verification; none is authorized or implemented here.

## Results

`tiktoken` 0.13.0 completed the frozen matrix: 100 paired random UUIDv4 values,
16 aggregate cells and 1,600 ID tokenizations. All representations round-tripped
to their source UUIDs in the research probe. The probe's inputs, source and
per-sample counts are retained in `.nmg/verification/id-dedup/token-probe.json`;
the throwaway Python source is removed.

Mean tokens (actual named encodings, not character estimates):

| Representation        | Characters | Bare cl100k / o200k | `memory=` field cl100k / o200k |
| --------------------- | ---------- | ------------------- | ------------------------------ |
| UUID                  | 36         | 22.79 / 22.78       | 24.55 / 24.54                  |
| Undashed hex          | 32         | 18.51 / 18.58       | 20.27 / 20.34                  |
| Unpadded Base64url    | 22         | 15.87 / 15.08       | 17.39 / 16.68                  |
| Decimal 128-bit value | 38.66 mean | 13.00 / 13.00       | 15.00 / 15.00                  |

In this sample a longer decimal string costs fewer tokens than a shorter
Base64url string. This supports evaluating native numeric-string identifiers,
not a current-model guarantee or permission to change existing records.
Numeric identifiers must remain exact strings, not JavaScript numbers. Nano ID
was researched from its official documentation, not added as a fifth measurement
cell or installed as a dependency.

For the fixed feedback UUID, the affordance shrinks from 473 to 387 characters
and from 139 to 104 tokens under both encodings. All three message compositions
save 86 characters / 35 tokens in each encoding. Graph occurrences become
2 → 1 standalone, 3 → 2 with a header, and 2 → 1 with an empty result. The graph
value, feedback action and six named labels survive. This does not measure all
UUIDs, XML/tool envelopes, answer-model billing, cache behavior or model uptake.

The new graph-count test was red against the baseline (2 instead of 1). The
prompt, Pi and shared-surface suites pass 79/79 after the YAML change. LSP reports
zero diagnostics for touched tests, generated prompts and the throwaway Python
probe. DAP paused in the real prompt test and inspected one graph placeholder,
one rendered graph occurrence, the actionable ID and the no-invented-labels
boundary. Full blocking and clean-revision verification are collected separately.
No parsing/generation change, new tool, alias table, live model/embedding,
benchmark, merge or shared-daemon restart is part of the implementation.
