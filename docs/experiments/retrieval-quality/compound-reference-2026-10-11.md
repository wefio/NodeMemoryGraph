# Graph-scoped compound retrieval reference trial

## Frozen question and arms

Frozen before implementation on 2026-10-11. Baseline revision:
`09cd5495296b45f9edf668972ebfcc112b4567a5`. The isolated candidate tests whether
existing shared text search → get can use fewer tokens than full UUIDs while
retrieving the same canonical records. No ranking, preview length, record body,
stored identity, live provider, deployment, or third comparison arm changes.

Baseline: full UUID text headers and get inputs. Candidate: NMG-generated
`ref:<hex-prefix>|<quote>` keys, copied whole into existing get `memoryIds`, with
the existing `activeGraphId`. Prefix starts at four hexadecimal digits and grows
by two until the combination matches one canonical ID in the graph's original
readable candidate set. Quote is the first six Unicode code points of the
whitespace-normalized statement, with trailing whitespace removed. Matching is
literal, case-sensitive and not NFKC/fuzzy normalization. UUID-prefix comparison
is case-insensitive and excludes dashes. Invalid UUIDs, withdrawn records, empty
quotes, row delimiters, or references not shorter than UUID text fall back to
full IDs. Deferred/folded ID-only rows retain UUIDs; they do not acquire content
that was not shown as a preview.

References are graph-scoped selectors, not durable identifiers or authentication.
Missing, foreign or expired graphs and zero/ambiguous matches fail closed; no
latest-graph inference or automatic retry. Full UUIDs remain usable without a
graph. A changed quote can invalidate a reference, while a changed suffix does
not change record identity. Existing exact get redaction, filtering and canonical
attribution remain authoritative. No additional tool or model decoding step,
no independently stored alias mapping, no new environment gate.

Raw diagnostic results and compact JSON IDs remain canonical. Shared text
rendering may consume a derived reference map; this is not a token-saving claim
for raw JSON consumers or final provider payloads.

## Fixed verification and measurement cells

Safety/contract cases: copied references and canonical-ID equivalence; repeated
quotes; ID-prefix collisions; remaining ambiguity; zero matches; malformed keys;
Unicode and normalization; statement edits; withdrawal; mixed/batch requests;
session/project/graph ownership; graph expiry; canonical disclosure bookkeeping;
ordinary JSON-RPC and shared library functions. No candidate is allowed to choose
the first ambiguous result or mutate retrieval order/body/preview.

Two-arm token fixtures: English single, Chinese single, mixed 13 long, repeated
quote with distinct IDs, colliding prefix with distinct quotes, colliding prefix
and quote needing extension, punctuation/full-ID fallback, Unicode, withdrawn,
empty, deferred and folded. Count the complete shared search display, actual
serialized get parameters, exact get display and the changed get tool description
once per arm. Both arms retain required graph IDs. Record component deltas and
all input strings; repeated quote text is cost, not additional useful information.
Use installed tiktoken 0.13.0, cl100k_base and o200k_base, without installing
anything or treating these as model-matched billing measurements.

Negative-cell strings/costs are reported separately, never as successful-read
savings. Also report the cost of an explicit canonical-ID recovery after a failed
reference, including its extra call; no such recovery is implemented or promised
as a no-extra-call path. Compare normal copied references to UUIDs, not to an
invented shorter-ID optimum. Preserve canonical compact DTOs and all preview and
exact body bytes. Collect a bounded local CPU observation for 1/13 records,
without inventing an online latency guarantee.

## Exit rule

Accept an isolated prototype only if safety/contract checks pass, normal
reference-using fixture chains use fewer tokens under both named encodings and
fallback/empty/deferred/folded cells do not grow except explicitly separated tool
instruction delta. Require targeted checks, LSP, blocking verification and a
clean-revision exit receipt. If the reference format cannot meet this, revert the
prototype instead of expanding into ID generation, ranking or model evaluation.
Passing this trial is not approval to merge, deploy, restart the daemon or claim
semantic relevance, task quality, cache or billing gains.

## Results

The normal matrix retains all preview bytes, exact output bytes, canonical DTOs
and disclosure entries. Twenty-two displayed references across seven of twelve
fixtures resolve to the same canonical IDs; five fixtures keep UUIDs. The shared
get-description instruction grows by six tokens under each named encoding.

