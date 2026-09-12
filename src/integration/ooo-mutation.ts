/** A host-owned single-text-substitution fault. Mutation testing is what proves a
 *  gap: a mutant the frozen suite still passes on means no test detects that fault,
 *  which is a checkable reason to ask for a regression test. */
export interface Mutation {
  readonly id: string;
  /** Path inside the frozen baseline that the mutation edits. */
  readonly path: string;
  /** Exact text present once in that file. */
  readonly from: string;
  /** Replacement text. */
  readonly to: string;
}

/** Applies the substitution fail-closed: a mutant whose anchor text is absent or
 *  ambiguous cannot be silently skipped or applied twice. */
export function mutate(
  files: Readonly<Record<string, string>>,
  mutation: Mutation,
): Record<string, string> {
  const source = files[mutation.path];
  if (source === undefined) throw new Error(`mutant ${mutation.id}: unknown path`);
  const parts = source.split(mutation.from);
  if (parts.length !== 2)
    throw new Error(`mutant ${mutation.id}: anchor matched ${parts.length - 1} times`);
  if (mutation.from === mutation.to) throw new Error(`mutant ${mutation.id}: no-op`);
  return { ...files, [mutation.path]: parts.join(mutation.to) };
}
