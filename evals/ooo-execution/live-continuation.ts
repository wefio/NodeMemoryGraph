/**
 * G7: five structurally identical, content-distinct tasks, each completed as one *real* handoff at a
 * legal boundary. Process A implements part 1 from the frozen source and delivers it to the board;
 * after an independent judgement accepts it, a *different process* continues the same parent task
 * (the parent is the channel; the continuation is a second handoff in it) using the view - the
 * delivery record and the artifact bytes, verified against the digest the store recorded - and the
 * fixed parent check decides the result.
 *
 * Every task has the same shape on purpose: a frozen module with a stated contract, a first part
 * whose cases are checked at the boundary, and edge cases only the second session has to handle.
 * Comparing five of them shows both how stable one path is across tasks and what the process looks
 * like when the tasks are alike.
 *
 * Roles, one process each, so the boundary is a real process boundary:
 *   --role plan                            one parent channel and its part-1 handoff per task
 *   --role part1 --task <id>               claim, call the model, check part 1, deliver
 *   --role judge --task <id> --stage part1 accept or reject part 1, then open the continuation
 *   --role part2 --task <id>               continue from the accepted bytes, check the parent, deliver
 *   --role judge --task <id> --stage parent judge the continuation with the fixed parent check
 *   --role report                          the table, read back from the run's own log
 *
 * Refusals: no --live means no model call; a missing provider, model, run directory or task id is
 * named rather than guessed; a judge refuses to judge its own delivery.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { NmgStoreBase } = await import("../../src/core/store/base.ts");
const { preparePatchWork, patchCandidate } = await import("../../src/integration/ooo-patch.ts");
const { executePiPatch } = await import("../../.pi/extensions/nmg/ooo-execution.ts");

/** One checked case: what to call, and what the module has to answer. */
interface Case {
  name: string;
  call: (module: Module) => unknown;
  expected: unknown;
}

/** The shape every task's module exports. */
type Module = Record<string, (...args: never[]) => unknown>;

interface Task {
  id: string;
  /** The frozen file the model may edit. */
  path: string;
  /** The frozen contract and its stub: the source of truth both sessions start from. */
  source: string;
  /** What the first session is asked for. */
  part1: string;
  /** What the second session is asked for, on top of the bytes the first one delivered. */
  part2: string;
  /** Cases the boundary checks. */
  boundary: Case[];
  /** The fixed parent check: everything, checked once at the end. */
  parent: Case[];
}

