# Temporary guardrails

Guardrails are blocking tests with an explicit removal or promotion plan. Each guardrail lives in
`tests/guardrails/<id>/` beside a `guardrail.yaml`:

```yaml
id: daemon-startup-race
status: active
reason: Prevent duplicate daemons while lifecycle ownership is being redesigned.
review_after: 2026-10-01
exit_criteria: Replace with the stable daemon ownership contract or remove after the redesign ships.
```

The test may block CI while active. A guardrail is not a permanent design decision: when its exit
criteria are met, delete it or promote the behavior to a durable safety/contract test.
