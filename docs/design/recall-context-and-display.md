# Recall context and display profiles

[简体中文](recall-context-and-display.zh-CN.md) · [Terms](recall-context-and-display.terms.yaml)

**Status:** current
**Related:** [InformationView](state-spaces.md), [automatic recall budget](session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.md)

## Query preparation

Unified local automatic recall uses the nearby context before retrieval for an
admitted short continuation. The current request can carry one preceding
substantive user message from the same session and project. An already expanded
query is used as supplied, and the Active Graph retains the original request.

## Candidate ordering

SQLite hybrid retrieval uses the same calibrated score fusion for explicit
search and both automatic recall profiles. The engine combines BM25 and vector
cosine scores from up to 100 candidates per route before loading source evidence.
The shared daemon carries this order into candidate selection and preview packing.
Cross-store reconciliation and primary-query priority govern assembly across
stores and queries. The [fusion decision](../decisions/implemented/2026-11-20-local-log-odds-fusion.md)
records the weights and calibration.

Session-bound results without calibrated hybrid ranking use contextual ordering
when no injected evidence ranking takes precedence. Contextual ordering reorders
the retrieved page before feedback staging and preserves its membership and
scores. The query preparation window is available to both automatic recall profiles.

Native turn admission supplies only the user prompt and project identity. The
daemon retains a bounded recent-prompt window per session. Assistant replies, tool
results and board state are not inputs to this window. Project changes discard
the previous project's prompts. Session release, cache eviction and daemon restart
discard context; display settings have a separate daemon-local lifetime.

The latest request supplies the primary lexical signal. Recent substantive user
context supplements terse continuations or requests overlapping that topic. A new
unrelated topic does not inherit the previous topic's overlap signal. The bounded
word segmentation ignores numeric-only terms and long hexadecimal identifiers.
Original rank provides a stable prior and tie break. Lexical overlap is a weak
ordering signal, not a relevance label or evidence of truth. Semantic matches
without word overlap stay available through the retained page and exact get.

## User profile

The local profile is a view over current long-term user-attributed preferences
and constraints in the exact `profile=user` scope. Records must be asserted or
verified. The existing visibility rules apply. Sensitive and externally
sourced records are excluded.

An explicit profile catalog shows the full statements grouped by preference
and constraint. Its structured `userProfile` field includes every matching
entry and its evidence IDs, independently of the bounded search candidate list.
Each entry's canonical memory ID opens its original evidence through get.
Exact reads mark source records with active profile links and return the
supporting evidence ID and linked profile memory IDs. These links are derived
from the current profile records in the same store and follow their lifecycle.

Once a host admits automatic recall, the daemon checks profile triggers against
the current request. A scoped search keeps its requested scope. An unscoped
automatic search can admit one profile entry when an explicit trigger matches.
The longest matching trigger takes priority. Earlier turns contribute to
ordinary recall only. The profile entry spends one existing candidate slot and
its preview is limited to 120 Unicode code points in both display modes.
The shared renderer charges the entire line, including its reference and labels,
to the host's context budget. It can omit the entry when space runs out.

