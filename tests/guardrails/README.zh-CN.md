# 临时护栏

护栏是带有明确移除或晋升计划的阻断型测试。每个护栏位于
`tests/guardrails/<id>/`，旁边有一份 `guardrail.yaml`：

```yaml
id: daemon-startup-race
status: active
reason: Prevent duplicate daemons while lifecycle ownership is being redesigned.
review_after: 2026-10-01
exit_criteria: Replace with the stable daemon ownership contract or remove after the redesign ships.
```

该测试在 active 期间可以阻断 CI。护栏不是永久的设计决策：当其退出条件满足时，
删除它，或把该行为晋升为持久的安全/契约测试。
