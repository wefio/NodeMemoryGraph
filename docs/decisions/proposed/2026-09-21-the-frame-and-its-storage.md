# The frame, its data format, and its storage

[中文](2026-09-21-the-frame-and-its-storage.zh-CN.md)

**Status:** proposed
**Relates to:** [The program answers legality](2026-09-20-the-program-answers-legality.md), [Name the collaboration protocol and its task-unit sub-protocol](../implemented/2026-09-20-name-the-collaboration-protocol.md), [Protocol-governed collaboration: the parts, the gaps](../../design/protocol-governed-collaboration.md), [Board governance and capability addressing](../implemented/2026-09-06-board-governance-addressing.md), [Task unit semantics](../../design/task-unit-semantics.md)

## Problem

The primitives are named, the umbrella is inventoried, and the program's job - answer legality - is
proposed. What is still undefined is the frame itself: which fields exist, how their values are encoded,
where they live in the store, and how a **peer** protocol sits beside the Task-Unit Protocol. Left open,
every addition re-opens the same questions, and the natural answers are the expensive ones: parse the
payload in order to route, add a column per protocol, invent a fresh vocabulary per protocol.

A survey of finished specifications changes the shape of the problem. Every layer but one is already
defined by somebody, so the work is choosing and naming, not inventing:

| Layer                                                       | Already defined by                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event envelope: identity, time, version, content type, mode | CloudEvents 1.0 - required are only `id`/`source`/`specversion`/`type`; context attributes are "inspected at the destination without having to deserialize the event data"; attribute names are lowercase ASCII, at most 20 characters, never `data`; the type set is closed |
| Task, parts, states, paging                                 | A2A 1.0.0 - terminal-state semantics, `contextId`, cursor paging (`pageToken`/`nextPageToken`, chosen explicitly over offsets), `historyLength`, and `includeArtifacts` defaulting false "to reduce payload size"                                                            |
| Payload discriminator and progressive shape                 | NLIP / ECMA-430 - `messagetype`, `format`, `subformat`, `content`, `submessages[]`, `label`; the first submessage is inlined at the top because most messages carry none; `format: structured` with `subformat: uri` carries a URI instead of bytes                          |
| LLM-facing results and errors                               | MCP 2025-06-18 - content blocks with `annotations.audience`, `structuredContent` beside text, and `isError` in the result, so a failure is data                                                                                                                              |
| One-line text encoding                                      | RFC 8941 Structured Fields - List/Dictionary/Item with Parameters, intentionally strict                                                                                                                                                                                      |
| Acts and conversation threading                             | FIPA-ACL - `performative` is the only required field, beside `protocol`, `conversation-id`, `in-reply-to`, `reply-by`                                                                                                                                                        |
| Unknown-field policy                                        | RFC 6709 - ignoring and refusing by name are both legitimate; the choice has to be stated                                                                                                                                                                                    |
| Security                                                    | ECMA-434 and the NLIP security guidelines - mandatory for NLIP conformance, with a scored threat list                                                                                                                                                                        |
| **Ownership, lease, fencing, legality**                     | **Nobody.** Every agent protocol assumes a task belongs to one agent, so "who may hold it" does not arise                                                                                                                                                                    |

## Proposal

### 1. The frame

The frame is a board entry, and it is a **state record, not a message**. That distinction decides the
field set: the acts are already state columns (a claim, a delivery, a verdict, a resolution), so FIPA's
`performative` is a rendering of those columns rather than a column of its own.

- **Header columns** (the board acts on these alone): `id`, `channel`, `kind` (the seven collaboration
  kinds, unchanged), `state`, `author`, `source_session`, `to`, `need`, `scope`, `created_at`,
  `expires_at`, `lease{holder, until}`, `attempt`, `digest`, `verdict`, `acked`, `resolution`, plus the
  protocol selectors `protocol` and `protocol_version`.
- **One payload document**: whatever the named protocol needs, opaque to the board.
- **Rendering, not storage**: the act an entry shows (FIPA's `performative`), and the progressive tiers
  T0 header, T1 summary, T2 structure, T3 truth.

### 2. The data format, three separate questions

- **Wire bytes.** JSON over the daemon's existing RPC. Unchanged; no second binding exists to justify
  code generation, so A2A's protobuf-as-normative-source answer is not adopted yet.
- **LLM tokens.** T0 and T1 render as flat key/value lines, not as JSON with braces and quotes. The
  negotiation text stays natural language: forcing a model to emit JSON for prose costs reasoning
  (format constraints measurably degrade it, and stricter constraints degrade it more), and escaping is
  a failure source. Structured content is never inlined in the body - it is reached through the
  discriminator and a pointer. An agent's own writes are tool arguments validated by the harness, and
  those schemas follow strict mode: `additionalProperties: false` on every object, every property listed
  in `required`, absence expressed as nullable rather than by omission.
- **Storage.** Typed columns for the header, one JSON document for the payload (section 3).

Deliberately not adopted at this layer: TOON (its 30-60% saving applies to flat uniform data that has to
be pushed into context, which is exactly what pointer-first avoids), CBOR with a JSON fallback (ECMA-432
deferred until a transport with a bandwidth constraint exists), and protobuf as a normative source.

### 3. Storage layout and its invariant

The header stays in columns because the claim is one atomic compare-and-set `UPDATE`. A header inside a
JSON document would turn atomic claiming into read-modify-write. That is a mechanism constraint, not a
preference.

The payload is one document beside those columns, and the board never parses it. The store already keeps
this shape: `claims_json`, `markers_json`, `scope_json`, `evidence_ids_json` and others sit beside typed
columns in the same tables.

**Invariant (testable):** with `payload` set to NULL for every row, T0 and T1 still render and claim,
wake, expiry and compact read still work. Verified against the store's own SQLite (3.53.3).

When a protocol needs to query a field inside its own payload, it does not ask the board for a column: a
generated column plus an expression index answers it (also verified on the same SQLite). This is what
keeps the schema from growing with the number of protocols.

Cost, stated plainly: JSON columns give up database-level typing, a trade the store already makes, and
cross-protocol queries depend on generated columns or the protocol's own tables.

### 4. Peer protocols and replacement

The protocol is a **value**, not a schema. The Task-Unit Protocol is one value; a peer protocol is
another, and the board's coordination layer stays protocol-agnostic (envelope, addressing, time and
lease, claim and fencing, delivery digest and verdict, wake, scope, retention).

