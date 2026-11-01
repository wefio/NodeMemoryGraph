# 0007 - I deployed into a scored run, and a refactor dropped a field no test watched

[中文](0007-deployed-into-a-run-and-dropped-a-field.zh-CN.md) · [Terms used](0007-deployed-into-a-run-and-dropped-a-field.terms.yaml)

**Status:** open

## Executive summary

Two failures reached `main` and a live endpoint on the same day, and neither was
caught by anything that existed. A deployment made **while a scored benchmark run was
in flight** took every function route down for about ten minutes, and the harness
received 404s; the rule against it already existed and was not checked, so the rule
was not the missing part. Separately, a refactor that moved the search's answer
assembly into its own function silently dropped `persistence.inline_bytes` from every
response, and the suite stayed green because no test asserted the field's existence —
a linter noticed a helper had become unused and said so as a style problem. The lesson
is the same in both: a rule or a test that does not sit on the path the change takes
is a statement of intent, not a control.

## Summary

On 2026-11-01 the endpoint was serving a scored run. A configuration change was
deployed to add a scheduled heartbeat (`schedules` in `edgeone.json`). After the
deploy, `/health`, `/add` and `/search` all answered **404** while the domain served
the platform's default page. The rollback restored service; an A/B on the same commit
without the `schedules` block deployed correctly, which identified the block as the
regression.

Later the same day, a refactor extracted the answer assembly out of `search` into
`searchAnswer` to satisfy a complexity gate. The extraction took the line that sets
`persistence.inline_bytes` with it. Nothing failed: the endpoint answered 200, the
pages were correct except for one missing counter, and `npm run verify` reported 49
PASS. CodeFactor reported `'deltaBytes' is defined but never used` — the correct
symptom of the wrong class.

## Impact

- **Availability:** every function route was unavailable for roughly ten minutes
  during a scored run. The harness recorded 404s (`/add` 1287 ms, `/search` 370 ms)
  between 17:25:21 and 17:25:24 local time and retried; the run failed later for
  unrelated reasons, so the two effects cannot be separated in the final score.
- **Response contract:** `persistence.inline_bytes` was absent from every search
  response between the refactor and the fix. No consumer of the benchmark read it, so
  no score changed; a monitoring consumer would have seen a missing field rather than
  a wrong number.
- What the failures could **not** do: the storage layer was never written to
  incorrectly, no user data was lost, and the rollback was complete in one deploy.

## Timeline

1. `schedules` added to the build output; the platform documents the array.
2. Deploy to the live project **while a scored run was in progress**.
3. Every route answers 404. The domain serves the platform's default page.
4. Rollback to the previous revision; service returns.
5. A/B on the same commit with the block removed: `/health` 200, `/beat` 200,
   `/add` 200, `/search` 200. The block is the regression.
6. Block removed, plus a test that fails if it comes back.
7. Later: complexity gate flags `search`; the answer assembly is extracted.
8. `persistence.inline_bytes` disappears from every response; `verify` is green.
9. CodeFactor reports an unused helper; reading the diff finds the missing line.
10. The line is restored and a test now requires a numeric `inline_bytes` on every page.

## Root cause

**Deploy during a run.** The rule "no deployment between the start and the end of a
scored run" was written after 0006 and lived in that record. Nothing consulted it at
deploy time: the deploy path is a shell command, and the state of a scored run lives in
a browser tab. A rule whose enforcement depends on the operator remembering it at the
moment of action is not a control; it is a note. The same shape as 0002 and 0003 — the
verification existed, but not on the path the action took.

**A dropped field.** A refactor moved a block of code; a line inside it set a field
that no test read. The suite verifies behaviour it asserts, and it asserted nothing
about this field's presence. A linter's unused-symbol check incidentally found it,
which means the class was caught by luck: had the helper been used elsewhere, nothing
would have reported anything.

## Guardrails added

- `onlion/scripts/build-edgeone.mjs` no longer emits `schedules`, and
  `onlion/scripts/test-observability.mjs` fails if the built `edgeone.json` contains
  one. The failure mode is invisible locally — nothing in build, verify or the
  preflight reads the deployed route table — so the guard sits on the artefact.
- `onlion/scripts/test-backend.mjs` now requires `persistence.inline_bytes` to be a
  number on every search page.
- [edgeone-runtime-mechanism](../design/edgeone-runtime-mechanism.md) records the
  measured behaviour ("a `schedules` block as documented took every function route
  down") so the next attempt starts from evidence rather than the platform's example.

## Lessons

1. **A rule that is not on the action path is documentation.** "Never deploy during a
   run" needs a check at deploy time — a command that refuses, or a state the deploy
   reads — not a paragraph. Until then it is a reminder that will be missed again.
2. **Green means "the assertions hold", not "the contract holds".** A response field
   with no assertion is unprotected, and a refactor is exactly the change that removes
   it silently.
3. **A linter's finding can be the correct symptom of the wrong class.** "Unused
   variable" described a dropped field. Reading the finding as a style issue would
   have deleted the helper instead of restoring the field.
4. **Self-criticism belongs in the incident record, not in the release tag.** A tag
   answers "what is this version"; a post-mortem answers "why did this get through".
   Mixing them makes the release notes less useful and the lesson less findable.
