import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  answerAttributionReferences,
  type AnswerAttributionReference,
} from "../src/core/feedback.ts";
import type { MemoryContext } from "../src/core/types.ts";
import { codexHookBinding, type CodexBinding } from "./session.ts";

export interface CodexTurnTrace {
  activeGraphId: string;
  memoryVersions: AnswerAttributionReference[];
}

/** Independent immutable files permit parallel MCP results without a shared writer slot.
 * References contain IDs and hashes. The daemon owns candidate text and derivation. */
export class CodexTurnTraces {
  readonly directory: string;
  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, "codex-sessions", "traces");
  }

  private path(binding: CodexBinding): string {
    codexHookBinding({ session_id: binding.nativeId, turn_id: binding.turnId });
    if (!binding.turnId) throw new Error("Codex trace needs a native turn");
    const generation = createHash("sha256").update(binding.sessionId).digest("hex");
    return join(this.directory, binding.nativeId, generation, binding.turnId);
  }

  async note(binding: CodexBinding, context: MemoryContext): Promise<void> {
    const id = context.activeGraph?.id;
    if (!id || context.results.length === 0) return;
    codexHookBinding({ session_id: id });
    const directory = this.path(binding);
    await mkdir(directory, { recursive: true });
    const record: CodexTurnTrace = {
      activeGraphId: id,
      memoryVersions: answerAttributionReferences(context.results).slice(0, 50),
    };
    await this.storeReference(directory, record);
  }

  private async storeReference(directory: string, record: CodexTurnTrace): Promise<void> {
    for (let slot = 0; slot < 32; slot++) {
      const path = join(directory, `${slot}.json`);
      try {
        await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // A concurrent writer may still be completing this slot.
      const existing = await readFile(path, "utf8").then(
        (text) => {
          try {
            return JSON.parse(text) as CodexTurnTrace;
          } catch {
            return undefined;
          }
        },
        () => undefined,
      );
      if (existing?.activeGraphId === record.activeGraphId) return;
    }
  }

  private async files(binding: CodexBinding): Promise<string[]> {
    try {
      return (await readdir(this.path(binding))).filter((name) =>
        /^(?:\d|[12]\d|3[01])\.json$/.test(name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async finish(
    binding: CodexBinding,
    record: (trace: CodexTurnTrace) => Promise<void>,
  ): Promise<void> {
    const cancelled = await access(join(this.path(binding), "cancelled")).then(
      () => true,
      () => false,
    );
    if (cancelled) return this.discard(binding);
    for (const name of await this.files(binding)) {
      const path = join(this.path(binding), name);
      const trace = JSON.parse(await readFile(path, "utf8")) as CodexTurnTrace;
      codexHookBinding({ session_id: trace.activeGraphId });
      if (!Array.isArray(trace.memoryVersions))
        throw new Error("Invalid Codex turn trace reference");
      await record(trace);
      await unlink(path);
    }
  }

  async discard(binding: CodexBinding): Promise<void> {
    for (const name of await this.files(binding)) await unlink(join(this.path(binding), name));
  }

  async cancel(binding: CodexBinding): Promise<void> {
    await mkdir(this.path(binding), { recursive: true });
    await writeFile(join(this.path(binding), "cancelled"), "");
    await this.discard(binding);
  }

  async observeOnce(
    binding: CodexBinding,
    callId: string,
    observe: () => Promise<void>,
  ): Promise<void> {
    const directory = this.path(binding);
    const id = createHash("sha256").update(callId).digest("hex");
    const path = join(directory, `observed-${id}.done`);
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await observe();
    await mkdir(directory, { recursive: true });
    await writeFile(path, "");
  }
  async continued(binding: CodexBinding, mark = false): Promise<boolean> {
    const path = join(this.path(binding), "continued");
    if (mark) {
      await mkdir(this.path(binding), { recursive: true });
      await writeFile(path, "");
      return true;
    }
    return access(path).then(
      () => true,
      () => false,
    );
  }
}
