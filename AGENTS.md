# NMG Agent bootstrap

This entry owns the stable discovery protocol. Keep module inventories, commands,
implementation status, and environment-specific setup at their current owners.

## Find the context for the next action

1. Search for the task's terms, symbols, or error text in a narrow relevant scope.
   Use the current directory tree and manifests to locate code; expand the search
   only when that scope does not answer the question.
2. Read applicable instructions along the target path and the nearest relevant
   README. Find repository Skills by their names and descriptions; follow the
   development workflow before editing and the specialized workflow when its
   stated condition applies.
3. Read the relevant contract section and the exact code or test involved. Keep
   its definitions, conditions, and exceptions together. Follow a reference when
   it supplies a missing definition, an affected dependency, or an applicable
   obligation; a background link alone is not a requirement to read another file.
4. Stop expanding when the next action, its constraints, and its verification are
   clear. Reopen discovery when evidence conflicts or the task crosses a boundary.

## Maintain shared knowledge

Use current code and owning documents to establish facts; experiments and past
decisions supply evidence and rationale. Update the existing owner with a behavior
change rather than adding another summary. Preserve unrelated working-tree edits.

Do not place necessary files in cache folders, including TEMP and tmp. Please
follow Git best practices when using Git.

It is essential to write code that is readable, maintainable, and extensible. You
can employ appropriate design patterns to achieve this, but avoid using patterns
simply for the sake of using them. If a problem can be solved with a simple
`if-else` statement, there is no need to implement a combination of Strategy,
Factory, and Chain of Responsibility patterns. Cramming too many patterns into a
single class often results in over-engineering.

Required knowledge must be recoverable from the shared repository or an explicit
shared task reference. Local memory, indexes, and prior Agent sessions are optional
accelerators, never the only source needed to continue work.
