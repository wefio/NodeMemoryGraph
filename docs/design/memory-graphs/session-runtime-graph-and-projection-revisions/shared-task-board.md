# Shared Task Board (cross-Agent coordination, not a memory graph)

[中文](shared-task-board.zh-CN.md) · [Terms used](shared-task-board.terms.yaml)

**Authority:** [AG reference](../session-runtime-graph-and-projection-revisions.md).

### Shared Task Board (cross-Agent coordination, not a memory graph)

Use the board for attributed, expiring cross-Agent coordination, not durable
truth or shared private working memory. Normal model calls use `nmg_state` with
`space=board`; the [state-space contract](../../state-spaces.md) owns syntax,
dispatch, compatibility and coordination enablement. Legacy `nmg board` CLI and
`taskBoard` RPC use the same domain owner, not a second board.

One private AG cannot transmit state to another Agent. The daemon therefore keeps
an independent task/channel-scoped table. Entries may carry concise goals,
questions, blockers, results, handoffs or decisions, never secrets or hidden
chain-of-thought. Raw entries do not enter `memory_records`, LTG FTS, embeddings,
QPP or semantic training merely because they were read, resolved or accepted.
Durable memory needs a separate attributable `remember`; admitted outcome
protocols keep their own evidence conditions.

## Channels, identity and visibility

`taskId` names a channel, not an AG task frame or visibility hierarchy. Omission
selects world channel `default`. Named channels are independent; world reads
include a directory of active names/recency so Agents can discover and join by
name. Joining is implicit read/write. Current local sharing trusts callers who
know a channel name: there is no per-channel ACL or implied multi-device transport.
Directed delivery does not make an entry private.

Writer attribution lets readers identify the posting Agent and remains attached
to the entry. Adapter identity inputs include readable `NMG_AGENT_ID`, falling
back to session identity and then pid. System adapters register a stable agent
name and optional `NMG_AGENT_CAPABILITIES` outside model context. Pi registers at
session start/on wake; MCP registers on connect and heartbeats on board use;
passive Kimi reports presence each user turn only when a daemon already exists.
Discovery can filter the roster by capability. Presence, discovery and heartbeat
do not themselves wake an LLM or authenticate a malicious trusted caller.

## Work registry and claiming

An open attributed `goal` may register one coherent in-flight unit. Its content
contains the goal, intended approach and owned scope. The original writer need
not claim its own registry entry; a replacement Agent may claim it after an
interruption, deriving progress from Git and verification evidence. Resolve it
when completed or deliberately abandoned. This is an operating convention, not a
progress log: phases, tool calls, file lists and periodic checkpoints do not
create extra entries by default.

An open entry has at most one live claimant. Claiming is an atomic compare-and-set
for open + unclaimed, a lapsed lease, or the holder's own heartbeat. Losing CAS
uses a fresh read for diagnostics. Only the holder releases; resolving clears the
claim. Expiry is lazy, not a background sweeper. `claimedBy` and `claimExpiresAt`
record the lease.

A new claim that is not the same holder's live renewal starts attempt N+1 and
clears the old deliverable/verdict. A heartbeat is not a new attempt and must not
discard work in progress. Registry authorship does not waive the live-claim
requirement for artifact delivery.

## Deliverables, verdicts and closure

The [board governance decision](../../../decisions/implemented/2026-09-06-board-governance-addressing.md)
owns the delivery protocol; core operations live in `src/core/store/base.ts`.
Keep three facts separate:

- `deliver` requires the live claim holder on an open entry. It stores the
  artifact digest, optional `ref` and summary, not artifact bytes. Re-delivery in
  the same attempt replaces the artifact and voids the prior verdict. Losing the
  claim fails; use the current claim rather than retrying stale authority.
- `judge` requires a delivered artifact and a different Agent from its deliverer.
  The verdict names the digest it judged; a changed digest cannot inherit the
  verdict. `accepted`, `rejected` and `undecidable` remain distinct. The reviewer
  must inspect the actual artifact; recorded digest/summary alone does not prove
  execution or quality. Only a current `accepted` verdict supplies positive
  artifact acceptance, not the producer's self-report.
- `resolve` closes the entry's collaboration lifecycle, not artifact verification.
  Ordinary resolution is not restricted to the claimant; managed-write scope
  still applies. A separate independent veto marks a resolved self-report as
  contested without reopening it or undoing serial promotion. The resolver
  cannot veto its own resolve.

Delivery does not finalize an entry, and resolution does not manufacture a
verdict. Inspect the current attempt, artifact identity and independent verdict
before relying on a dependency. Acknowledgement is neither acceptance nor a claim.

## Wakes and resource lifetime

An opt-in wake loop polls subscribed spaces under a daily budget and cooldown.
Undirected entries can broadcast notifications; `put` with `to=<agent name>` wakes
only that stable target while other clients may still read it. This is addressing,
not an ACL. Registration/discovery remain passive.

Configuration is `~/.nmg/board-wake.json`, edited directly or through `/nmg`:
`/nmg wake on|off|status|budget N|cooldown M|interval S`. It does not use environment
variables for wake tuning. Values are substitutions, not a claim this page ran a
wake experiment.

Every wake writes an idempotent session+entry delivery receipt in
`task_board_deliveries`. Per-session `task_board_suppressions`, fed by
subscribe/unsubscribe, are checked before delivery. Recorded delivery,
acknowledgement, read handling, suppression and resolution govern eligibility
mechanically, rather than relying on a model to remember earlier notifications.

Ownership and lifetime are separate: claim leases select one worker; a session
owns its suppression/delivery state. Resolve clears claims, delivery receipts and
acknowledgements; TTL/expiry recycles entries, and lease expiry is lazy. The wake
timer is `unref()`'d so that timer alone cannot pin the process. A receipt records
notification, not task completion or artifact acceptance.

Once a request has been answered, resolve it and do not extend a resolved entry
with confirmation chains. New substantive work needs a substantive follow-up.
This is a disclosed collaboration convention, not an automatic inference that
an answer is correct.

## Memory pointers and private AG projection

Entries may carry `memory=<id>` pointers to durable LTG records. Readers expand
those with `nmg_get`, under normal memory/session rules. The pointer is plain
text, not a structured validated type. Reading it does not fetch the referenced
body or make private retrieval aliases shared. The board can refer to knowledge
without duplicating its authoritative content.

Ordinary reads stage only open entries into the reading Agent's private runtime
AG. Historical reads do not automatically stage context. Automatic continuity is
limited to the next user turn by the [state-space owner](../../state-spaces.md#unified-context-information-items);
it changes neither the original read result nor delivery bookkeeping. The Agent
judges relevance and uses maintained state for progress that must survive beyond
that window. No shared AG is created.

## Design lineage and boundary

World channels are a common-ground analogy (Clark); pointers resemble transactive
memory, where a group knows where knowledge lives. IRC-style discovery and
bounded shared-memory proposals are engineering comparisons, not validated
standards or research consensus. The layer connects private AGs and shared LTG
without becoming another authoritative semantic graph.

TTL keeps coordination temporary. Publishing/reading/resolving a board entry is
not LTG admission, factual support, a model-cost result or an authorization to
schedule work from prose. Execution and durable memory keep their own owners.
