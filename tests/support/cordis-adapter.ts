import { Context } from "@deepseek-ai/cordis";

export interface TestEffectScope {
  effect(register: () => void | (() => void | Promise<void>), name?: string): void;
}

export type TestEffect = (scope: TestEffectScope) => void | Promise<void>;

export interface CordisTestRuntime {
  use(effect: TestEffect): Promise<void>;
  dispose(): Promise<void>;
}

type DisposableFiber = { dispose(): Promise<void> };

/** The only runtime factory exported by the Cordis boundary. */
export function createTestRuntime(): CordisTestRuntime {
  const root = new Context();
  const fibers: DisposableFiber[] = [];
  let disposed = false;

  return {
    async use(effect) {
      if (disposed) throw new Error("Cordis test runtime is already disposed");
      const fiber = await root.plugin((context) =>
        effect({
          effect(register, name) {
            context.effect(register, name);
          },
        }),
      );
      fibers.push(fiber);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const fiber of fibers.reverse()) await fiber.dispose();
      fibers.length = 0;
      await root.fiber.dispose();
    },
  };
}
