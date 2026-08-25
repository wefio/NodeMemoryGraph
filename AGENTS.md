# NMG Agent bootstrap

NMG is an Agent-native, local-first memory system. This file is only the stable
bootstrap; it does not duplicate the repository's changing design or status.

Before modifying the repository, follow `skills/repo-development/SKILL.md`:

1. Run `npm run agent:context -- --scope <target-path>`.
2. Follow the returned routes and read only their owning documents.
3. Preserve unrelated working-tree changes.
4. Do not treat experiments as normative design.
5. Run `npm run agent:verify -- --scope <target-path>` for the owned change. Use
   `--changed` only when the whole dirty worktree belongs to the same task.

For documentation changes, also follow `skills/doc-maintenance/SKILL.md`. For using
NMG memory or its coordination board, follow `skills/nmg-memory/SKILL.md`.
