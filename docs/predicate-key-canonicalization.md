# Predicate-key canonicalization across extraction layers

Status: plan, 2026-07-27. Follow-up to the layered polarity worker
(`evals/omnimemeval/polarity-worker.py`).

## Problem

Contradiction detection is meant to be a deterministic join:

```sql
SELECT ... WHERE a.predicate_key = b.predicate_key
           AND a.polarity <> b.polarity
```

On BEAM 100K conversation 1 the pipeline gets every polarity right but the
known pair still misses, because the two layers emit different keys for the
same predicate:

- msg-24 "I'm trying to implement the basic homepage route with Flask"
  → LLM layer: `user_try_implement`
- msg-58 "I've never written any Flask routes..."
  → rule layer: `user_write_route`

Divergence has three distinct sources, cheapest to fix first:

1. **Aspectual/modal wrapping.** "trying to implement", "want to add",
   "started using" — the surface predicate is `try`/`want`/`start`, the
   semantic predicate is the embedded verb. The rule layer picks ROOT; the
   LLM picks inconsistently.
2. **Verb synonymy.** `implement` vs `write` vs `build` for the same act.
   No lemmatizer fixes this; only vocabulary pressure or an LLM judgment
   does.
3. **Object drift.** `route` vs `routes` vs `flask_routes`. Mostly solved
   by taking the dependency head noun and its lemma, but compound modifiers
   ("homepage route" vs "Flask routes") still differ.

Polarity-guarded embedding clustering (cos ≥ 0.85) cannot bridge keys this
dissimilar — `user_try_implement` vs `user_write_route` sits well below
threshold, and lowering the threshold re-admits the over-merge failure we
already measured (one union-find chain collapsing ~90 keys).

## Design

Two mechanisms, applied in order. The join itself stays exact — all
fuzzy work happens before it, at canonicalization time, not query time.

### 1. Unified key grammar (prevention, both layers)

Canonical form: `{subject}_{verb_lemma}[_{object_head_lemma}]`.

- **verb** is the main *lexical* verb. Aspectuals and modals
  (`try`, `want`, `need`, `start`, `begin`, `manage`, `used`, `going`,
  `plan`, `hope`) are transparent: the predicate is their infinitival
  complement (`xcomp`), recursively.
  - spaCy: if ROOT lemma ∈ ASPECTUALS and it has an `xcomp` verb child,
    descend. "trying to implement the route" → `implement_route`.
  - LLM prompt: same instruction in words, with examples.
- **object** is the head noun of the direct object / attr / acomp phrase,
  lemmatized (drops plural: `routes` → `route`). Compound modifiers are
  dropped unless they are named entities or hyphenated technical tokens
  (`flask-login` stays, `homepage` drops). Rationale: modifiers are the
  highest-variance part; subject+verb+head-noun is the stable core.
- **subject** is the speaker slug, as today.

Expected effect on the running example: msg-24 becomes
`user_implement_route` (rule and LLM alike), msg-58 stays
`user_write_route`. Grammar unification alone still does not join them —
that is what mechanism 2 is for.

### 2. LLM-arbitrated key canonicalization (repair, offline pass)

A post-extraction pass over the DB (`polarity-canonicalize.py`):

1. Collect distinct keys with their polarities.
2. Candidate pairs: cosine(key embeddings) ≥ 0.75, same subject slug,
   and **polarity guard** — a pair is eligible only if merging it cannot
   collapse an affirmative key and a negative key that both have support.
   (Guarded merging was validated in the previous round: it blocked all 3
   wrong cross-polarity merges.)
3. Each candidate pair goes into ONE batched LLM call (up to 30 pairs per
   call): "Do these two predicate keys name the same underlying predicate?
   Reply yes/no per pair." Yes → union-find merge. The LLM sees both keys
   and, for disambiguation, one example statement per key.
4. Remap `predicate_key` in `memory_records` to each cluster's
   representative (shortest key, ties broken by frequency).

`implement_route` vs `write_route` is exactly the judgment call a weak LLM
makes reliably when it sees the two source statements — much easier than
open-ended key generation, and batchable.

### What does not change

- Exact join for detection. No fuzzy logic at query time.
- Polarity extraction (already 100%/99.3% agreement).
- `extract_method` semantics; canonicalization does not re-label rows.

## Validation (qualitative gate, BEAM conv 1)

1. msg-24/msg-58 share a canonical key with opposite polarities → the
   known contradiction appears in the join. **Pass/fail criterion.**
2. Manual inspection of every merge the arbitrated pass makes: count
   false merges. Target: 0 obvious false merges on 188 messages.
3. Rule-layer coverage does not regress below the measured 27%.
4. Cost: grammar change is free; canonicalization ≤ ~2 batched LLM calls
   per conversation.
5. Re-run `polarity-validate.py`: polarity agreement stays ≥ 99%.

