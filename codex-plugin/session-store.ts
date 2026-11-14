import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { codexHookBinding, type CodexBinding } from "./session.ts";

interface TurnScope {
  turnId: string;
  sessionId: string;
  projectDir: string;
}
interface SessionScope {
  version: 1;
  nativeId: string;
  sessionId: string;
  reset: boolean;
  turns: TurnScope[];
  commitNudge?: boolean;
}

function validTurn(value: unknown, nativeId: string): value is TurnScope {
  if (!value || typeof value !== "object") return false;
  const turn = value as TurnScope;
  try {
    codexHookBinding({ session_id: nativeId, turn_id: turn.turnId });
  } catch {
    return false;
  }
  return (
    typeof turn.turnId === "string" &&
    validSession(turn.sessionId, nativeId) &&
    typeof turn.projectDir === "string" &&
    isAbsolute(turn.projectDir)
  );
}

function validSession(value: unknown, nativeId: string): value is string {
  if (value === `codex-${nativeId}`) return true;
  if (typeof value !== "string" || !value.startsWith(`codex-${nativeId}-`)) return false;
  try {
    codexHookBinding({ session_id: value.slice(`codex-${nativeId}-`.length) });
    return true;
  } catch {
    return false;
  }
}

/** Host-owned routing metadata only. The daemon owns working state and evidence.
 * Each native chat has one file; only admission/reset hooks write it. MCP calls
 * read a captured turn binding, so concurrent calls never share a mutable slot.
 */
export class CodexSessionStore {
  readonly directory: string;
  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, "codex-sessions");
  }

  private path(binding: CodexBinding): string {
    // Validate even internal callers before constructing a filesystem path.
    codexHookBinding({ session_id: binding.nativeId });
    return join(this.directory, `${binding.nativeId}.json`);
  }

  private async read(binding: CodexBinding): Promise<SessionScope> {
    let raw: string;
    try {
      raw = await readFile(this.path(binding), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        nativeId: binding.nativeId,
        sessionId: binding.sessionId,
        reset: false,
        turns: [],
      };
    }
    const state = JSON.parse(raw) as SessionScope;
    if (
      state.version !== 1 ||
      state.nativeId !== binding.nativeId ||
      !Array.isArray(state.turns) ||
      state.turns.length > 128 ||
      !state.turns.every((turn) => validTurn(turn, binding.nativeId)) ||
      typeof state.reset !== "boolean" ||
      !validSession(state.sessionId, binding.nativeId)
    ) {
      throw new Error("Invalid Codex session routing record");
    }
    return state;
  }

  private async write(binding: CodexBinding, state: SessionScope): Promise<void> {
    const path = this.path(binding);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.pending`;
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch((cleanup: NodeJS.ErrnoException) => {
        if (cleanup.code !== "ENOENT") throw cleanup;
      });
      throw error;
    }
  }

  async admit(binding: CodexBinding, projectDir: string): Promise<CodexBinding> {
    if (!binding.turnId || !isAbsolute(projectDir))
      throw new Error("Codex admission needs a native turn and absolute cwd");
    const state = await this.read(binding);
    const previous = state.turns.find((turn) => turn.turnId === binding.turnId);
    if (
      previous &&
      (previous.sessionId !== state.sessionId || previous.projectDir !== projectDir)
    ) {
      throw new Error("Conflicting or obsolete Codex turn admission");
    }
    if (!previous) {
      state.turns.push({ turnId: binding.turnId, sessionId: state.sessionId, projectDir });
      state.turns = state.turns.slice(-128);
      await this.write(binding, state);
    }
    return { ...binding, sessionId: state.sessionId, projectDir };
  }

  async resolve(binding: CodexBinding): Promise<CodexBinding> {
    const state = await this.read(binding);
    const turn = state.turns.find((entry) => entry.turnId === binding.turnId);
    if (!turn) {
      if (state.reset) throw new Error("Codex reset requires hook admission for this native turn");
      return binding; // Explicit tools work without hooks; project scope stays unknown.
    }
    if (turn.sessionId !== state.sessionId) throw new Error("Obsolete Codex session generation");
    if (!isAbsolute(turn.projectDir)) throw new Error("Invalid Codex turn project scope");
    return { ...binding, sessionId: turn.sessionId, projectDir: turn.projectDir };
  }

  async reset(binding: CodexBinding): Promise<void> {
    const state = await this.read(binding);
    state.sessionId = `codex-${binding.nativeId}-${randomUUID()}`;
    state.reset = true;
    delete state.commitNudge;
    await this.write(binding, state);
  }

  async current(binding: CodexBinding): Promise<CodexBinding> {
    const state = await this.read(binding);
    const turn = state.turns.findLast((entry) => entry.sessionId === state.sessionId);
    return {
      ...binding,
      sessionId: state.sessionId,
      turnId: turn?.turnId,
      projectDir: turn?.projectDir,
    };
  }

  async nudge(binding: CodexBinding, consume = false): Promise<boolean> {
    const state = await this.read(binding);
    if (binding.sessionId !== state.sessionId) throw new Error("Obsolete Codex session generation");
    const pending = state.commitNudge === true;
    state.commitNudge = !consume;
    if (pending || !consume) await this.write(binding, state);
    return pending;
  }
}
