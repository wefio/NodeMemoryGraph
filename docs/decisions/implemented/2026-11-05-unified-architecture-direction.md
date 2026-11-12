# Separate memory backends, local coordination, and Harness integration

[中文](2026-11-05-unified-architecture-direction.zh-CN.md) · [Terms used](2026-11-05-unified-architecture-direction.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [target architecture](../../design/unified-architecture.md), [shared session flows](2026-10-16-shared-session-flows.md)

## Problem

The combined store exposes memory and coordination responsibilities together. The cloud path persists SQLite snapshots in object storage, while host integration shares some session flows but still lacks one explicit shared integration boundary. Treating SQLite snapshots as the only object-storage design does not give NMG independent, replaceable backends.

## Decision

The accepted direction has four boundaries: memory engine, replaceable memory backends, local SQLite coordination, and shared Harness integration with host bindings. The [portable backend profile](../../design/unified-architecture/native-backends.md) defines the bounded implementation; the complete target remains governed by its validation gates.

SQLite and native object storage implement the same domain storage contract. NMG retains graph organization and memory semantics. A backend can supply retrieval; preserving NMG's text/vector implementation is not a requirement. LanceDB is the first candidate to validate, with SlateDB as a fallback foundation. The [target design](../../design/unified-architecture.md) owns contracts and adoption gates. Candidate preference is not a validated library selection or a deployment commitment.

pi durable is the selected cloud Harness. Its NMG binding shares integration behavior with local hosts and uses the authenticated cloud memory endpoint. The Harness owns durable execution; NMG owns memory semantics. The [Harness integration design](../../design/unified-architecture/harness-integration.md) owns recovery and external-effect contracts. This acceptance is not compatibility evidence; no cloud NMG coordination service is introduced.

Magpie is an additional gateway integration candidate. The [Magpie design](../../design/unified-architecture/magpie-integration.md) separates automatic recall from explicit tool access and limits completion capture to the host's best-effort contract. It does not replace a Harness or establish full native-plugin capability coverage.

The follow-up [operations-panel draft](../../design/unified-architecture/magpie-operations.md)
uses Magpie's existing UI for NMG statistics and embedding settings, then adds
gateway observations alongside native bindings. It keeps store/configuration
ownership in the shared service so another UI can reuse it. The draft does not
establish delivered metrics, an operator API, or a working Magpie adapter.

The [versioned interface map](../../design/unified-architecture/magpie-capabilities.md)
grounds that draft in Magpie `0.1.3545` source and each native adapter's wiring.
It favors gateway embedding transport over copying upstream keys, Pi for the
first trace join, and MCP-only clients for added automatic recall. Native
lifecycle ownership stays intact. Source review does not replace runtime
integration evidence.

Capability coverage is composed across the client's connected entry points,
including native adapters, MCP, hooks, CLI/Skills and Magpie. The
[shared composition model](../../design/unified-architecture/harness-integration.md#compose-capabilities-across-connected-entry-points)
assigns providers per operation and retains explicit gaps. This avoids requiring
either MCP or Magpie to become a complete Harness and allows their supported
handoffs to supply a broader flow. The model is a design direction; combined
runtime coverage still requires integration evidence.

## Alternatives considered

- SQLite snapshots as the object backend: useful for reusing database behavior, but does not satisfy the requested independent native-object path. Keep the current format as a migration source.
- Build all object transactions and indexes inside NMG: incurs recovery, compaction and retrieval maintenance before reuse has been exhausted. Prefer an existing engine that meets the domain contract.
- Require the same retrieval implementation on every backend: preserves physical implementation rather than graph meaning and prevents reuse of available retrieval.
- Choose SlateDB first: closer to a transactional KV foundation, but leaves more retrieval work; the user accepts backend-provided retrieval, so validate LanceDB first.
- Extend collaboration into a distributed object store: adds remote coordination outside the requested local-only boundary.
- Require separate local memory and coordination database files: adds configuration without a physical isolation requirement. Keep separate ownership in one local SQLite file by default.
- Rewrite each host plugin separately: duplicates session policy instead of extending the existing shared-flow direction.
- Treat Magpie hooks as a complete Harness adapter: the client still owns tools and execution, while completion notification is not durable. Keep a gateway-specific capability subset.

## Consequences

The opt-in Node implementation pins LanceDB 0.41.0 and stores domain entities and
receipts together on a staged native branch. A conditional head revision publishes
the complete branch. This avoids pretending that independent Lance table updates
form a cross-table transaction. SQLite implements the same commit port using its
own transaction and WAL snapshots. Native full-text retrieval is accepted for this
profile. Conditional S3 publication is exercised through the native HTTP driver;
provider deployment and cost validation remain separate gates.
The dependency tree overrides `sharp` to 0.35.5 to address transitive native-image
advisories; Lance embedding integrations need separate compatibility validation.

An explicit application option selects the backend. It does not convert existing
databases or replace the default/AML path. Board/run transactions remain local;
the run coordinator receives a narrow coordination port. The pure local SQLite
profile defaults to the service database file for both responsibilities; interfaces
and table ownership remain separate. Shared Harness endpoint
binding owns session generation, method checks and stable invocation-derived
write IDs; concrete host plugins retain the separate integration gates.

The common abstraction includes reads, queries, graph access and commits, not a generic object `put`. Library fit depends on whole-change atomicity and the deployment runtime. Backend-specific ranking is allowed while identity, visibility and graph semantics remain invariant. The local SQLite default and existing public tools remain in effect until implementation slices pass their gates.

## Deferred

Production library adoption, provider/runtime deployment, benchmarks, branch collection and compaction, migration rehearsals, the cloud interactive API and concrete host plugins need further evidence. This decision does not authorize a production deployment or a user-database conversion.
