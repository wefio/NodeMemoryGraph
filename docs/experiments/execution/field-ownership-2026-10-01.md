# Field ownership and the opaque dispatch seam

Measured on 2026-10-01, Windows / Node v24.19.0. This is controlled evidence, not a
live workload or an approval of the frame/storage proposal.

## Method

[The machine-readable record](field-ownership-2026-10-01.json) binds five compiled
models to their base revision and the SHA-256 of each semantic source. The
[probe](../../../evals/ooo-execution/field-ownership.ts) supplies the complete inputs
and assertions. From the repository root:

```sh
node --experimental-strip-types evals/ooo-execution/field-ownership.ts --out .temp/field-ownership-replay.json
```

The stored observation is preserved; replay writes a separate output. There are
no model calls, embeddings, database writes, or official benchmark data.

## Field observations

- **Effect class is not a write set.** Two `isolated-artifact` units propose the
  same `data/shared.txt` path and are both legal at two slots. Changing B's class
  to `local-write` leaves only A legal and names `effect-not-startable` for B.
  This observes a class-label gate, not resource-set exclusion. These are proposed
  artifacts, not concurrent writes to a shared file; it does not establish that
  arbitrary side effects are safe.
- **Input bytes and eligibility are distinct.** Changing A's frozen file content
  changes its declaration digest but leaves the legal set unchanged at the same
  declared revision and dependency facts. The freezer binds content; this
  eligibility calculation does not inspect the bytes. It does not authorize
  changing a live declaration or establish a universal input representation.
- **Declared edges bind release to acceptance.** With B depending on A, A is
  offered before acceptance and B after A's digest-bound acceptance fact. The
  fact is controlled input to the pure model, not a worker's self-report.
- **Operation interprets a result.** `double` and `sum` have the same legal set
  under a read-only unit with input `4`, but their answers are `8` and `0`.
  This shows the default snapshot interpreter's choice; it does not choose a
  storage location or prove that every future protocol has an operation field.

## Numeric adopter

[The port fixture](../../../tests/integration/ooo-work-shape.test.ts) declares
`{ digest, values: [2, 3] }`, not patch work. Its execution and named-refusal cases
failed against the patch-only loop, then passed through the opaque declaration
port. The carrier is required: a ticket without a declaration field cannot
silently satisfy the TypeScript port. An unsupported shape returns its name
before taking a lease or invoking a worker, and is recorded as a slot refusal.

[The real-store fixture](../../../tests/integration/ooo-value-store-board.test.ts)
adds a numeric adopter without modifying the store's coordination implementation.
It takes the real lease, delivers an artifact, records an outside verdict from
`numeric-judge` rather than `numeric-worker`, and releases the accepted result.
The declaration body is unchanged. Declaration validation and numeric acceptance
are in the adopter; the store does not interpret the numbers. Both fixtures ran
without a provider. Their four cases passed.

This is a small programmatic adopter, not an installed product peer protocol.
The real-store fixture uses existing `content` to transport its controlled
body. It neither adds the proposed `payload` columns nor validates the proposal's
content/payload separation, projection interface, protocol selectors, unknown
protocol quarantine, or threat model. Those are different tests and work.

## What remains undecided

The measurements support the [ownership decision](../../decisions/implemented/2026-09-21-mechanism-not-policy.md)
without making a vocabulary ratchet proof of a policy-free mechanism. Permission
closure read patch metadata and the session module mixed patch policy with
lifecycle at the measured revision. The ownership decision records the current
boundaries; the historical source hashes above are not claims about later code.
The store's patch-specific declaration storage remains a separate question.

Storage needs a distinct decision: the mechanism record assigns shape fields to
the declaration payload, while the [frame proposal](../../decisions/proposed/2026-09-21-the-frame-and-its-storage.md)
retains typed Task-Unit tables and requires the board payload to stay NULL for
Task-Unit entries. These observations do not choose whether to retain a
protocol-owned typed declaration or migrate it to an opaque task document. Do
not put a second copy of the task in the board payload to make the seam appear
complete.