A peer protocol supplies four narrow things:

1. **Declaration validation** - refuse by name when a field it cannot map is missing, never downgrade it
   to free text (the semantics design already states this rule).
2. **Legality** - the definition of which units are legal under the current facts. This is the party that
   defines the answer "the program answers legality" is about.
3. **Projection** - the T1 summary line and the T2 structure. Required because the payload is opaque to
   the board, and the shape MCP and A2A already use for the same reason.
4. **Acceptance** - the criteria for accepting a delivery. The form (digest plus independent verdict)
   does not change.

The insertion points already exist: `DispatchBoard` and `RoundQueryPort`. A protocol plugs in on the
semantics side, and replacing one means another implementation plus another `protocol` value; the payloads
of entries written under the old value stay exactly as they are - readable, not actionable, and no
migration.

Unknown handling is stated rather than assumed: an unknown `protocol` makes an entry readable and not
actionable, and an unknown field inside a known protocol is decided by that protocol's version rule,
which must say whether it is ignored or refused by name.

### 5. Security, the layer that is empty

ECMA-434 is a conformance requirement for NLIP, and its companion security guidelines score fifteen
threats - prompt injection highest, then confused-deputy and token passthrough, session hijack, memory
injection. Two rules are adoptable now as text:

- An in-band session token is a session credential: it must not be handed to the agent's model or exposed
  in application-level payloads. The board's session identity is in-band and the board renders into model
  context, so this rule applies to us directly.
- A caller's token is never forwarded; a scoped token is minted instead. This becomes load-bearing only
  when entries cross a trust boundary, which today they do not.

What is owed is a threat list of our own, with the ones we accept and the ones we do not defend.

### 6. Scope ceiling

The change surface is one group of nullable columns, one boundary adapter, one rendering rule and one
test. Anything that needs a new table, a new tool or a new channel is outside this decision.

## Plan

1. This record. No code.
2. One migration: `protocol`, `protocol_version`, `payload_format`, `payload`, plus the invariant test.
3. Refusals become data at the RPC and tool boundary; the store keeps throwing.
4. Tool schemas shaped for strict mode; flat T0/T1 rendering.
5. A threat list, with the two rules carried as text until a trust boundary exists.

## Alternatives considered

- **One JSON document for the whole entry, header included.** Rejected: atomic claiming becomes
  read-modify-write, and every reader would have to parse to find out whether an entry is claimable.
- **A column group per protocol.** Rejected: the schema grows with the number of protocols and every new
  protocol has to touch the board, which is the rework this record exists to avoid.
- **protobuf as the normative source with generated bindings** (A2A's answer). Rejected for now: there is
  one wire and no second binding, so code generation buys nothing yet.
- **A single-line RFC 8941 encoding for the header.** Rejected for storage - our header lives in columns
  - but kept as an option if a compact textual read is ever needed.
- **TOON.** Rejected: the saving appears on flat uniform data pushed into context, and the frame is flat
  with pointers instead.
- **CBOR with a JSON text fallback.** Deferred until a transport with a bandwidth constraint exists.
- **Storing the structured payload as JSON inside the entry body.** Rejected: escaping failures, the
  reasoning cost of format constraints, and MCP's own note that structured content is a different thing
  from schema-constrained model generation.

## Acceptance criteria

- With every `payload` NULL, the board renders T0/T1 and completes claim, wake, expiry and compact read.
- Adding a peer protocol changes nothing in the board's claim, wake or expiry paths, demonstrated by a
  second protocol value with its own payload shape and its own projection.
- An entry whose protocol the store does not know is readable, is not actionable, and its payload is never
  parsed by the board.
- A payload field a protocol wants to query is indexed by a generated column and an expression index,
  with no new board column.
- Header field names follow the borrowed naming constraints: lowercase ASCII, at most 20 characters, and
  `data` is not used as a name.
- A refusal reaches the caller as data with a reason, not as an exception, at the RPC and tool boundary.
- LLM-facing schemas are strict-mode shaped, and no negotiation text is required to be a JSON string.
- Every new field names the specification it came from, or records why none fitted.

## Risks

- One document per entry invites over-stuffing: the header can drift into the payload until the board has
  to parse it again. The invariant test and the never-parse rule are the mitigation.
- A protocol that projects its own summary can summarize dishonestly. Mitigation: projection is separate
  from the verdict, and only `accepted` may be depended on.
- Generated columns and expression indexes are SQLite-specific; a portable store would have to re-examine
  them.
- Refusals-as-data changes the shape existing callers see, so the arms' drivers have to move in the same
  slice.
- Strict-mode schemas make absence explicit, which costs tokens per call and can make a nullable field
  read as mandatory.
- A borrowed vocabulary can ossify. If a borrowed name does not fit, deviating is allowed - and the
  deviation is recorded rather than renamed silently.
