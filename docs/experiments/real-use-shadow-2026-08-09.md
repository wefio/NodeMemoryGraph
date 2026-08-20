# Pi controller-shadow smoke — 2026-08-09

This is a single natural Agent-use observation, not a calibration dataset or a
capability score. Terminology and trust boundaries were tightened after this
run: events originally called `exact-use` are legacy ambiguous observations,
not proof that the API model causally used a memory and not valid evidence
supervision.

## Setup

- Pi headless RPC controller
- `deepseek/deepseek-v4-flash`, thinking off
- NMG Pi extension with `NMG_CONTROLLER_SHADOW=1`
- one question asking Pi to recall why ANN remains non-default
- project-local `.nmg` store

## Observation

The run did not finish before the controller timeout. Before termination the
shadow log captured:

- 1 automatic recall;
- 8 explicit searches;
- 2 legacy events then called exact-use;
- 9 completed Agent-turn outcome telemetry events;
- 8,686 actually injected characters (about 2,175 tokens using the labelled
  four-characters-per-token estimate);
- no explicit success, correction, sufficiency, noise, or no-memory label.

The eight explicit searches were mostly synonym reformulations of ANN,
approximate nearest-neighbour, default selection, HNSW, and brute-force search.
This is evidence of a search/stop loop, not evidence that more retrieval was
useful. The uncorrected/incomplete run remains an unknown outcome and is not a
positive training example.

## Resulting engineering changes

- Shadow retrieval events now record actual injected characters separately
  from backend token estimates.
- `nmg_remember action=feedback` can attach explicit, session-owned labels for
  task success, user correction, evidence sufficiency, expansion usefulness,
  excessive noise, and no-memory-needed.
- `npm run eval:controller-shadow` audits event and label coverage and refuses
  to claim calibration readiness.
- The headless Pi helper uses a writable isolated Agent directory, a bounded
  prompt timeout, and a tool-call ceiling. Its hard timeout covers the entire
  RPC operation rather than relying on Pi's event-collection timeout. These
  protect evaluation runs; they do not change product retrieval budgets.
- The helper now passes one project-local path contract to Pi
  (`NMG_DATA_DIR`, `NMG_PROJECT_DIR`, and `PI_CODING_AGENT_DIR`). It explicitly
  acquires the daemon before starting Pi and shuts it down only when the helper
  owns it. A timed-out child therefore cannot leave a detached daemon behind;
  a daemon that predated the helper remains untouched.
- The helper and report resolve the same project-local `.nmg` because the helper
  explicitly supplies `NMG_DATA_DIR`. Ordinary Pi use is intentionally different:
  without an override, all clients resolve the user-level `~/.nmg` store. A
  2026-08-11 audit found that the extension and exporter had drifted to different
  defaults; the shared data-path resolver now enforces this contract. Historical
  event counts in this report are snapshots, not current readiness evidence.

## Follow-up after seeding the missing decision

The first run was asking for an ANN policy that did not yet exist in the NMG
store. After the verified project decision was remembered, a second isolated
run added exactly one automatic retrieval, one use event, and one explicit
feedback event. Pi labelled the task successful and the injected evidence
sufficient; it did not perform another synonym-search loop.

The second helper process still failed to exit on its own because Pi's
`promptAndWait()` event timeout does not bound a stalled prompt RPC. The run was
terminated through its exact owned process handle, never through a system-wide
PID heuristic. The helper now wraps the whole operation in a hard timeout and
lets `RpcClient.stop()` terminate only the child it created.

## What this does not prove

Two smoke runs cannot set QPP thresholds, train next-tier/search actions, or
compare Graph with Lite. Those decisions still require independently labelled
semantic tasks and a held-out time/task split.

## Tool-flow follow-up

A later live-code-review prompt exposed a different progressive-disclosure
failure: the model kept paraphrasing `nmg_search` even though NMG could not
verify current source code. Prompt guidance alone did not stop the loop.

The Pi adapter now applies a deterministic, per-user-turn progression guard:

- automatic recall does not consume the explicit-search allowance;
- two explicit searches may run before exact evidence is loaded;
- another search is folded into an instruction to use `nmg_get` or a
  current-source tool;
- a successful `nmg_get` reopens search for a complementary evidence hop;
- a new user prompt resets the allowance, while Pi's internal
  `before_agent_start` tool loops do not.

The first implementation incorrectly reset on every `before_agent_start` and
therefore allowed three real searches. After keying the guard by session plus
user prompt, the bounded replay produced one automatic recall, one explicit
search, one exact `get`, and one complementary explicit search. The helper
exited normally and the project daemon reported `running: false`. This validates
the tool-sequence boundary, not retrieval quality or QPP calibration.

A dedicated follow-up asked Pi to issue three distinct searches without a get.
Only the first two reached retrieval. The third returned the progression
message, Pi accurately reported that it had been paused, and the shadow report
recorded one `tool_flow/search_suppressed` event. This makes the guard observable
without treating suppression as task success or evidence sufficiency.

