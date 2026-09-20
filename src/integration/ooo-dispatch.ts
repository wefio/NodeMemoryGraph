/**
 * The loop that runs a plan to completion through a board, and the port it calls to produce work.
 *
 * Nothing here decides *what* to run: the ordered legal set comes from the board, the verdict is the
 * store's, and the one move about a session is `nextSessionMove`'s (or, when the caller has a run to
 * record facts in, `decideSessionMove`'s - the same rule plus the cancellation read). What this module
 * owns is the order of operations no caller should have to re-invent:
 *
 *   candidates -> claim a ticket -> freeze the task -> call the worker -> put the result on the
 *   board -> let the store decide -> account for it -> ask whether the session may continue.
 *
 * Two things are deliberately *not* decided here.
 *
 * The board is a port (`DispatchBoard`) of operations - candidates, accepted, claim, put, submit -
 * and not a class. The product's board satisfies it by being one; the research instrument's board
 * satisfies it structurally too. Naming either here is what would make the shared layer depend on
 * one of them, and a shared loop that only the instrument can call is not shared.
 *
 * The worker is a port for the same reason, plus one of its own: only the caller knows how a
 * candidate is produced. The arms supply a live model or a recorded one; a host supplies the session
 * runner it already has. A port that held policy would be the harness deciding, which is the boundary
 * this layer exists to keep.
 *
 * The arms' driver and a product path therefore run this one loop; what stays with them is their
 * declarations (the plan, each task's spec, the declared bound, the session declarations), their
 * worker, their session identity and their report. See
 * `docs/decisions/implemented/2026-09-19-dispatch-loop-is-shared.md`.
 */
import type { PatchWork, FrozenPatchWork } from "./ooo-patch.ts";
import { preparePatchWork } from "./ooo-patch.ts";
import type { SessionPlan } from "./ooo-execution.ts";
import { nextSessionMove } from "./ooo-fusion-plan.ts";
import { decideSessionMove } from "./ooo-session-facts.ts";
import type { NmgStore } from "../core/store.ts";

/** What a worker reports about its own run. The product's run surface records no worker metrics, so
 *  this shape is the port's, not a store column. */
export type WorkerMetrics = {
  tokens?: number;
  turns?: number;
  checks?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** What the provider did not serve from cache, what the model wrote, and the price it reported. They
   *  are recorded apart from `tokens` because a total cannot be taken apart again and the three are not
   *  priced alike. */
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  /** The digest of the input this unit's session was given, when the worker can name it: two runs that
   *  agree on the spec can still differ here, which is what makes an instrument version checkable. */
  promptDigest?: string;
  /** The session the worker actually ran this unit in, as the host names it. Omitted by a worker that
   *  has no session to report, and the field a fused run is judged on. */
  sessionId?: string;
};

/** What a worker returns for one unit. A failure is a recorded attempt, not a crashed run. */
export type PlanWorkerResult =
  string | { artifact?: string; metrics?: WorkerMetrics; failure?: string };

export type PlanWorker = (
  taskId: string,
  frozen: FrozenPatchWork,
  dependencies: Readonly<Record<string, string>>,
  session?: PlanSession,
) => Promise<PlanWorkerResult>;

/** The execution resource a fused run reuses across units. `id` is the identity the caller gave the
 *  session, and `units` is what it has already run - so a worker can refuse a continuation it cannot
 *  honour instead of quietly starting a new session and having the run call that fusion. */
export interface PlanSession {
  id: string;
  units: readonly string[];
}

/** The open handoff one unit is admitted through, as the loop reads it. */
export interface DispatchTicket {
  /** The claim's own attempt number: it names this try, so it is read from the claim and not from the
   *  frozen work, which the same task can be re-issued with. */
  readonly attempt: number;
  readonly dependencies: Readonly<Record<string, string>>;
  /** The frozen work this claim admits, absent when the task is not a patch task. */
  readonly patch?: PatchWork;
}

/** A board entry this run put on the channel. Only its identity is read here. */
export interface DispatchEntry {
  readonly id: string;
}

/**
 * The board operations a plan is dispatched through, and nothing else.
 *
 * Structural on purpose: the product's board and the research instrument's board differ in their
 * storage, their authority and their fact vocabulary, and neither is named here. A caller that has a
 * board satisfies this by being one, or by a thin adapter over it - which is where a board-specific
 * decision belongs.
 */
