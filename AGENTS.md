# NMG Agent bootstrap

NMG is an Agent-native, local-first memory system. This file is only the stable
bootstrap; it does not duplicate the repository's changing design or status.

Before modifying the repository:

1. Run `npm run agent:context -- --scope <target-path>`.
2. Follow the returned routes and read only their owning documents.
3. Preserve unrelated working-tree changes.
4. Do not treat experiments as normative design.
5. Run the verification selected by the context report.

For documentation changes, follow `skills/doc-maintenance/SKILL.md`. For using
NMG memory or its coordination board, follow `skills/nmg-memory/SKILL.md`.
