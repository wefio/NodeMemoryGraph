/**
 * Constructor constraint for the method-cluster mixins (DAG split, see
 * cluster-dag.test.ts and docs/design/store-cluster-split.md).
 *
 * Every cluster mixin takes a base constructor and returns a subclass:
 *
 *   export function withRetrieval<TBase extends Constructor>(Base: TBase) {
 *     return class extends Base { ... };
 *   }
 *
 * `Constructor` is the minimal constraint that admits class constructors of
 * any instance shape, so mixins compose without knowing the final NmgStore.
 *
 * NOTE: the rest parameter MUST be `any[]` (official Handbook form). The
 * compiler's mixin check requires exactly `new (...args: any[])` — `never[]`
 * triggers TS2545 ("A mixin class must have a constructor with a single rest
 * parameter of type 'any[]'") at the assembly site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- required by the mixin check (TS2545), see NOTE above
export type Constructor<T = object> = new (...args: any[]) => T;
