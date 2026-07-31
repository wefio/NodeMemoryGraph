/**
 * Constructor constraint for the method-cluster mixins (DAG split, see
 * cluster-dag.test.ts and docs/store-cluster-split.md).
 *
 * Every cluster mixin takes a base constructor and returns a subclass:
 *
 *   export function withRetrieval<TBase extends Constructor>(Base: TBase) {
 *     return class extends Base { ... };
 *   }
 *
 * `Constructor` is the minimal constraint that admits class constructors of
 * any instance shape, so mixins compose without knowing the final NmgStore.
 */
export type Constructor<T = object> = new (...args: never[]) => T;
