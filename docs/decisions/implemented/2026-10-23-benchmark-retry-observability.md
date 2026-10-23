# Retry attempts are recorded per benchmark run

[简体中文](2026-10-23-benchmark-retry-observability.zh-CN.md) · [Terms](2026-10-23-benchmark-retry-observability.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The official OmniMemEval client retries a failed call up to `max_retries` times
(default 4, so five attempts) and only the successful attempt reaches its token
tracker. A run's token totals therefore cannot tell a clean answer from one that
was billed repeatedly: a client timeout after the provider produced a response,
or an upstream 502 on the response path, costs input and output tokens that the
report never shows. With the default 600-second timeout, a slow endpoint can
multiply the real spend of a full suite while every artifact still looks
complete.

The launcher already writes a resource report beside each run, and the official
client already prints one warning line per retry. Nothing joined the two.

## Decision

Tee the official runner's stdout and stderr in `runPlan`, count
`⚠ [<MODULE>] LLM retry k/N` lines with a pure capture module
(`evals/omnimemeval/retry-observability.ts`), and write
`<result dir>/retry_report.json` next to `resource_report.json`. The report holds
the total retry count, per-module retries and the highest retry index seen, plus
the first few raw warning lines, and an attempts-per-call ratio when the caller
can supply successful-call counts.

Counting is textual and observational. The retry loop stays in the pinned
upstream checkout; the launcher changes no request, retry policy, timeout or
scheduling, and a capture or write failure never fails a completed run. The
operator still reads the streamed output unchanged.

## Alternatives considered

- Patch the upstream client to count attempts inside its retry loop: modifies a
  pinned third-party checkout that the adapter install already treats as
  external, and the counter would disappear on the next upstream sync.
- Infer retries from token totals: the tracker records one call per successful
  response, so billed retries are exactly the part that is missing.
- Lower `MAX_RETRIES` or `TIMEOUT_SECONDS` in the launcher by default: changes
  benchmark behaviour and would hide, not measure, an endpoint that retries
  instead of answering.
- Fail a run that retried: retries are legitimate for transient failures;
  visibility, not prohibition, is the requirement.

## Consequences

A run now states how many attempts it actually made, so a token total can be
read as "answers" rather than "answers plus unknown retry spend". The coupling is
to a printed warning line, so a wording change upstream would silently count
zero; the integration test spawns a fixture that prints the exact line and
asserts the per-module counts, which makes that drift visible instead of silent.

The report is diagnostic only. It does not attribute cost to a specific failure,
does not prove that a retry was billed, and does not establish answer quality.
Retry totals from one endpoint say nothing about another. Lowering retry or
timeout settings remains an operator decision made after reading the report.
