"""Polarity extraction worker: spaCy rule layer + batched LLM fallback.

Scans memory_records where extract_method IS NULL (pending) and fills
polarity / predicate_key / confidence / extract_method:

1. Rule layer (spaCy, free, deterministic): negation cue via dependency
   `neg` attached to the ROOT verb, SVO backbone -> predicate_key. Clean
   cases are written directly with extract_method='rule'.
2. LLM fallback (deepseek-chat, temp 0): everything the rule layer marks
   uncertain (idioms, fragments, questions, missing SVO) is sent in ONE
   batched call per BATCH statements. The prompt carries the current top
   predicate_key vocabulary so the LLM reuses existing keys instead of
   inventing paraphrases. Written with extract_method='llm'.

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

# Negation cues that are almost always idiomatic, not factual denials.
IDIOM_RE = re.compile(
    r"\b(can'?t wait|cannot wait|can'?t deny|no doubt|no worries|no wonder|"
    r"nothing but|ain't nothing|won'?t (quit|give up|stop)|don'?t (quit|give up)|"
    r"never (quit|give up|stop) (?!had|have|did|was|been))\b",
    re.IGNORECASE,
)

BATCH_PROMPT = """You are a logic-normalization extractor. For EACH numbered statement below output one JSON object:
{"i": <n>, "polarity": "affirmative"|"negative"|"neutral", "predicate_key": "<snake_case canonical predicate>", "confidence": <0..1>}
Rules:
- The speaker is the name before the leading colon; the key subject MUST be that speaker (lowercased) unless the statement is explicitly about someone else.
- polarity:
  * "negative" ONLY when the sentence contains an explicit negation cue (never, no, not, ...n't, without, no longer) denying a concrete fact.
  * "affirmative" when the sentence asserts a concrete checkable fact — INCLUDING statements about the speaker's own activity: "I'm trying to implement X" affirms the speaker is implementing X; "I've managed to return static HTML" affirms a done fact.
  * "neutral" ONLY for content-free talk: pure questions, greetings, encouragement, thanks, vague plans with no concrete action. An error report WITH a concrete claim ("the id is already in use") is affirmative about that claim.
  * "negative" ONLY when the sentence contains an explicit negation cue (never, no, not, ...n't, without, no longer) denying a concrete fact. No cue word -> never "negative".
- Key grammar is STRICT: {subject}_{main-verb-lemma}[_{object-head-noun-singular}].
  * Strip aspectual/modal wrappers: "trying to implement X" -> implement, "wants to add Y" -> add, "started using Z" -> use.
  * Object is the bare head noun, singular, WITHOUT modifiers: "the basic homepage route" -> route. Keep only proper nouns or hyphenated technical names (flask-login).
  * GOOD: user_implement_route, user_write_route. BAD: user_try_implement, user_implement_homepage_route, user_write_routes.
- predicate_key must be IDENTICAL for a statement and its negation (strip negation).
- Vocabulary reuse: reuse a key from the existing vocabulary below ONLY if it names exactly the same predicate (same action AND same object). If none fits, ALWAYS mint a new key. Never force-fit a statement into a popular existing key.
- confidence = how strongly the statement asserts a concrete checkable fact (small talk / questions / encouragement -> 0.3 or below).
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


def rule_extract(nlp, text):
    """Return (polarity, predicate_key, confidence) or None when uncertain."""
    speaker, body = parse_statement(text)
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
    polarity = "negative" if neg_on_root else "affirmative"
    conf = 0.85 if neg_on_root else 0.8
    if body.rstrip().endswith("?"):
        return "neutral", None, 0.3
    return polarity, key, conf


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
        timeout=120,
    )
    r.raise_for_status()
    data = json.loads(r.json()["choices"][0]["message"]["content"])
    if isinstance(data, dict):
        data = next(iter(data.values()))
    out = {}
    for item in data:
        i = int(item.get("i", 0))
        pol = item.get("polarity")
        out[i] = (
            pol if pol in ("affirmative", "negative", "neutral") else None,
            str(item["predicate_key"]).strip() if item.get("predicate_key") else None,
            float(item["confidence"]) if item.get("confidence") is not None else None,
        )
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

    rule_hits, llm_queue = [], []
    for r in rows:
        res = rule_extract(nlp, r["statement"])
        if res is None:
            llm_queue.append(r)
        else:
            rule_hits.append((r["id"],) + res)
    print(f"rule layer: {len(rule_hits)} resolved, {len(llm_queue)} queued for LLM "
          f"({100*len(rule_hits)/max(1,len(rows)):.0f}% coverage)")

    cur = db.cursor()
    for rid, pol, key, conf in rule_hits:
        cur.execute(
            "UPDATE memory_records SET polarity=?, predicate_key=?, confidence=?, "
            "extract_method='rule' WHERE id=?",
            (pol, key, conf, rid),
        )
    db.commit()

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
            pol, key, conf = res.get(n, (None, None, None))
            cur.execute(
                "UPDATE memory_records SET polarity=?, predicate_key=?, confidence=?, "
                "extract_method='llm' WHERE id=?",
                (pol, key, conf, r["id"]),
            )
        done += len(chunk)
        db.commit()
        print(f"  llm {done}/{len(llm_queue)}")

    stats = db.execute(
        "SELECT extract_method, COUNT(*), SUM(polarity='negative') FROM memory_records "
        "WHERE extract_method IS NOT NULL GROUP BY extract_method"
    ).fetchall()
    for method, n, neg in stats:
        print(f"{method}: {n} records, {neg or 0} negative")
    db.close()


if __name__ == "__main__":
    main()
