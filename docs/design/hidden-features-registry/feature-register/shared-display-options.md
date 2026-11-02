# Shared display options

[简体中文](shared-display-options.zh-CN.md) · [Terms](shared-display-options.terms.yaml)

**Related:** [Feature register](../feature-register.md)

## Registered options

| Feature | Gate / option | Default | Meaning | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Long Task Board convention text | `TaskBoardSurfaceOptions.includeConventions=true` | off | Library callers request long conventions; ordinary tool results retain identity and coordination state without repeating conventions | `src/integration/agent-surface.ts`, `src/prompts/nmg-prompts.yaml`; [decision](../../../decisions/implemented/2026-10-07-shared-information-output.md) | implemented; no extra tool or capability |
| Automatic recall display profile | `nmg recall display --session-id ID --mode compact\|full` | compact | Session-local daemon-memory setting; full retains statements under shared output budget, independent of contextual ranking | `src/integration/recall-context-policy.ts`; [contract](../../recall-context-and-display.md) | source implementation; deployment separate |