/** Five tasks, one shape: a frozen contract, a part-1 slice, and edge cases behind the boundary. */
const TASKS: Task[] = [
  {
    id: "chunk",
    path: "chunk.ts",
    source: [
      "// chunk(items, size) splits items into consecutive groups of at most `size` items.",
      "// For this stage the contract is the ordinary case: a non-empty list whose length is not a",
      "// multiple of `size`, where the last group may be short. The remaining cases of the contract",
      "// arrive with the next handoff. The input array is never modified.",
      "export function chunk(items: readonly unknown[], size: number): unknown[][] {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    part1:
      "Implement chunk for the ordinary case: a non-empty list whose length is not a multiple of size.",
    part2:
      "The delivered file is the current state; keep what it does. The remaining cases of the same " +
      "contract: an empty list yields no groups at all (chunk([], 3) is []); a length that is an exact " +
      "multiple of size yields full groups only; size 1 yields one group per item; and a size that is " +
      "not a positive integer (0, negative or fractional) must be refused with an Error.",
    boundary: [
      {
        name: "even split",
        call: (m) => m.chunk([1, 2, 3, 4] as never, 2 as never),
        expected: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        name: "short tail",
        call: (m) => m.chunk([1, 2, 3] as never, 2 as never),
        expected: [[1, 2], [3]],
      },
    ],
    parent: [
      {
        name: "even split",
        call: (m) => m.chunk([1, 2, 3, 4] as never, 2 as never),
        expected: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        name: "short tail",
        call: (m) => m.chunk([1, 2, 3] as never, 2 as never),
        expected: [[1, 2], [3]],
      },
      { name: "empty input", call: (m) => m.chunk([] as never, 3 as never), expected: [] },
      { name: "size one", call: (m) => m.chunk([7] as never, 1 as never), expected: [[7]] },
      { name: "size zero", call: (m) => m.chunk([1] as never, 0 as never), expected: "throws" },
      {
        name: "fractional size",
        call: (m) => m.chunk([1] as never, 1.5 as never),
        expected: "throws",
      },
    ],
  },
  {
    id: "duration",
    path: "duration.ts",
    source: [
      '// parseDuration(text) reads a duration such as "2s" and returns milliseconds, or null when the',
      "// text is not a duration. This stage covers the single-unit cases: milliseconds and seconds.",
      "// The remaining units and the refusal cases arrive with the next handoff.",
      "export function parseDuration(text: string): number | null {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    part1: "Implement parseDuration for the single-unit cases: milliseconds and seconds.",
    part2:
      "The delivered file is the current state; keep what it does. The remaining cases of the same " +
      "contract: m and h are units too, so 1m30s is 90000, 1h2m3s is 3723000 and 0s is 0, with the " +
      "units appearing in h, m, s order; and text that is empty, a bare number, or carries an unknown " +
      "unit such as 1x must return null. The result is always a number or null, never NaN.",
    boundary: [
      { name: "milliseconds", call: (m) => m.parseDuration("500ms" as never), expected: 500 },
      { name: "seconds", call: (m) => m.parseDuration("2s" as never), expected: 2000 },
    ],
    parent: [
      { name: "milliseconds", call: (m) => m.parseDuration("500ms" as never), expected: 500 },
      { name: "seconds", call: (m) => m.parseDuration("2s" as never), expected: 2000 },
      {
        name: "minutes and seconds",
        call: (m) => m.parseDuration("1m30s" as never),
        expected: 90000,
      },
      {
        name: "hours minutes seconds",
        call: (m) => m.parseDuration("1h2m3s" as never),
        expected: 3723000,
      },
      { name: "zero", call: (m) => m.parseDuration("0s" as never), expected: 0 },
      { name: "empty", call: (m) => m.parseDuration("" as never), expected: null },
      { name: "bare number", call: (m) => m.parseDuration("10" as never), expected: null },
      { name: "unknown unit", call: (m) => m.parseDuration("1x" as never), expected: null },
    ],
  },
  {
    id: "merge",
    path: "merge.ts",
    source: [
      "// mergeSorted(a, b) merges two arrays that are already sorted ascending into one sorted array.",
      "// This stage covers two non-empty arrays of equal length. The remaining cases of the contract",
      "// arrive with the next handoff. The result is a new array.",
      "export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    part1: "Implement mergeSorted for two non-empty arrays of equal length.",
    part2:
      "The delivered file is the current state; keep what it does. The remaining cases of the same " +
      "contract: either input may be empty (mergeSorted([], []) is [], mergeSorted([], [1]) is [1]); " +
      "duplicates are kept, so mergeSorted([1, 1], [1]) is [1, 1, 1]; the inputs may differ in length; " +
      "and neither input array is modified - do not call a mutating array method on them.",
    boundary: [
      {
        name: "interleaved",
        call: (m) => m.mergeSorted([1, 3] as never, [2, 4] as never),
        expected: [1, 2, 3, 4],
      },
      {
        name: "one before the other",
        call: (m) => m.mergeSorted([1, 2] as never, [3, 4] as never),
        expected: [1, 2, 3, 4],
      },
    ],
    parent: [
      {
        name: "interleaved",
        call: (m) => m.mergeSorted([1, 3] as never, [2, 4] as never),
        expected: [1, 2, 3, 4],
      },
      {
        name: "one before the other",
        call: (m) => m.mergeSorted([1, 2] as never, [3, 4] as never),
        expected: [1, 2, 3, 4],
      },
      { name: "both empty", call: (m) => m.mergeSorted([] as never, [] as never), expected: [] },
      { name: "left empty", call: (m) => m.mergeSorted([] as never, [1] as never), expected: [1] },
      { name: "right empty", call: (m) => m.mergeSorted([2] as never, [] as never), expected: [2] },
      {
        name: "duplicates",
        call: (m) => m.mergeSorted([1, 1] as never, [1] as never),
        expected: [1, 1, 1],
      },
      {
        name: "inputs unchanged",
        call: (m) => {
          const a = [3, 4];
          const b = [1, 2];
          m.mergeSorted(a as never, b as never);
          return [a, b];
        },
        expected: [
          [3, 4],
          [1, 2],
        ],
      },
    ],
  },
  {
    id: "average",
    path: "average.ts",
    source: [
      "// movingAverage(values, window) returns the mean of each run of `window` consecutive values.",
      "// This stage covers an input longer than a window of 2 or more. The remaining cases of the",
      "// contract arrive with the next handoff.",
      "export function movingAverage(values: readonly number[], window: number): number[] {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    part1: "Implement movingAverage for inputs longer than the window, with a window of 2 or more.",
    part2:
      "The delivered file is the current state; keep what it does. The remaining cases of the same " +
      "contract: there is one output per full window, so an input shorter than the window yields [] and " +
      "an empty input yields []; a window of 1 returns the values themselves; and a window that is not " +
      "a positive integer (0 or fractional) must be refused with an Error.",
    boundary: [
      {
        name: "window 2",
        call: (m) => m.movingAverage([1, 2, 3, 4] as never, 2 as never),
        expected: [1.5, 2.5, 3.5],
      },
      {
        name: "window 3",
        call: (m) => m.movingAverage([1, 2, 3, 6] as never, 3 as never),
        expected: [2, 11 / 3],
      },
    ],
    parent: [
      {
        name: "window 2",
        call: (m) => m.movingAverage([1, 2, 3, 4] as never, 2 as never),
        expected: [1.5, 2.5, 3.5],
      },
      {
        name: "window 1",
        call: (m) => m.movingAverage([1, 2, 3] as never, 1 as never),
        expected: [1, 2, 3],
      },
      {
        name: "input shorter than window",
        call: (m) => m.movingAverage([1, 2] as never, 3 as never),
        expected: [],
      },
      { name: "empty input", call: (m) => m.movingAverage([] as never, 3 as never), expected: [] },
      {
        name: "window zero",
        call: (m) => m.movingAverage([1] as never, 0 as never),
        expected: "throws",
      },
      {
        name: "window not an integer",
        call: (m) => m.movingAverage([1] as never, 1.5 as never),
        expected: "throws",
      },
    ],
  },
  {
    id: "paths",
    path: "paths.ts",
    source: [
      "// normalizePath(path) normalizes a POSIX-style path.",
      "// This stage covers paths built from ordinary segments separated by single slashes. The remaining",
      "// cases of the contract arrive with the next handoff.",
      "export function normalizePath(path: string): string {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    part1:
      "Implement normalizePath for paths that only contain ordinary segments separated by slashes.",
    part2:
      "The delivered file is the current state; keep what it does. The remaining cases of the same " +
      'contract: repeated slashes collapse, so a//b is a/b; a "." segment is removed, so a/./b is a/b; ' +
      'a ".." segment removes the segment before it, so ./a/../b is b; a ".." above the root of an ' +
      "absolute path is dropped, so /../a is /a; a trailing slash is removed, so a/ is a; and an empty " +
      'path is ".".',
    boundary: [
      { name: "ordinary path", call: (m) => m.normalizePath("a/b" as never), expected: "a/b" },
      { name: "one segment", call: (m) => m.normalizePath("a" as never), expected: "a" },
    ],
    parent: [
      { name: "ordinary path", call: (m) => m.normalizePath("a/b" as never), expected: "a/b" },
      { name: "repeated slashes", call: (m) => m.normalizePath("a//b" as never), expected: "a/b" },
      { name: "dot segment", call: (m) => m.normalizePath("a/./b" as never), expected: "a/b" },
      { name: "dot dot segment", call: (m) => m.normalizePath("./a/../b" as never), expected: "b" },
      {
        name: "absolute above root",
        call: (m) => m.normalizePath("/../a" as never),
        expected: "/a",
      },
      { name: "trailing slash", call: (m) => m.normalizePath("a/" as never), expected: "a" },
      { name: "empty", call: (m) => m.normalizePath("" as never), expected: "." },
    ],
  },
];

// The command line owns the run's identity and its budget. A missing input is refused by name.
const { values } = parseArgs({
  options: {
    role: { type: "string" },
    task: { type: "string" },
    stage: { type: "string" },
    run: { type: "string" },
    rep: { type: "string" },
    live: { type: "boolean" },
  },
});

/** A missing or refused input states itself and stops the process; nothing is guessed. */
function refuse(reason: string): never {
  process.stderr.write(`refused: ${reason}\n`);
  process.exit(1);
}

const role = values.role;
const runDir = values.run ? resolve(values.run) : undefined;
if (!role) refuse("--role is required: plan, part1, part2, judge or report");
if (!runDir) refuse("--run is required: the run owns its store, its log and its candidates");

const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
/** Execution limits belong to the frozen host envelope; this raise is stated in the report. */
const LIMITS = { turns: 10, reads: 5, timeoutMs: 300_000 } as const;

const storePath = join(runDir, "board.sqlite");
const logPath = join(runDir, "run.jsonl");
// One channel is one parent task. A repetition label gives a repetition its own channel: the board
// serialises actionable entries per channel, so two attempts in one channel would queue behind a
// continuation that nobody has claimed yet.
const channelFor = (taskId: string) =>
  `ooo-continuation:${taskId}${values.rep ? `:${values.rep}` : ""}`;
const agentFor = (name: string) => `${name}-${process.pid}`;

/** Append one record to the run's own log: the report is read back from these bytes. */
function record(entry: Record<string, unknown>): void {
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
}

function digestOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function taskOf(id: string | undefined): Task {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (!task)
    refuse(`--task must be one of ${TASKS.map((t) => t.id).join(", ")}; got ${id ?? "none"}`);
  return task;
}

/** Run one case list against the candidate module and report every failing case by name. */
async function check(
  candidatePath: string,
  cases: readonly Case[],
): Promise<{ passed: number; failed: string[] }> {
  const module = (await import(pathToFileURL(candidatePath).href)) as Module;
  const failed: string[] = [];
  for (const item of cases) {
    let observed: unknown;
    try {
      observed = item.call(module);
    } catch {
      observed = "throws";
    }
    if (JSON.stringify(observed) !== JSON.stringify(item.expected)) {
      failed.push(
        `${item.name}: expected ${JSON.stringify(item.expected)}, observed ${JSON.stringify(observed)}`,
      );
    }
  }
  return { passed: cases.length - failed.length, failed };
}

function openStore(): InstanceType<typeof NmgStoreBase> {
  mkdirSync(runDir!, { recursive: true });
  return new NmgStoreBase(storePath);
}

/** The open handoff of a stage in a channel, or a refusal naming what is missing. */
function readyHandoff(
  store: InstanceType<typeof NmgStoreBase>,
  channel: string,
  stage: string,
): string {
  const entry = store
    .readTaskBoard({ taskId: channel, limit: 200 })
    .entries.filter((candidate) => candidate.kind === "handoff" && candidate.status === "open")
    .filter((candidate) => candidate.content.includes(`stage=${stage}`))
    .at(-1);
  if (!entry) throw new Error(`no open ${stage} handoff in ${channel}`);
  return entry.id;
}

// ---------------------------------------------------------------- the roles

if (role === "plan") {
  const store = openStore();
  try {
    // --stage part2 opens one more continuation for an already-delivered part 1. Repeated openings
    // against the same frozen input are how the same task is sampled more than once.
    if (values.stage === "part2") {
      const task = taskOf(values.task);
      const channel = channelFor(task.id);
      const delivered = store
        .readTaskBoard({ taskId: channel, limit: 200 })
        .entries.filter((candidate) => candidate.content.includes("stage=part1"))
        .filter((candidate) => candidate.deliverableDigest)
        .at(-1);
      if (!delivered) throw new Error(`no delivered part1 artifact in ${channel} to continue from`);
      const opened = store.putTaskBoardEntry({
        taskId: channel,
        agentId: "coordinator",
        kind: "handoff",
        content: [
          `parent=${task.id}`,
          "stage=part2",
          `file=${task.path}`,
          `continues=${delivered.id}`,
          `part2=${task.part2}`,
        ].join("\n"),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      record({
        role,
        task: task.id,
        channel,
        entryId: opened.id,
        stage: "part2",
        at: new Date().toISOString(),
      });
      process.stdout.write(`${task.id}: opened a continuation (${opened.id})
`);
      store.close();
      process.exit(0);
    }
    for (const task of TASKS) {
      const channel = channelFor(task.id);
      const content = [
        `parent=${task.id}`,
        "stage=part1",
        `file=${task.path}`,
        `part1=${task.part1}`,
        `part2=${task.part2}`,
      ].join("\n");
      const entry = store.putTaskBoardEntry({
        taskId: channel,
        agentId: "coordinator",
        kind: "handoff",
        content,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      record({ role, task: task.id, channel, entryId: entry.id, at: new Date().toISOString() });
    }
    process.stdout.write(`planned ${TASKS.length} parent tasks in ${runDir}\n`);
  } finally {
    store.close();
  }
}

if (role === "part1" || role === "part2") {
  if (!values.live) refuse("pass --live explicitly: this calls the configured model");
  if (!provider || !model) refuse("set PI_PROVIDER and PI_MODEL explicitly");
  const task = taskOf(values.task);
  const channel = channelFor(task.id);
  const stage = role;
  const store = openStore();
  // Declared outside the try so a failure can still report what the call cost: a failing attempt
  // that leaves no cost behind biases exactly the comparison this check exists to make.
  let execution: { tokens?: number; turns?: number; reads?: number; sessionId?: string } | null =
    null;
  let entryId: string | undefined;
  let startedAt = 0;
  try {
    const agentId = agentFor(`worker-${stage}`);
    // Part 2 starts from what part 1 delivered, so it first has to retrieve that evidence and check
    // it against the digest the store recorded - the view alone is not the work.
    let input = task.source;
    let continuedFrom: string | null = null;
    if (stage === "part2") {
      const delivered = store
        .readTaskBoard({ taskId: channel, limit: 200 })
        .entries.filter((candidate) => candidate.content.includes("stage=part1"))
        .filter((candidate) => candidate.deliverableDigest)
        .at(-1);
      if (!delivered) throw new Error(`no delivered part1 artifact to continue from in ${channel}`);
      const bytes = readFileSync(delivered.deliverableRef!);
      continuedFrom = digestOf(bytes);
      if (continuedFrom !== delivered.deliverableDigest) {
        throw new Error(
          `the artifact no longer matches the delivery record: ${continuedFrom} != ${delivered.deliverableDigest}`,
        );
      }
      input = bytes.toString("utf8");
    }

    entryId = readyHandoff(store, channel, stage);
    const claimed = store.claimTaskBoardEntry({
      taskId: channel,
      entryId,
      agentId,
      leaseSeconds: 300,
    });
    if (claimed.claimedBy !== agentId)
      throw new Error(`claim did not land: holder is ${claimed.claimedBy}`);

    startedAt = Date.now();
    const frozen = preparePatchWork({
      taskId: `${channel}:${entryId}:${stage}`,
      attempt: 1,
      instruction: stage === "part1" ? task.part1 : task.part2,
      files: { [task.path]: input },
      editable: [task.path],
      limits: LIMITS,
    });
    execution = await executePiPatch(frozen, provider, model);
    // A continuation may legitimately conclude that the delivered bytes are already the answer. That
    // is a legal outcome, and the artifact states it: the continuation hands the same bytes forward
    // and the fixed parent check still judges them. Any other failure stays a failure.
    let candidate: string;
    let conclusion = "promote-candidate";
    try {
      const promoted = patchCandidate(frozen, execution.artifact)[task.path];
      if (typeof promoted !== "string") throw new Error(`the artifact did not carry ${task.path}`);
      candidate = promoted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The artifact states its own kind. A conclusion envelope is a legal answer - the model is
      // saying the delivered bytes already satisfy the task - and it must not be mistaken for a
      // malformed patch, which is what string-matching the error message did.
      let conclusionKind: string | null = null;
      try {
        const parsed = JSON.parse(execution.artifact) as { kind?: string; conclusion?: string };
        if (parsed.kind === "conclusion" && typeof parsed.conclusion === "string") {
          conclusionKind = parsed.conclusion;
        }
      } catch {
        conclusionKind = null;
      }
      if (conclusionKind === null || !message.includes("unchanged patch file")) {
        if (conclusionKind === "no-change-needed") {
          conclusion = "no-change-needed";
          candidate = input;
        } else {
          // Keep what the model actually submitted: "invalid patch structure" is a claim about
          // bytes, and the bytes are the evidence for it.
          const keptDir = join(runDir!, task.id, values.rep ? `${stage}-${values.rep}` : stage);
          const keptPath = join(keptDir, "artifact.failed.txt");
          mkdirSync(keptDir, { recursive: true });
          writeFileSync(keptPath, execution.artifact, "utf8");
          throw new Error(
            `${message} (conclusion=${conclusionKind ?? "none"}, submitted artifact kept at ${keptPath})`,
            { cause: error },
          );
        }
      } else {
        conclusion = "no-change-needed";
        candidate = input;
      }
    }

    // One repetition must not overwrite another's artifact: the delivery record's digest is checked
    // against these bytes later, and a shared path makes every earlier repetition look tampered with.
    const stageDir = join(runDir!, task.id, values.rep ? `${stage}-${values.rep}` : stage);
    const candidatePath = join(stageDir, task.path);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(candidatePath, candidate, "utf8");
    const cases = stage === "part1" ? task.boundary : task.parent;
    const result = await check(candidatePath, cases);
    const digest = digestOf(readFileSync(candidatePath));
    const summary =
      `stage=${stage} passed=${result.passed}/${cases.length} turns=${execution.turns} ` +
      `reads=${execution.reads} tokens=${execution.tokens} session=${execution.sessionId}` +
      (result.failed.length ? ` failed=[${result.failed.join("; ")}]` : "");
    const delivered = store.deliverTaskBoardEntry({
      taskId: channel,
      entryId,
      agentId,
      digest,
      ref: candidatePath,
      summary,
    });
    record({
      role,
      task: task.id,
      channel,
      entryId,
      agentId,
      pid: process.pid,
      stage,
      wallMs: Date.now() - startedAt,
      turns: execution.turns,
      reads: execution.reads,
      tokens: execution.tokens,
      cases: cases.length,
      passed: result.passed,
      failed: result.failed,
      conclusion,
      digest,
      continuedFrom,
      artifact: candidatePath,
      verdict: delivered.verdict ?? null,
      at: new Date().toISOString(),
    });
    process.stdout.write(`${task.id} ${stage}: ${summary}\n`);
  } catch (error) {
    // A stage that produced no usable artifact is a recorded failure, not a delivery. Nothing is
    // delivered, so the judge of this stage finds nothing and refuses rather than falling back to
    // another artifact - the failure stays visible instead of being absorbed by a verdict.
    const message = error instanceof Error ? error.message : String(error);
    // A failed stage must not keep its claim: leaving it held blocks the continuation it was
    // supposed to produce, and it would look like someone is still working on it.
    try {
      if (typeof entryId === "string") {
        store.releaseTaskBoardEntry({
          taskId: channel,
          entryId,
          agentId: agentFor(`worker-${stage}`),
        });
      }
    } catch {
      // Releasing is courtesy; the lease expiring is the guarantee.
    }
    record({
      role,
      task: task.id,
      channel,
      pid: process.pid,
      stage,
      failed: [message],
      turns: execution?.turns ?? null,
      reads: execution?.reads ?? null,
      tokens: execution?.tokens ?? null,
      sessionId: execution?.sessionId ?? null,
      wallMs: startedAt ? Date.now() - startedAt : null,
      at: new Date().toISOString(),
    });
    process.stdout.write(`${task.id} ${stage}: FAILED (${message})` + "\n");
    process.exitCode = 2;
  } finally {
    store.close();
  }
}

if (role === "release") {
  // A claim outlives the process that took it. Releasing it needs the identity the store recorded,
  // not a fresh one, so the holder is read back rather than guessed - and the release is refused
  // outright when the entry is not actually held.
  const task = taskOf(values.task);
  const channel = channelFor(task.id);
  const store = openStore();
  try {
    const held = store
      .readTaskBoard({ taskId: channel, limit: 200 })
      .entries.filter((candidate) => candidate.claimedBy)
      .at(-1);
    if (!held) {
      process.stdout.write(`${task.id}: no held claim to release
`);
    } else {
      store.releaseTaskBoardEntry({
        taskId: channel,
        entryId: held.id,
        agentId: held.claimedBy!,
      });
      record({
        role,
        task: task.id,
        channel,
        entryId: held.id,
        released: held.claimedBy,
        pid: process.pid,
        at: new Date().toISOString(),
      });
      process.stdout.write(`${task.id}: released ${held.claimedBy} on ${held.id}
`);
    }
  } finally {
    store.close();
  }
}

if (role === "judge") {
  const task = taskOf(values.task);
  const stage = values.stage;
  if (stage !== "part1" && stage !== "parent") refuse("--stage must be part1 or parent");
  const channel = channelFor(task.id);
  const store = openStore();
  try {
    const agentId = agentFor("judge-continuation");
    // A judge that falls back to "the latest delivery" would judge the wrong artifact whenever the
    // stage it was asked about never arrived. Fail closed instead.
    // The parent check judges what the continuation delivered; the continuation is the entry the
    // boundary opened, so its stage is the one to look for.
    const wanted = stage === "part1" ? "stage=part1" : "stage=part2";
    const entry = store
      .readTaskBoard({ taskId: channel, limit: 200 })
      .entries.filter((candidate) => candidate.content.includes(wanted))
      .filter((candidate) => candidate.deliverableDigest)
      .at(-1);
    if (!entry) throw new Error(`no delivered ${stage} artifact to judge in ${channel}`);
    if (entry.deliveredBy === agentId) throw new Error("refusing to judge my own deliverable");

    // The evidence check first: the bytes at the recorded ref must still hash to the digest.
    const bytes = readFileSync(entry.deliverableRef!);
    const observed = digestOf(bytes);
    if (observed !== entry.deliverableDigest) {
      throw new Error(
        `refusing to judge: artifact digest ${observed} != delivered ${entry.deliverableDigest}`,
      );
    }
    const result = await check(
      entry.deliverableRef!,
      stage === "part1" ? task.boundary : task.parent,
    );
    const verdict = result.failed.length ? "rejected" : "accepted";
    const reason =
      `${stage} check: passed=${result.passed}/${(stage === "part1" ? task.boundary : task.parent).length}` +
      (result.failed.length ? ` failed=[${result.failed.join("; ")}]` : "");
    const judged = store.judgeTaskBoardEntry({
      taskId: channel,
      entryId: entry.id,
      agentId,
      verdict,
      reason,
    });

    // The boundary is legal once part 1 is accepted: that is when the continuation is opened.
    let continuation: string | null = null;
    if (stage === "part1" && verdict === "accepted") {
      const content = [
        `parent=${task.id}`,
        "stage=part2",
        `file=${task.path}`,
        `continues=${entry.id}`,
        `part2=${task.part2}`,
      ].join("\n");
      continuation = store.putTaskBoardEntry({
        taskId: channel,
        agentId,
        kind: "handoff",
        content,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }).id;
    }
    record({
      role,
      task: task.id,
      channel,
      entryId: entry.id,
      agentId,
      pid: process.pid,
      stage,
      verdict: judged.verdict,
      cases: (stage === "part1" ? task.boundary : task.parent).length,
      passed: result.passed,
      failed: result.failed,
      artifactDigest: observed,
      continuation,
      at: new Date().toISOString(),
    });
    process.stdout.write(`${task.id} ${stage}: ${verdict} (${reason})\n`);
  } finally {
    store.close();
  }
}

if (role === "report") {
  const rows = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const table = TASKS.map((task) => {
    const mine = rows.filter((row) => row.task === task.id);
    const work = mine.filter((row) => row.role === "part1" || row.role === "part2");
    const judged = mine.filter((row) => row.role === "judge");
    return {
      task: task.id,
      stages: work.map((row) => ({
        stage: row.stage,
        passed: row.passed,
        cases: row.cases,
        turns: row.turns,
        reads: row.reads,
        tokens: row.tokens,
        wallMs: row.wallMs,
        continuedFrom: row.continuedFrom ?? null,
        failed: row.failed,
      })),
      verdicts: judged.map((row) => ({
        stage: row.stage,
        verdict: row.verdict,
        failed: row.failed,
      })),
    };
  });
  process.stdout.write(JSON.stringify({ tasks: table.length, table }, null, 2) + "\n");
}
