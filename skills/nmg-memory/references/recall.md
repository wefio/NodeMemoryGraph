# Recall manual

## Escalation order

1. Rewrite the query around the missing entity, time, or relation.
2. Increase `--limit` from 8 toward 20.
3. Increase `--max-tier` one level.
4. Add `--graph-hops 1` or `2` for related concepts.
5. Use `--include-historical` only when old or superseded state is relevant.

Stop when evidence is sufficient. Use `nmg get` only for IDs likely to affect the
answer.

## Conflicts

Do not silently choose whichever result ranks first. Compare time, scope, status,
truth status, and evidence. Current active state normally overrides older state
with the same key and scope; old events remain historical evidence.

## Multi-part questions

Use complementary subqueries for independently required facts. A broad query may
retrieve only one aspect. List or count from exact loaded records, not from search
previews.

## No result

Say that no matching memory was found. Do not invent remembered facts. If NMG is
unavailable, continue without memory and disclose the limitation when it matters.

