# NMG Agent bootstrap

NMG is an Agent-native, local-first memory system. This file is only the stable
bootstrap; it does not duplicate the repository's changing design or status.

Before modifying the repository, follow `skills/repo-development/SKILL.md`:

1. Run `npm run agent:context -- <target-path>`. Positional paths select routes
   directly; `--changed` is a separate Git-dependent discovery mode.
2. Follow the returned routes and read only their owning documents.
3. Preserve unrelated working-tree changes.
4. Do not treat experiments as normative design.
5. After editing, run `npm run agent:verify`. It automatically routes the Git
   changes and persists the latest verification evidence. In a shared dirty
   worktree, use `-- <owned-path>` so unrelated changes stay outside the plan.

For documentation changes, also follow `skills/doc-maintenance/SKILL.md`. For using
NMG memory or its coordination board, follow `skills/nmg-memory/SKILL.md`.