export interface DispatchBoard {
  /** The channel this run's entries go on. */
  readonly channel: string;
  /** The board's clock, as the loop stamps its entries with it. */
  readonly now: number;
  /** Which of the plan's tasks may be claimed right now, in the order they should run. */
  candidates(): readonly string[];
  /** The accepted artifact per task id: the rule every dependency and every parent check reads. */
  accepted(): Readonly<Record<string, string>>;
  /** Take one unit. The board re-checks legality here, so a stale answer becomes a refusal. */
  claim(taskId: string, owner: string): DispatchTicket;
  /** Put this run's entry on the channel, and say where it landed. */
  putTaskBoardEntry(input: {
    taskId: string;
    agentId: string;
    kind: "result";
    content: string;
    expiresAt: string;
  }): DispatchEntry;
  /** Let the board decide the verdict of a submitted result. The loop never reads a worker's claim
   *  about itself: this is the only verdict. */
  submit(entryId: string): Promise<string>;
}

/** One unit as the loop reports it: identity, verdict, where it ran, and the worker's own accounting. */
export interface DispatchedUnit {
  taskId: string;
  verdict: string;
  /** Claim to return: the worker's own time, which is what parallelism can overlap. */
  workerMs: number;
  /** The host's check for this unit's candidate. Host time is serial in every caller. */
  hostMs: number;
  tokens: number;
  /** Cache accounting for this unit's own turns. Recorded beside tokens because a chain carries its
   *  context forward, so a later unit's input is mostly a cache read - a different price, and the
   *  reason a token count alone cannot be read as a cost. */
  cacheRead: number;
  cacheWrite: number;
  /** The rest of the provider's own split, kept apart from `tokens` for the same reason. */
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** The prompt this unit's session was given, as a digest, when the worker reports one. */
  promptDigest?: string;
  attempt: number;
  /** The session the worker reported for this unit. A fused run's evidence is that two units name the
   *  same session; a worker that quietly starts a new one is not fusing, and its unit says so. */
  sessionId?: string;
}

/** One unit's own record of the session it ran in: absent when the worker reported none. */
function reportedSession(result: { metrics?: WorkerMetrics }): { sessionId?: string } {
  const sessionId = result.metrics?.sessionId;
  return sessionId === undefined ? {} : { sessionId };
}

/** The cache, input, output and cost accounting a worker reports for its own turns. */
function reportedUsage(result: { metrics?: WorkerMetrics }): {
  cacheRead: number;
  cacheWrite: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  promptDigest?: string;
} {
  const metrics = result.metrics;
  return {
    cacheRead: metrics?.cacheRead ?? 0,
    cacheWrite: metrics?.cacheWrite ?? 0,
    inputTokens: metrics?.inputTokens ?? 0,
    outputTokens: metrics?.outputTokens ?? 0,
    cost: metrics?.cost ?? 0,
    ...(metrics?.promptDigest === undefined ? {} : { promptDigest: metrics.promptDigest }),
  };
}

/**
 * The session capability a caller declares: that this host can carry several units in one session,
 * how many, and how it names such a session.
 *
 * Declaring it is what enters the chain path. The other two conditions the admission rule requires -
 * that the semantics allow the move, and that a continuable task is on offer at the boundary - are
 * decided per boundary by the shared move, not declared here, because they depend on what the units
 * did. See `docs/decisions/implemented/2026-09-19-when-the-chain-path-may-be-entered.md`.
 */
export interface SessionCapability {
  /** The declared bound on units per session. One is the control: the same loop, one unit per
   *  session, which is what a fused run is compared against. */
  bound: number;
  /** How this host names the session a unit starts. Supplied by the caller because the identity of a
   *  session is the host's - a run id, a harness session, an instrument's measurement key - and a
   *  shared loop that invented one would be promoting a grouping name to a product identity. */
  identity: (firstUnit: string) => string;
}

/** What the loop needs to run one plan. The declarations stay the caller's; the ordering does not. */
export interface DispatchPlanInput {
  /** The board the plan runs through: the product's, or an instrument's over the same loop. */
  board: DispatchBoard;
  /** Plan order. The legal set comes from the board, not from here; this is what must finish. */
  plan: readonly string[];
  /** How many legal units may be in flight at once. */
  slots: number;
  /** Declared session capability. Omitted, every unit gets its own session and the chain path is
   *  never entered. */
  sessions?: SessionCapability;
  /** The legality view the shared move reads. Built by the caller: the arms from their spec, a product
   *  caller from the frozen run and the board's own facts. */
  legality: (pendingBranches: readonly string[]) => SessionPlan;
  worker: PlanWorker;
  /** Who a unit's handoff is offered to and who therefore claims it: one name, one home. */
  ownerOf: (taskId: string) => string;
  /** Where a unit's session decision is recorded. Given, the decision is `decideSessionMove`'s - the
   *  same rule plus the cancellation fact read from the run's log, scoped to the unit's own task - and
   *  the move lands as a run fact. Omitted, the move is `nextSessionMove`'s pure answer and nothing is
   *  written. */
  sessionMoves?: { store: NmgStore; runId: string };
}