New retrieval events also preserve the Active Graph query fingerprint, QPP
decision/components, progressive expansion stages, and per-candidate selection
scores. `npm run eval:controller-dataset` can therefore join those features with
exact use, outcome, and explicit feedback, then split whole semantic tasks by
time. At that stage it deliberately returned zero rows: only one partial
feedback event existed and no semantic task had all four required retrieval
labels. The later bounded collection follow-up below supersedes that snapshot.

## Replayability follow-up

The original event shape was sufficient to count labels but not to reproduce a
controller decision: it omitted the feature vector and hard budget used at that
moment. New events now carry a versioned global/memory/node/edge feature snapshot
and the AG budget envelope. The dataset builder excludes labelled legacy rows
that lack either input rather than pretending they are calibratable.

`npm run eval:controller-calibrate` is the now-complete offline mechanism. It
uses chronological semantic-task splits, trains a fresh candidate, compares it
with baseline ranking on held-out rows, reports cost observations, and persists
an auditable non-active artifact with log and rollback fingerprints. Running it
against the then-current project log correctly blocked: 36 graphs existed, but
zero had the complete independent label set. This was a data-readiness result,
not a controller failure and not permission to substitute benchmark labels.

## Feedback collection boundary (2026-08-11)

The headless helper now accepts repeated conventional `--turn` arguments in one
Pi process. This preserves one session across the answer/review boundary while
retaining the existing whole-run timeout, tool-call ceiling, owned-daemon
shutdown, and isolated writable Agent directory. The legacy one-message form is
unchanged.

The first live multi-turn probe exposed two lifecycle errors. Pi invokes
`before_agent_start` again after tool results, so a feedback reminder could be
marked shown inside the same user turn before the next user message. A single
answer can also create both an automatic header graph and an explicit
`search -> get` graph; selecting the newest graph could therefore request labels
for a graph whose evidence was never disclosed. The bridge now checks for
feedback only once per distinct `(session, user prompt)` and offers only graphs
with a non-empty disclosure event. Deterministic tests cover both conditions.

The historical bounded log contained 48 retrieval graphs, 11 events then named
"exact-use" (now conservatively treated as disclosure or diagnostic attribution), 48
outcome records, four feedback events, three fully labelled graphs, and three
query-derived task IDs. The new observability event was also verified end to
end: one `feedback_nudge_shown` event precedes a feedback event for the same AG.
The daemon was stopped after every helper run. The
Agent still decides whether the four labels are observable: silence, normal
completion, lack of correction, and candidate exposure never become labels.

`npm run eval:controller-dataset` now produces a chronological two-task train /
one-task validation split with no protocol blockers. This proves the collection
and replay boundary, not statistical sufficiency. The latest resulting
`npm run eval:controller-calibrate` artifact remains a non-active candidate:

- validation candidate recall: `1.0`;
- baseline precision/recall: `0.333 / 1.0`;
- learned precision/recall: `0.333 / 1.0`;
- control accuracy: `1.0` on the single validation row;
- mean controller inference: about `0.14 ms`;
- historical evidence diversity: two primary training targets and one primary validation
  target; the legacy ambiguous sets contain seven and two targets, with one
  target appearing in both splits;
- controller gate: failed because two training cases and two distinct training
  evidence targets are insufficient, and because the shared evidence target
  violates the held-out boundary;
- eligible for shadow/active/default Pi: all false.

The correct product result is continued collection. Three controlled labelled
tasks are sufficient to exercise the split and fail-closed gate, but not to
calibrate a routing policy or authorize activation.

The three current task IDs cover only two actual topics (ANN activation and
progressive-disclosure evaluation). They are controlled lifecycle probes, not
three semantically independent natural tasks. Query hashes must therefore not be
used as a diversity claim; future calibration needs a materially broader set of
ordinary Pi work even though the exporter can already form a legal split.

The calibration gate now enforces a stricter distinction mechanically. In
addition to whole-task chronological splitting, current code derives one
conservative primary evidence target per row from the first rank-ordered exact
record supported by `verified_claim_support`. It requires at least eight
distinct primary training targets,
which prevents one multi-evidence task from inflating diversity. Separately, it
rejects any overlap between the complete training and validation verified-attribution sets,
including non-primary evidence. The current artifact reports
`primaryTrainingTargets=2`, `primaryValidationTargets=1`,
historical `exactTrainingTargets=7`, `exactValidationTargets=2`, and
`overlappingExactTargets=1`, so it fails closed even though query-derived task
IDs form a syntactically valid split. Primary evidence is only a diversity
proxy; it does not assert that multi-evidence tasks have a single ground truth.
Those historical counts came from the superseded ambiguous event format and
must not be used to activate a controller. New collection requires independently
verified claim support.
