import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Research process driver. IPC controls timing; jobs/results travel over HTTP/board.
export class Actor {
  child: ChildProcess;
  stderr = "";
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  events = new Map<string, (value: any) => void>();
  ready: Promise<any>;

  constructor(role: string, database: string) {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("NMG_") &&
          !key.startsWith("NODE_TEST_") &&
          !["NODE_OPTIONS", "NODE_PATH"].includes(key),
      ),
    );
    this.child = fork(join(import.meta.dirname, "process-fixture.ts"), [role, database], {
      execArgv: ["--experimental-strip-types"],
      env: environment,
      silent: true,
    });
    this.ready = this.event("ready");
    this.child.stderr!.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.stdout!.resume();
    this.child.on("message", (message: any) => {
      if (message.event) {
        this.events.get(message.event)?.(message.value);
        this.events.delete(message.event);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error(`actor exited: ${this.stderr}`));
      this.pending.clear();
    });
  }

  event(name: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`missing ${name}: ${this.stderr}`)),
        20_000,
      );
      timeout.unref();
      this.events.set(name, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  }

  call(action: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${action}: ${this.stderr}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.send({ id, action, args });
    });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGKILL");
    await exited;
  }
}