export interface DispatchOutcome {
  /** The units dispatched, in the order they were dispatched. */
  order: string[];
  units: DispatchedUnit[];
  /** The ids the store accepted, as it reports them. */
  accepted: Readonly<Record<string, string>>;
  /** One entry per session, whatever its length: a session of one unit is a yield boundary, and a run
   *  whose sessions are all singletons did not fuse anything. */
  sessions: string[][];
  /** Claims the board refused while a slot was asked for. Not failures: the work is still on offer. */
  slotRefusals: string[];
  failures: string[];
  /** The most units ever claimed at the same time: requested slots are a wish, this is the fact. */
  slotsUsed: number;
}

/** One unit's outcome, or why it did not become one. A refusal is not a failure. */
type UnitAttempt =
  { unit: DispatchedUnit; entryId: string } | { failure: string } | { refused: string };

/**
 * One unit through the board: claim, run the worker, put the result on the channel, submit. The store
 * decides the verdict; this loop never reads a worker's claim about itself.
 */
async function dispatchUnit(
  input: DispatchPlanInput,
  taskId: string,
  session?: PlanSession,
): Promise<UnitAttempt> {
  const board = input.board;
  const claimedAt = Date.now();
  let ticket: DispatchTicket;
  try {
    ticket = board.claim(taskId, input.ownerOf(taskId));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The board publishes a handoff only for the task it has selected, so while one unit is claimed no
    // other unit is claimable. That is a refusal to use a slot, never a failed unit.
    if (/no published handoff|not selected by narrow dispatch/.test(reason))
      return { refused: reason };
    return { failure: `${taskId}: ${reason}` };
  }
  if (!ticket.patch)
    return { failure: `${taskId}: the claim admits no patch work, so nothing can be produced` };
  const work = ticket.patch;
  const frozen = preparePatchWork({
    taskId: work.taskId,
    attempt: ticket.attempt,
    instruction: work.instruction,
    files: work.files,
    editable: work.editable,
    visible: work.visible,
    admittedConclusions: work.admittedConclusions,
    budget: work.budget,
    limits: work.limits,
  });
  let produced: PlanWorkerResult;
  try {
    produced = await input.worker(taskId, frozen, ticket.dependencies, session);
  } catch (error) {
    return { failure: `${taskId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const workerMs = Date.now() - claimedAt;
  const result = typeof produced === "string" ? { artifact: produced } : produced;
  if (result.failure !== undefined || result.artifact === undefined)
    return { failure: `${taskId}: ${result.failure ?? "the worker returned no artifact"}` };
  const entry = board.putTaskBoardEntry({
    taskId: board.channel,
    agentId: input.ownerOf(taskId),
    kind: "result",
    content: JSON.stringify({ ticket, artifact: result.artifact }),
    expiresAt: new Date(board.now + 86_400_000).toISOString(),
  });
  const checkStartedAt = Date.now();
  const verdict = await board.submit(entry.id);
  return {
    entryId: entry.id,
    unit: {
      taskId,
      verdict,
      workerMs,
      hostMs: Date.now() - checkStartedAt,
      tokens: result.metrics?.tokens ?? 0,
      attempt: ticket.attempt,
      ...reportedUsage(result),
      ...reportedSession(result),
    },
  };
}

/**
 * Run one plan: dispatch the legal set until nothing is left on offer, and account for everything.
 *
 * Every fact the loop reads - what is legal, what was accepted, whether a unit is cancelled - is read
 * from the board and the store at the moment it is needed, so a caller that stops and resumes, or two
 * callers of one run, see the same state instead of a caller's memory of it.
 */
export async function dispatchPlan(input: DispatchPlanInput): Promise<DispatchOutcome> {
  const board = input.board;
  const units: DispatchedUnit[] = [];
  const order: string[] = [];
  const failures: string[] = [];
  const slotRefusals: string[] = [];
  const chains: string[][] = [];
  let widestHeld = 0;
  /** How many claims the board has accepted. A round that adds none made no progress, and asking
   *  again would repeat the same answer forever. */
  let claims = 0;
  /** The units this pass has already taken a claim on. One pass takes each unit at most once: a unit
   *  the board did not accept is reported (`failures`, `incomplete`), and asking for it again in the
   *  same pass cannot change that - a retry is the caller's next call, which is where a retry policy
   *  belongs. Without this a refusal-shaped or failure-shaped answer repeats forever. */
  const attempted = new Set<string>();
  /** The entries the results landed in, by unit: the fact a session decision is attributed to. */
  const entryOf = new Map<string, string>();

  const dispatch = async (taskId: string, session?: PlanSession): Promise<UnitAttempt> => {
    order.push(taskId);
    const attempt = await dispatchUnit(input, taskId, session);
    // A refusal is the only outcome that did not claim anything: the board would answer the same way
    // next round, so the loop counts this and stops when a whole round adds nothing.
    if (!("refused" in attempt)) {
      claims += 1;
      attempted.add(taskId);
    }
    if ("unit" in attempt) {
      units.push(attempt.unit);
      entryOf.set(taskId, attempt.entryId);
      return attempt;
    }
    if ("refused" in attempt) slotRefusals.push(attempt.refused);
    else failures.push(attempt.failure);
    order.pop();
    return attempt;
  };

  /** The next unit that may continue this session, asked of the one owner of the move. Repair-first:
   *  it either admits the next legal successor or closes the session by name. */
  const nextInChain = (unit: DispatchedUnit, session: PlanSession): string | undefined => {
    const boundary = {
      current: unit.taskId,
      size: session.units.length,
      bound: input.sessions?.bound ?? 1,
      onOffer: board.candidates(),
    };
    const plan = input.legality([]);
    // A run to record in decides through the store-backed move: the same rule, plus the cancellation
    // read scoped to the unit's own task, and the decision lands as a run fact. A caller with no such
    // run (an instrument's own store holds no run manifest to append a fact to) decides through the
    // same rule, purely - not a second rule, and the reason a measurement run's move leaves no fact.
    if (!input.sessionMoves) {
      const move = nextSessionMove({ plan, ...boundary });
      return move.kind === "admit" ? move.unit : undefined;
    }
    const decision = decideSessionMove(input.sessionMoves.store, {
      runId: input.sessionMoves.runId,
      plan,
      ...boundary,
      // The fact names the boundary it belongs to: the unit that just ran, the attempt it ran as, and
      // the entry its result landed in. Without them every decision in a run would claim the same
      // (run, kind, task, attempt) key and the store would record the first one only, which is a
      // decision made and not written down.
      taskId: unit.taskId,
      attempt: unit.attempt,
      entryId: entryOf.get(unit.taskId) ?? null,
    });
    return decision.move.kind === "admit" ? decision.move.unit : undefined;
  };

  /** One session: claim and check each unit in turn, and continue only from a unit the host accepted.
   *  A unit that fails, or a successor that is not legal at the boundary, ends the session there -
   *  which is the yield boundary the design asks for, and why the accepted prefix survives. */
  const runChain = async (first: string): Promise<boolean> => {
    const sessionUnits: string[] = [];
    const session: PlanSession = {
      id: input.sessions?.identity(first) ?? first,
      units: sessionUnits,
    };
    /** The units the worker reported running in this session. Fusion's evidence: the loop asking for a
     *  session is not the fact - the worker's own report is. */
    const fused: string[] = [];
    let started = false;
    for (let current: string | undefined = first; current !== undefined;) {
      const id = current;
      const attempt = await dispatch(id, session);
      if (!("unit" in attempt)) break;
      const unit = attempt.unit;
      sessionUnits.push(id);
      started = true;
      if (unit.sessionId !== session.id) {
        // It ran somewhere of its own: that is a session of one, reported as one, and the chain ends.
        chains.push([id]);
        break;
      }
      fused.push(id);
      // Continuing is the shared rule's decision, not a second copy of it: the move already requires
      // the unit that just ran to be accepted, so a rejected or undecidable verdict ends the session
      // through the same predicate that guards every other boundary.
      current = nextInChain(unit, session);
    }
    // One entry per session, whatever its length. A chain that could not start is not a session: that
    // refusal is reported as a refusal, not as an empty session.
    if (fused.length) chains.push(fused);
    return started;
  };

  // The chain path is entered only when the caller declares that this host can carry several units in
  // one session. A bound on its own is not that claim, and without the declaration every unit is its
  // own session - the same loop, one session each, which is the control a fused run is read against.
  const chainPath = input.sessions !== undefined;
  for (;;) {
    const legal = board.candidates().filter((id) => !attempted.has(id));
    if (!legal.length) break;
    // A declared slot count is how many sessions may be open at once, in both paths. It is not cut to
    // one when sessions are declared: a fused run of two sessions is two chains running, and a loop
    // that quietly ran one would be answering a different question than the caller asked.
    const batch = legal.slice(0, input.slots);
    const before = claims;
    const held = await Promise.all(
      batch.map((id) => (chainPath ? runChain(id) : dispatch(id).then((a) => "unit" in a))),
    );
    widestHeld = Math.max(widestHeld, held.filter(Boolean).length);
    // Nothing was claimed in this whole round: the board refused every task it had just offered. The
    // refusals are reported and the work stays on offer, but a loop that asked again would spin - and
    // a caller that must stop is the caller that can retry, which is where that decision belongs.
    if (claims === before) break;
  }

  return {
    order,
    units,
    accepted: board.accepted(),
    sessions: chains,
    slotRefusals,
    failures,
    slotsUsed: Math.max(1, widestHeld),
  };
}
