import type { ComputeResourceProfile } from "./compute-contracts.ts";

interface LockState {
  readers: number;
  writer: boolean;
  waiters: Array<{ exclusive: boolean; wake: () => void }>;
}

function collectSortedLocks(profile: ComputeResourceProfile | undefined) {
  if (!profile) return [];
  const map = new Map<string, boolean>();
  for (const r of profile.reads ?? []) map.set(r, map.get(r) ?? false);
  for (const w of profile.writes ?? []) map.set(w, true);
  for (const ex of profile.exclusive ?? []) map.set(ex, true);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, exclusive]) => ({ key, exclusive }));
}

/** Event-driven per-resource R/W/Exclusive lock manager with zero polling. */
export class ResourceLockManager {
  private readonly locks = new Map<string, LockState>();

  async withResources<T>(
    profile: ComputeResourceProfile | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const keys = collectSortedLocks(profile);
    if (!keys.length) return fn();
    const releases: Array<() => void> = [];
    try {
      for (const { key, exclusive } of keys) {
        releases.push(await this.acquireOne(key, exclusive));
      }
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i -= 1) releases[i]!();
    }
  }

  private acquireOne(key: string, exclusive: boolean): Promise<() => void> {
    let state = this.locks.get(key);
    if (!state) {
      state = { readers: 0, writer: false, waiters: [] };
      this.locks.set(key, state);
    }
    const grant = () => {
      if (exclusive) state!.writer = true;
      else state!.readers += 1;
      return () => this.releaseOne(key, state!, exclusive);
    };
    const free = exclusive ? !state.writer && state.readers === 0 : !state.writer;
    if (free) return Promise.resolve(grant());
    return new Promise((resolve) => {
      state!.waiters.push({ exclusive, wake: () => resolve(grant()) });
    });
  }

  private releaseOne(key: string, state: LockState, exclusive: boolean): void {
    if (exclusive) state.writer = false;
    else state.readers = Math.max(0, state.readers - 1);
    while (state.waiters.length > 0) {
      const head = state.waiters[0]!;
      const canWake = head.exclusive ? !state.writer && state.readers === 0 : !state.writer;
      if (!canWake) break;
      state.waiters.shift();
      head.wake();
    }
    if (!state.writer && state.readers === 0 && !state.waiters.length) {
      this.locks.delete(key);
    }
  }
}