If gate 1 passes with 0 false merges, the next step is a LoCoMo-scale run
and, eventually, moving canonicalization into the worker as a periodic
sweep. If verb synonymy defeats arbitration too, the fallback is to drop
the verb from the join key entirely (subject + object-head only) and let
polarity + LLM arbitration carry the contradiction call.

## Outcome (2026-07-27, BEAM conv 1)

Gate 1 **passes**: the known pair shares canonical key `user_write_route`
with opposite polarities and ranks first among 4 join candidates.
Implemented beyond the plan:

- A `neutral` polarity value (questions, small talk, non-claims) keeps
  non-facts out of the aff/neg join; the polarity CHECK constraint was
  dropped from the schema because SQLite cannot alter CHECK on existing
  tables — values are validated in code instead.
- A temporal filter on the join (`a.rowid < b.rowid`): a contradiction is
  an earlier affirmation vs a later negation. This removed 7 of 11
  candidates, including every later how-to that shared the key. (`rowid`,
  not `created_at` — millisecond ISO timestamps can tie during fast
  ingestion. An earlier `a.id < b.id` draft silently dropped ~50% of pairs
  because ids are random UUIDs.)
- Arbitration works: `user_implement_route == user_write_route` plus 6
  other clean synonym merges, 0 false merges on inspection. Candidate
  pairs must NOT be polarity-guarded (that blocked exactly this pair) —
  merging keys never hides a contradiction because rows keep their own
  polarity.
- Vocabulary-constrained reuse in the worker prompt backfired once: the
  LLM dumped 33 unrelated statements into one popular key. Reuse must be
  phrased as "only if exactly the same predicate, otherwise mint new".

Remaining known errors (4 candidates, 1 true): one key collision
(`user_use_route` absorbed a Python-version statement) and two polarity
mislabels (a deployment problem report marked negative without a negation
cue).

**Negative result: LLM pair-verification is not usable as a gate at this
model tier.** deepseek-chat's contradiction verdict on the identical gold
pair flips with prompt wording and batch context (true alone with one
phrasing, false in a batch of 11, false with a rephrased single prompt).
Verification is kept as an advisory annotation only; the deterministic
join + temporal order is the output. Precision improvements must come from
better keying/polarity upstream, not from a weak-model veto downstream.

## Claims model (2026-07-27): both official contradictions detected

BEAM conv 1 has exactly two `contradiction_resolution` probing questions.
The record-level pipeline caught only Q1 (Flask routes); Q2 (Flask-Login)
was invisible because its evidence lives INSIDE one 4,776-char message
(msg-66) that packs "integrating Flask-Login" + "completed login modules"
+ "never written Flask routes" — one record, one polarity, so the
intra-message contradiction could not exist at record granularity.

The fix adopts the chat.completions content-parts model: a record is the
evidence unit and carries a `claims_json` array of atomic claims, each
with its own polarity/predicate_key/confidence (`MemoryClaim`,
`claims_json` column, record columns kept as a first-non-neutral rollup
cache). The worker segments sentences (code blocks stripped) and the LLM
returns claims arrays; the canonicalizer flattens claims and the
contradiction join orders by (record rowid, claim index), making
intra-record contradictions joinable.

Results on BEAM conv 1 (188 records -> 721 claims, ~3.8/record):

- **Both official contradiction pairs detected and advisory-verified** —
  Q1 (`user_write_flask_route`: implement homepage route vs never written
  Flask routes) and Q2 (`user_implement_login`: integrating Flask-Login
  v0.6.2 vs never integrated Flask-Login, the negative claim extracted
  from inside msg-66).
- Key arbitration confirmed 83 synonym merges over the richer claim-key
  space (vs 7 at record level), including
  `user_implement_login == user_integrate_flask_login`.
- Trade-offs: rule-layer coverage fell 27% -> 10% (every sentence must
  resolve for the free path); one large claims batch returned malformed
  JSON (longer outputs), fixed by retrying with smaller batches; remaining
  false candidates are mostly "user is not sure how to X" uncertainty
  claims mislabeled negative (uncertainty is not denial).

Answer-stage probe (`evals/omnimemeval/beam-answer-probe.py`, 2026-07-27):
an UNPRIMED weak reader (deepseek-chat, temp 0) given the raw evidence
statements picks one side and misses the contradiction on both official
questions (Q1 answered confidently wrong: "you HAVE worked with Flask
routes"). Given the same statements plus one metadata-derived annotation
("memory metadata flags a CONTRADICTION on '<key>': earlier claim ... vs
later claim ..."), the reader flags the contradiction and asks for
clarification — the exact `ideal_answer` behaviour. Caveat: an earlier
probe round with a contradiction-primed reader prompt found no A/B
difference, so the gain is specifically for harnesses whose answer prompt
does not already instruct contradiction handling. The metadata carries
the signal only if the answer stage renders it — that render path is the
remaining integration work.
