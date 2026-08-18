"""Polarity extraction worker: spaCy rule layer + batched LLM fallback.

Claims model (docs/design/predicate-key-canonicalization.md, chat.completions
parts analogy): a memory record is the evidence unit; each record carries
a claims_json array of atomic claims, each with its own polarity /
predicate_key / confidence. The record-level columns are a rollup cache
(first non-neutral claim) for backward compatibility.

Pipeline per record:
1. Strip code blocks, segment into sentences (spaCy).
2. Rule layer per sentence (free, deterministic): negation via dependency
   `neg` on the ROOT verb, SVO backbone -> key. If EVERY sentence resolves,
   the record is written with extract_method='rule'.
3. Otherwise the whole statement goes to the LLM (deepseek-chat, temp 0,
   batched) which returns a claims array. Written with extract_method='llm'.

Usage:
  set -a; source .env; set +a
  .benchmarks/omni-venv/Scripts/python.exe evals/omnimemeval/polarity-worker.py \
      --db .benchmarks/beam-conv1-nmg.sqlite
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time

import requests
import spacy

# Aspectual/modal verbs are transparent: the predicate is their infinitival
# complement ("trying to implement X" -> implement X).
ASPECTUALS = {"try", "want", "need", "start", "begin", "manage", "used",
              "go", "plan", "hope", "attempt", "learn", "decide", "like"}

SPEAKER_RE = re.compile(r"^\s*([A-Za-z][\w'-]{1,20})\s*:\s*(.*)$", re.DOTALL)
CODE_RE = re.compile(r"```.*?```", re.DOTALL)

# Negation cues that are almost always idiomatic, not factual denials.
IDIOM_RE = re.compile(
    r"\b(can'?t wait|cannot wait|can'?t deny|no doubt|no worries|no wonder|"
    r"nothing but|ain't nothing|won'?t (quit|give up|stop)|don'?t (quit|give up)|"
    r"never (quit|give up|stop) (?!had|have|did|was|been))\b",
    re.IGNORECASE,
)

BATCH_PROMPT = """You are a logic-normalization extractor. For EACH numbered statement below, split it into ATOMIC CLAIMS (one fact per claim; skip code blocks, skip pure filler) and output one JSON object:
{"i": <n>, "claims": [{"text": "<the claim, minimally rewritten>", "polarity": "affirmative"|"negative"|"neutral", "predicate_key": "<snake_case or null>", "confidence": <0..1>}, ...]}
Rules:
- The speaker is the name before the leading colon; the key subject MUST be that speaker (lowercased) unless the claim is explicitly about someone else.
- polarity:
  * "negative" ONLY when the claim contains an explicit negation cue (never, no, not, ...n't, without, no longer) denying a concrete fact. No cue word -> never "negative".
  * "affirmative" when the claim asserts a concrete checkable fact — INCLUDING the speaker's own activity: "I'm trying to implement X" affirms the speaker is implementing X; "I've managed to return static HTML" affirms a done fact.
  * "neutral" ONLY for content-free talk: pure questions, greetings, encouragement, thanks, vague plans with no concrete action. Neutral claims get predicate_key null.
- Key grammar is STRICT: {subject}_{main-verb-lemma}[_{object-head-noun-singular}].
  * Strip aspectual/modal wrappers: "trying to implement X" -> implement, "wants to add Y" -> add, "started using Z" -> use.
  * Object is the bare head noun, singular, WITHOUT modifiers: "the basic homepage route" -> route. Keep only proper nouns or hyphenated technical names (flask-login).
  * GOOD: user_implement_route, user_write_route. BAD: user_try_implement, user_implement_homepage_route, user_write_routes.
- predicate_key must be IDENTICAL for a claim and its negation (strip negation).
- Vocabulary reuse: reuse a key from the existing vocabulary below ONLY if it names exactly the same predicate (same action AND same object). If none fits, ALWAYS mint a new key. Never force-fit a claim into a popular existing key.
- A statement that asserts nothing gets an empty claims array.
Existing predicate vocabulary:
%s
Statements:
%s
Return a JSON array only, one object per statement, in order."""


def parse_statement(text):
    m = SPEAKER_RE.match(text)
    if m:
        return m.group(1).lower(), m.group(2).strip()
    return "user", text.strip()


def rule_sentence(nlp, speaker, sent):
    """One sentence -> (polarity, predicate_key, confidence) or None."""
    body = sent.strip()
    if not body:
        return None
    doc = nlp(body)
    root = next((t for t in doc if t.dep_ == "ROOT"), None)
    if root is None or root.pos_ not in ("VERB", "AUX"):
        return None  # fragment / no main verb -> LLM
    negs = [t for t in doc if t.dep_ == "neg"]
    if IDIOM_RE.search(body):
        return None  # idiom risk -> LLM
    neg_on_root = any(t.head == root or t.head.head == root for t in negs)
    if negs and not neg_on_root:
        return None  # negation scope unclear -> LLM
    # Negations of necessity/ability ("don't need to", "don't have access")
    # are pragmatically guidance, not factual denials -> LLM decides.
    MODALS = {"need", "have", "can", "could", "must", "should", "want", "try"}
    if neg_on_root and root.lemma_.lower() in MODALS:
        return None
    # In multi-clause sentences prefer the clause that carries the negation
    # as the predicate; otherwise the ROOT verb.
    pred = root
    if neg_on_root:
        negated = next((t.head for t in negs if t.head.pos_ in ("VERB", "AUX")), None)
        if negated is not None:
            pred = negated
    # Descend through aspectual/modal wrappers to the lexical verb.
    for _ in range(3):
        if pred.lemma_.lower() not in ASPECTUALS:
            break
        comp = next((c for c in pred.children if c.dep_ == "xcomp" and c.pos_ in ("VERB", "AUX")), None)
        if comp is None:
            break
        pred = comp
    subj = next((c for c in pred.children if c.dep_ in ("nsubj", "nsubjpass")), None)
    if subj is None:
        subj = next((c for c in root.children if c.dep_ in ("nsubj", "nsubjpass")), None)
    obj = next((c for c in pred.children if c.dep_ in ("dobj", "obj", "attr", "acomp")), None)
    if subj is None:
        return None  # unclear who acts -> LLM
    key = f"{speaker}_{pred.lemma_.lower()}"
    if obj is not None:
        lemma = obj.lemma_.lower()
        lemma = re.sub(r"[^a-z0-9]+", "_", lemma).strip("_")
        if lemma:
            key += f"_{lemma}"
    key = re.sub(r"[^a-z0-9_]+", "", key)
    if body.rstrip().endswith("?"):
        return "neutral", None, 0.3
    polarity = "negative" if neg_on_root else "affirmative"
    conf = 0.85 if neg_on_root else 0.8
    return polarity, key, conf


def claim(text, pol, key, conf, method):
    return {"text": text, "polarity": pol, "predicate_key": key,
            "confidence": conf, "extract_method": method}


def rollup(claims):
    """Record-level rollup: first non-neutral claim, else first claim."""
    for c in claims:
        if c["polarity"] in ("affirmative", "negative"):
            return c["polarity"], c["predicate_key"], c["confidence"]
    if claims:
        c = claims[0]
        return c["polarity"], c["predicate_key"], c["confidence"]
    return None, None, None


def llm_batch(api_key, texts, vocab):
    listing = "\n".join(f"{n}. {t}" for n, t in enumerate(texts, 1))
    prompt = BATCH_PROMPT % ("\n".join(vocab) if vocab else "(empty)", listing)
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": "deepseek-chat",
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=180,
    )
    r.raise_for_status()
    data = json.loads(r.json()["choices"][0]["message"]["content"])
    if isinstance(data, dict):
        data = next(iter(data.values()))
    out = {}
    for item in data:
        i = int(item.get("i", 0))
        claims = []
        for c in item.get("claims") or []:
            pol = c.get("polarity")
            claims.append(claim(
                str(c.get("text", "")).strip(),
                pol if pol in ("affirmative", "negative", "neutral") else None,
                str(c["predicate_key"]).strip() if c.get("predicate_key") else None,
                float(c["confidence"]) if c.get("confidence") is not None else None,
                "llm",
            ))
        out[i] = claims
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--batch", type=int, default=15)
    ap.add_argument("--vocab", type=int, default=30, help="top-N keys shown to the LLM")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    nlp = spacy.load("en_core_web_sm", disable=["ner"])
    api_key = os.environ.get("DEEPSEEK_API_KEY")

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        "SELECT id, statement FROM memory_records "
        "WHERE status='active' AND extract_method IS NULL"
    ).fetchall()
    if args.limit:
        rows = rows[: args.limit]
    print(f"{len(rows)} pending records")

    cur = db.cursor()

    def write(rid, claims, method):
        pol, key, conf = rollup(claims)
        cur.execute(
            "UPDATE memory_records SET polarity=?, predicate_key=?, confidence=?, "
            "extract_method=?, claims_json=? WHERE id=?",
            (pol, key, conf, method,
             json.dumps(claims, ensure_ascii=False) if claims else None, rid),
        )

    rule_count = 0
    llm_queue = []
    for r in rows:
        speaker, body = parse_statement(r["statement"])
        body = CODE_RE.sub(" ", body)
        sents = [s.text.strip() for s in nlp(body).sents if s.text.strip()] or [body]
        results = [rule_sentence(nlp, speaker, s) for s in sents]
        if all(res is not None for res in results):
            claims = [claim(s, pol, key, conf, "rule")
                      for s, (pol, key, conf) in zip(sents, results)]
            write(r["id"], claims, "rule")
            rule_count += 1
        else:
            llm_queue.append(r)
    db.commit()
    print(f"rule layer: {rule_count} resolved, {len(llm_queue)} queued for LLM "
          f"({100*rule_count/max(1,len(rows)):.0f}% coverage)")

    done = 0
    for off in range(0, len(llm_queue), args.batch):
        chunk = llm_queue[off : off + args.batch]
        vocab = [
            k for (k,) in db.execute(
                "SELECT predicate_key FROM memory_records WHERE predicate_key IS NOT NULL "
                "GROUP BY predicate_key ORDER BY COUNT(*) DESC LIMIT ?",
                (args.vocab,),
            )
        ]
        for attempt in range(3):
            try:
                res = llm_batch(api_key, [r["statement"] for r in chunk], vocab)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  !! batch failed: {e}", file=sys.stderr)
                    res = {}
                time.sleep(2 * (attempt + 1))
        # Batched responses occasionally drop indices; retry misses once
        # on their own before giving up on them.
        missing = [(n, r) for n, r in enumerate(chunk, 1) if n not in res]
        if missing:
            try:
                res2 = llm_batch(api_key, [r["statement"] for _, r in missing], vocab)
            except Exception:
                res2 = {}
            for m, (n, _) in enumerate(missing, 1):
                if m in res2:
                    res[n] = res2[m]
        for n, r in enumerate(chunk, 1):
            write(r["id"], res.get(n, []), "llm")
        done += len(chunk)
        db.commit()
        print(f"  llm {done}/{len(llm_queue)}")

    stats = db.execute(
        "SELECT extract_method, COUNT(*), SUM(polarity='negative') FROM memory_records "
        "WHERE extract_method IS NOT NULL GROUP BY extract_method"
    ).fetchall()
    for method, n, neg in stats:
        print(f"{method}: {n} records, {neg or 0} negative")
    nclaims = db.execute(
        "SELECT COALESCE(SUM(json_array_length(claims_json)), 0) FROM memory_records"
    ).fetchone()[0]
    print(f"total claims: {nclaims}")
    db.close()


if __name__ == "__main__":
    main()