The [profile write and maintenance reference](../../skills/nmg-memory/references/writes.md#user-profile)
shows how to inspect, update, and withdraw entries.

## Presentation and disclosure

Automatic recall uses a session-local `compact` or `full` display profile. Compact
uses brief statement previews and defaults to the five-candidate economy tier.
The shared preparation API accepts `economyLimit` of 3, 5 or 10. These tiers
allow up to 1,000, 1,500 and 2,500 UTF-16 units of available context, respectively.
Economy rows retain the memory ID, dates, flags and up to 160 code points of
statement preview. The structured get result provides the candidate's node and
memory type.
Full uses the entire retrieved statement for each admitted ordinary candidate. Forgotten
records remain redacted in both modes.

The compact projection carries the selected display mode. Shared candidate preparation
applies Unicode code-point truncation before producing InformationView rows;
reference IDs, graph scope, temporal labels and preview status are preserved.
Economy rendering displays identical preview and graph labels once for the group.
Each source-bound view and receipt retains its own scope.
The shared context renderer charges labels, section wrappers, separators and
omission notices in UTF-16 units. It fills successive character stages and keeps
whole candidate rows admitted at previous stages. Economy tiers pack in ranked
order; full mode applies floor-guarded length-density ordering ($k=40$, 400-unit
floor, $\alpha=0.5$) so short records keep their retrieved order while oversized
statements do not crowd out concise high-rank hits.
The full-profile stages admit up to 20 rows at 2,500 units, 32 at 4,000 and 48 at 6,000.
These are ceilings for the room available when recall is packed. Mixed context
can leave less room after admitting state and other higher-priority views.
For the same candidates and preceding content, advancing between the fixed
stages retains the lower stage's candidate rows with their source labels.
Both profiles produce candidate previews. Use get for exact record and source
disclosure and its receipts.

Pi uses the same candidate views inside its combined context output. OpenCode,
DSH and WorkBuddy use the shared automatic recall preparation. Adapters do not
clip the final prepared fragment or treat omitted candidates as delivered.
Historical UI recall is separate from the current turn's injectable generation;
a missing fresh result does not authorize reinjecting an old snapshot.

## Explicit search and exact evidence

Explicit search displays candidate previews with meaningful non-default types,
omitting node names and default memory types. Event times are collected in a
timeline keyed by local candidate labels. Equal times are grouped and known times
are chronological. Unresolved phrases keep their wording in a separate group.
Candidate order and executable memory references remain intact. Source excerpts
and external provenance belong to the exact read.

The get text shows the entire statement with its memory ID, node name, scope,
meaningful types, original event time and non-default truth status. It includes
external provenance and complete, distinct source texts for the selected records.
Logical chain structure is shown when present. A homogeneous explicit read
prints its shared scope once. The structured get result retains the underlying
metadata, including default values. Independently composable
evidence views carry their own scope and event time and use a bounded primary
source excerpt. Active Graph estimates use that composable row.

Plain local search defaults to 20 results. It fits the ranked candidate
prefix and available bookmarks into 5,500 UTF-16 units with up to 240 code
points per preview. A requested limit above 20 raises the page budget
proportionally. The graph records the fitted results and estimates their header
cost. Progressive and automatic recall use their own admission rules.

A plain hybrid search can use up to two tail slots for matching adjacent
source turns linked from its first two direct hits. The engine checks source
ordinals, scope, session, time filters and query terms before admitting a
neighbor. The combined result keeps the other direct hits in ranking order.
[Budget measurements](../experiments/retrieval/explicit-search-budget-2026-11-21.md)
record the held-budget comparison.

### Browse a memory neighborhood

An explicit local search consisting of a canonical memory ID browses that
record's neighborhood. A complete displayed `ref:` key uses the original
`activeGraphId` in the same owner session and project. The response contains
neighbors with their relationship to the anchor and their own readable references.
Use the normal search filters and result limit to narrow the page.

The engine looks for neighboring source ordinals within the same recorded source
session, then follows configured graph hops and fills available slots with
source-group and same-node records. Source adjacency requires an original numeric
turn identifier. The anchor's scope bounds expansion. The economy display
allocates its budget to the initial recall page. A caller can follow any visible
key in a separate search.

## Session controls and limits

`sessionActiveGraph action=recallDisplay` reads the profile, or sets it with
`mode=compact|full`. Settings affect the named session only. Restart and explicit
session release restore the compact default; evicting the recent-context cache
does not reset an explicitly selected mode. Ordinary explicit search retains its
existing presentation, and get continues to load exact selected records.

CLI usage is owned by the [memory operating reference](../../skills/nmg-memory/references/recall.md).
Initial values and tradeoffs are recorded in the [decision](../decisions/implemented/2026-10-07-shared-information-output.md#contextual-recall-and-display-profiles).
Tests establish page preservation, topic isolation, mode separation, redaction and
shared service wiring. They do not establish natural-conversation relevance gains
or downstream answer quality. Those require held-out conversation evaluation.
