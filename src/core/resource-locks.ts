import type { ComputeResourceProfile } from "./compute-contracts.ts";

interface LockState {
  readers: number;
  writer: boolean;
}

export function hasNamedResources(profile: ComputeResourceProfile | undefined): boolean {
  return Boolean(profile?.reads?.length || profile?.writes?.length || profile?.exclusive?.length);
}

/** Atomically acquires a node's whole resource set. Waiting owns no partial lock. */
export class ResourceLockManager {
  private readonly locks = new Map<string, LockState>();
  private readonly listeners = new Set<() => void>();

  onRelease(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tryAcquire(profile: ComputeResourceProfile | undefined): (() => void) | undefined {
    const keys = resourceKeys(profile);
    for (const [key, exclusive] of keys) {
      const state = this.locks.get(key);
      if (state && (state.writer || exclusive)) return undefined;
    }
    for (const [key, exclusive] of keys) {
      const state = this.locks.get(key) ?? { readers: 0, writer: false };
      if (exclusive) state.writer = true;
      else state.readers += 1;
      this.locks.set(key, state);
    }
    return () => this.release(keys);
  }

  async withResources<T>(
    profile: ComputeResourceProfile | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release =
      this.tryAcquire(profile) ??
      (await new Promise<() => void>((resolve) => {
        const unsubscribe = this.onRelease(() => {
          const acquired = this.tryAcquire(profile);
          if (!acquired) return;
          unsubscribe();
          resolve(acquired);
        });
      }));
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(keys: ReadonlyMap<string, boolean>): void {
    for (const [key, exclusive] of keys) {
      const state = this.locks.get(key)!;
      if (exclusive) state.writer = false;
      else state.readers -= 1;
      if (!state.writer && state.readers === 0) this.locks.delete(key);
    }
    if (keys.size > 0) {
      for (const listener of [...this.listeners]) listener();
    }
  }
}

function resourceKeys(profile: ComputeResourceProfile | undefined): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  for (const key of profile?.reads ?? []) keys.set(key, false);
  for (const key of profile?.writes ?? []) keys.set(key, true);
  for (const key of profile?.exclusive ?? []) keys.set(key, true);
  return keys;
}
