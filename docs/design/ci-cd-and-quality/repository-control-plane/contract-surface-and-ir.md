# Contract surface and IR

[中文](contract-surface-and-ir.zh-CN.md) · [Terms used](contract-surface-and-ir.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.md).

## Contract surface and IR

Use this reference when writing a Contract or interpreting its compilation and
assertion-evidence reports. A Contract states the desired result, scope and
constraints. It is not a sequence of shell operations; a replaceable planner or
provider chooses the actions.

The declaration format is YAML or JSON, compiled into stable, Agent-neutral
Contract IR. It borrows CUE's constraint semantics and OPA's pure-policy boundary
without introducing their complete runtimes or product scope.

### Write a bounded declaration

The following example illustrates the schema. Replace its intent, scope and
assertion with the real change. Its `node-test:daemon-cli` binding is not a claim
that this one route proves the entire daemon/Core dependency boundary.

```yaml
apiVersion: repository.nmg.dev/v1alpha1
kind: AgentChange
metadata:
  id: rcp-001 # stable once referenced
spec:
  intent: "what should be true"
  scope:
    include: ["src/**"]
    exclude: ["docs/experiments/**"]
  preserve: ["public protocol compatibility"]
  assertions:
    - id: daemon-independent
      statement: "NMG daemon must not depend on RCP"
      domain: "NMG daemon and Core imports in this repository revision"
      assumes: []
      strength: witness
      check: "node-test:daemon-cli"
      kind: test
      stage: unit
  verification:
    routes: ["product"]
    checks: ["npm run agent:verify"]
  authority:
    mode: plan # plan | apply | continuous
  extensions: {}
```

Each assertion names its `domain` and `assumes`; use `[]` when no registered
assumption applies. Give it either a `check` or `documentedOnly: true`, not both.
Omitting both evidence choices, or omitting the required claim fields, fails
compilation. Successful compilation establishes schema consistency, not the
truth or adequacy of the assertion.

A check resolves to a package script, `node-test:<route>` for route-level
evidence, or `node-test:<route>#<test name>` for a named test. `rtm:check` checks
that the named test exists in that route's files. The
[verification-traceability workflow](../../../../skills/verification-traceability/SKILL.md)
owns how to choose the domain, assumptions and evidence strength.

### Read assertion evidence, not just inventory

`rtm:check` is blocking in `verify:static`, narrow shared checks and both authored
contracts. It prints an evidence report under the
[evidence-aggregation decision](../../../decisions/implemented/2026-09-20-rtm-evidence-aggregation.md).
Counts of assertions, resolvable checks, documented-only items, uncovered items
and orphan checks are inventory; they do not decide whether a claim holds.

Each assertion receives its own standing from execution evidence recorded by
`agent:verify` in `.nmg/verification/latest.json`:

| Standing | What the recorded evidence says |
| --- | --- |
| `executed` | The carrying command passed at the current revision. |
| `historical` | It passed at another revision; that is not current execution. |
| `not-run` | This run recorded a skip or failure, with a reason. Only a failure belonging to the current run fails the gate. |
| `not-recorded` | No record, carrying command or evidence file is available. |
| `documented-only` | The claim has no executable evidence binding. |
| `uncovered` | The claim lacks coverage. |

Risk classes—strength, kind and stage—and contracts spanning several routes are
judged separately. Unresolved items enter counterexamples. The report explicitly
has no aggregate verdict. Receipts capture the printed report; check `evidence`
output is attached only when the check fails.

### Preserve identity when evolving the schema

The IR normalizes defaults, paths, source locations, diagnostics and extension
namespaces and computes `contractDigest`. Syntax upgrades must not change a
referenced `metadata.id`. Unknown required fields fail closed. Unknown optional
extension data may be retained, but must not execute silently.
