# Historical event source clocks

[简体中文](event-time-source-clocks.zh-CN.md) · [Terms](event-time-source-clocks.terms.yaml)

**Authority:** [Feature register](../feature-register.md).

## Registered options

| Feature | Gate(s) | Default | Values / meaning | Location | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Historical event source clock | `referenceTime`, `timeZone`; RPC capability `event-time-reference`; CLI `--reference-time`, `--time-zone` | unset; write clock and host locale | Resolve explicit event phrases against each source calendar while retaining ingestion time; clients refuse contextual calls to older owners | `src/core/event-time.ts`, remember protocol and adapters | [Source-clock contract](../../design/event-time-source-clocks.md) | isolated contracts; live deployment and benchmarks not exercised |