| Fixture                          | cl100k_base baseline → candidate | o200k_base baseline → candidate |
| -------------------------------- | -------------------------------: | ------------------------------: |
| English single                   |                        445 → 419 |                       447 → 421 |
| Chinese single                   |                        462 → 440 |                       460 → 438 |
| Mixed 13 long                    |                      5669 → 5361 |                     4858 → 4550 |
| Repeated quote                   |                        573 → 507 |                       574 → 508 |
| Colliding prefix, distinct quote |                        563 → 507 |                       564 → 508 |
| Colliding prefix and quote       |                        561 → 507 |                       562 → 508 |
| Unicode                          |                        468 → 458 |                       457 → 437 |
| Punctuation fallback             |                        446 → 452 |                       448 → 454 |
| Withdrawn                        |                        473 → 479 |                       475 → 481 |
| Empty                            |                        175 → 181 |                       176 → 182 |
| Deferred                         |                        388 → 394 |                       388 → 394 |
| Folded                           |                        484 → 490 |                       485 → 491 |

These are component counts summed across the controlled shared display/arguments/
exact-output chain and one instruction copy, not provider message framing or
billing. Excluding instruction delta, English/Chinese chains save 32/28 tokens,
and 13 long records save 314. Fallback/empty/deferred/folded pipeline text stays
identical, but its instruction is still six tokens dearer. Repeated quote text
inside the keys is included, not credited as new information. This measurement
is not a raw/compact JSON optimization or a proof of improved semantic usefulness.

A current-content-only resolver failed the record-movement negative control.
The implementation retains original ID/quote witnesses in existing private AG
projection values, and checks current content only for the originally resolved
ID. The negative control then passes; it does not rely on immutable storage
statements, fuzzy matching, first-match selection or a new alias store.
A durable trace without these witnesses deliberately cannot resolve a compound
RPC selector. Shared library callers can capture/resolve their original scope;
Core canonical exact get is unchanged.

A controlled statement-prefix edit produced an actual local HTTP `-32602` error.
Explicit known-UUID recovery takes two calls instead of one: the measured chain
costs 257 → 320 (+63) cl100k_base and 260 → 326 (+66) o200k_base. This is a
failure-cost example, not a successful saving or an automatic no-extra-call
recovery. Unknown-UUID recovery and final host error envelopes were not measured.

Current-service UUID versus compound get, including lookup and bookkeeping,
observed medians of 0.499 → 0.861 ms for one record and 4.736 → 8.586 ms for 13.
Two warmups and ten alternating rounds per arm are stored. The broad repeated-term
13-record query abstained (`guardrail_empty`); supported multi-query fusion built
the requested batch without changing retrieval policy. An initial single-record
fusion attempt supplied an invalid empty `queries` array and was corrected by
omitting that optional field. These are fixture corrections, not ranking fixes,
old-search latency measurements or production bounds.

## Verification and artifacts

The final eight-file targeted run passed 159/159 and LSP reported zero diagnostics
across eight changed files. The first blocking run exposed a stale MCP UUID-only
assertion, the required test-environment guard and an unclaimed integration file;
all were corrected, alongside the control-character lint failure without weakening
any rule. MCP now copies the displayed reference through real stdio and checks the
canonical ID in exact output. A six-file regression printed 43 passes but its
outer shell timed out, so that run does not establish clean exit.

The final precommit run passed all 16 blocking checks and 1702/1702 product tests,
with actual exit 0, signal null and error null. The 150-second default watchdog
had previously expired near the end of verification despite passing tests; that
incomplete receipt is retained. The completed run used the existing explicit
300-second watchdog option, not a changed gate or source-code timeout. A clean
postcommit run must independently verify the committed revision before closure.

Primary artifacts are `.nmg/verification/compound-reference/{paired-probe,
token-probe,boundary-probe,render-parity}.json`. Probe artifacts record input/source
hashes and complete sources; render parity binds all twelve fixture displays and
references to the final source after the equivalent lint-safe control check.
Temporary probe entry points were removed after capture. No live model,
embedding, full benchmark, merge, push or shared daemon restart is performed.
