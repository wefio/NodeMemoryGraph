# Slim AG exposure, shared information views and maintained state

[中文](2026-10-06-ag-state-transitions.zh-CN.md) · [Terms used](2026-10-06-ag-state-transitions.terms.yaml)

**Status:** proposed
**Relates to:** [Session AG decision](../implemented/2026-08-29-session-active-graph-runtime.md), [AG runtime](../../design/session-active-graph-runtime-design.md), [Task continuity](../../design/task-unit-semantics/task-continuity.md#长任务的连续性与任务视图-1)

The [shared information-output foundation](../implemented/2026-10-07-shared-information-output.md) is implemented; the remaining state/input protocol is still proposed, and slice A is not complete.

## Problem

The user's stated preference is to slim existing model-visible AG content first and add SKILL.state-like rules/protocol for maintaining and displaying current state, because excessive injection quickly exhausts context. “Display” means model exposure, not merely terminal UI. The user agrees to shared typed information views and an explicit output protocol for AG and the board, but rejects a dependency on Pi codemode orchestration to preserve generality. Specific wire fields, update triggers and budgets remain unvalidated; the overall mechanism is not implemented.

Preserve AG's role from [design.md Definition](../../design/design.md#definition) and [Session AG update and projection revisions](../../design/design/active-graph-activation-and-consolidation/session-ag-and-projection-revisions.md#session-ag-update-and-projection-revisions-1): a private, session-owned resident working graph, not a third authoritative memory store. Exposure cost is the problem; deleting everything retained internally is not the objective.

Relevant implementation boundaries:

- [`renderSessionActiveGraphSurface()`](../../../src/integration/agent-surface.ts) displays truncated temporary-item lists, not maintained current state.
- Candidate rendering in that file includes IDs, nodes, types and previews, with templates adding format explanations and next-step hints. Their utility differs; not every field is necessary on every exposure.
- [`composeNmgContextMessage()`](../../../.pi/extensions/nmg/index.ts) combines recall, runtime AG, nudges and status in persistent appended session messages. Cache hits may reduce billing but do not remove context occupancy.
- [`observe()`](../../../src/core/session-active-graph.ts) deduplicates content hashes; a changed statement becomes another item. An instruction to maintain state does not give that API replacement semantics.

## Proposal

### 1. Scope: lightweight display protocol, not an execution-state engine

Separate two changes:

1. **Slim exposure:** reduce AG/memory auxiliary content entering the model, removing redundant, irrelevant or unnecessarily expanded material.
2. **Maintain state:** carry a short current working snapshot in the existing AG/task frame, updating and displaying it under rules instead of accumulating old state and tool logs.

Do not make domain schemas, generic JSON patches, versioned field stores, dependency invalidation engines, new tools or a separate SkillStateStore prerequisites. If existing carriers lack current-snapshot replacement, add only the minimal mechanism needed for this display protocol, not an execution framework.

Borrow the rule “retain current state needed for future work rather than replay history by default” from [SKILL.state v3](https://arxiv.org/html/2608.26263v3). Its evaluation does not fully separate authored schemas, content maintenance and history removal. Do not attribute its results to this protocol or promise constant complete prompts. [The Horizon Gap v1](https://arxiv.org/html/2608.06663v1) informs attribution and process evidence, not a requirement to inject all historical evidence.

### 2. Default exposure: current state and an on-demand directory

Do not serialize the entire AG into the prompt. Default exposure provides:

- **Short current state:** task-relevant information sufficient to continue working.
- **Evidence entry points when needed:** directly show short sufficient content without extra headers, summaries or references. Use entry points when details are long and not currently needed. Candidate-directory IDs remain necessary for get addressing; previews do not become verified facts.

Candidate directories discover knowledge; working state supports continuity. Do not automatically copy all retrieved candidates into state or remove necessary explicit search/get access.

Priorities for slimming:

| Content | Default treatment | Boundary to preserve |
| --- | --- | --- |
| Unchanged material already visible | Avoid repeated full injection | Reassess visibility after compaction or input replacement |
| Repeated format explanations, long disclaimers and operation tutorials | Put at existing stable tool/policy owners; keep only necessary short dynamic reminders | Remove redundant expression, not provenance, validity or authority rules |
| Internal topology, scores and debug metadata | Exclude from ordinary context | Preserve internal traces and administration |
| Candidate node/type/time/scope attributes | Show when relevant to disambiguation or validity | Never omit interpretation-critical time, scope, revocation, external provenance or hypothesis labels |
| Long outputs, old state and resolved process descriptions | Exclude from default working-state exposure | Keep necessary sources accessible under existing permissions and retention |
| Original evidence | Compact entry points by default; expand on demand | Explicit exact-evidence requests must not silently lose evidence to display slimming |
| Feedback nudges | Short prompts only for reviewable opportunities, not repeated tutorials | Silence, retrieval and state updates are not positive feedback |

Avoid repeating the same content in state, recall and evidence within one dynamic surface. Remove unnecessary fields before arbitrarily truncating every record. Compact previews retain decision-relevant values, identifiers, relations and negation rather than only vague topic labels.

### 2.1 Borrow compact reads and explicit maintenance, not the shared state machine

Existing board primitives live in [`TaskBoardEntry/TaskBoardPreview`](../../../src/core/types.ts), [`readTaskBoardPreviews/readInboxTaskBoard`](../../../src/core/store/base.ts) and [`renderTaskBoardSurface`](../../../src/integration/agent-surface.ts). Borrow their read/maintenance semantics without forcing AG into the same DTO or writing private state to the board:

| Board mechanism | AG counterpart | What not to import |
| --- | --- | --- |
| Separate identity/status from short content; bounded previews | Content first; identity/status only when necessary for disambiguation or validity | Do not routinely show author, lease, attempt, ack or verdict coordination headers |
| `readInbox` exposes actionable work for this agent | Prioritize state needing attention in the current task, not all cooled frames or old observations | Relevant knowledge is not an instruction; AG is not an inbox replica |
| `memory=<id>` and deliverable refs point to original owners | Keep exact immediately necessary values; reference large evidence by stable ID/path | A pointer list cannot replace critical visible facts; do not copy authoritative bodies |
| Closed/expired entries leave default active views | Invalid, expired or no-longer-relevant state leaves default exposure | Coordination `resolve` is not authority for AG to grant acceptance |
| The [in-flight registry convention](../../../skills/nmg-memory/references/board.md#in-flight-registry) avoids per-step progress entries | Revise one current snapshot instead of adding a progress record per tool call | Borrow the convention, not shared-board publication of private summaries |

Borrow separation of exposure from internal records, on-demand reads and explicit closure, not a fixed short header + body + references template. Packaging can exceed the body. Include headers, summaries and references according to necessity and whole-block cost. Minimal presentation primitives may be shared; maintenance and access authority retain separate owners.

Preserve two current limitations:

- Board `afterCursor` continues after creation order. Claim, resolution and verdict changes to older entries do not automatically acquire a new cursor position. AG refresh cannot treat that cursor as a complete change feed. Use current-state reads or relevant host-provided change signals and restore snapshots after compaction.
- Current board rendering repeats conventions by default. Do not import that exposure cost into AG. Conventions stay at stable owners with situational dynamic reminders. Compact reads do not establish that all default board output is already small.

The [frame/storage proposal](2026-09-21-the-frame-and-its-storage.md#2-the-data-format-three-separate-questions) further separates wire/storage structures from model display and proposes layered summaries and pointers. It remains proposed: this direction does not make selectors, payloads or T0–T3 interfaces implemented dependencies. AG remains private and resident, with no new shared entry, board kind or task identity.

### 2.2 Host-neutral typed information views and explicit output

Share data/output contracts, not a database, graph type or collaboration state machine. Ordinary tool/RPC calls are the baseline; direct calls, SDK clients and any host orchestration consume the same operations/results. Borrow Pi codemode's separation of capability declarations, structured data and explicit output, without depending on its JavaScript, QuickJS, text(), store/load, execution lifecycle or an extra orchestration adapter. Codemode can already call ordinary tools and needs no dedicated NMG entry points. Clients without codemode must remain fully functional.

| Boundary | AG | Board | Shareable facilities |
| --- | --- | --- | --- |
| Scope/residence | Private session/frame, memory-resident | Shared channel; entries may span sessions, governed by TTL and closure | Source handles and admitted information projections, not storage |
| Update/control | Current-state replace/clear and frame lifecycle | Publication, claim/resolve/deliver/judge, leases and independent verdicts | Typed arguments/results and failure representation, not permissions/state machines |
| Exposure | Working content, observations and source projections | Entry content and necessary collaboration status | Representation selection, budgets, fingerprints and detail entry points |

AG also owns references, activation, edges and retrieval projections; shared views do not reduce it to an entry container. Sharing does not make board content factual truth or grant AG projections authority to mutate board coordination.

The minimal view carries content, owner-declared necessary labels, optional detail entry points and internal source binding. Full domain types remain with their owners. Internal binding reuses existing identity and covers exposure-relevant version/fingerprint, without another authoritative identity system. Owners protect necessary time, scope, hypothesis and coordination labels; unnecessary labels/references need no display space. Identical bodies with different sources/permissions cannot be deduplicated by text alone; unchanged content with changed claim/verdict/validity cannot fold against an old fingerprint.

Shared results distinguish:

1. **Admitted data views:** for ordinary tools or programmatic consumers, excluding raw internal graphs, hidden reasoning and unauthorized metadata. Reading is not disclosure.
2. **Prepared output:** representation and budget selection under §6.2. Ordinary tools can return it directly as response content without an extra emit tool or script.
3. **Actual output confirmation:** adapters bind final model-input content to its sources before the session owner commits disclosure under §6.3. Generated text, received structured data and successful operations do not substitute for confirmation.

```text
AG working items / board entries
  -> admitted typed information views
  -> content-first representation and total budget
  -> ordinary tool response or other host output
  -> actual content/source confirmation -> caller-session disclosure ledger
```

NMG defines types/results; Pi content/structuredContent/details, MCP, CLI and other SDKs map them rather than defining core fields or runtime dependencies. Count and confirm whatever fields a host actually sends to the model; a field called structured data is not automatically invisible. After wrapping, clipping or output failure, confirm only content that remains exposed. Unverifiable source association conservatively prevents already-disclosed folding. One agent's exposure of shared entries never changes another agent's ledger.

Board owners continue to enforce argument validation, identity, leases, permissions and independent verdicts, regardless of whether clients loaded long instructions. Successful output is not acceptance; failed output does not roll back completed AG/board writes. Retry/idempotency semantics remain operation-specific. Creation-cursor limitations stay at §2.1 and do not become a complete change feed through shared views.

### 3. Maintained-state display rules

These are rules to test, not a mandatory domain schema. State may be short prose or a list. Field names need not be fixed; empty sections need not consume display space.

1. **Purpose:** retain task-local information whose omission could cause wrong actions, missed obligations, constraint violations or repeated failures.
2. **Content:** as needed, represent current goal/phase, necessary facts and dynamic limits, still-relevant failed attempts, unresolved questions and next action. Do not copy stable task instructions.
3. **Maintenance:** update when new observations change those contents, on task switches or when recovery needs it. Not every tool call or turn requires a separate summary. Use the model's ongoing work; do not add a background summarization LLM by default.
4. **Replacement:** display one latest snapshot; revise old values and remove invalid ones instead of appending “state N.” Completed process detail exits the default surface when it no longer affects future work.
5. **Reliability:** preserve necessary hypothesis/unverified labels and source entry points. Intent is not outcome; action results or original-owner judgments are needed for success/acceptance statements.
6. **Scope:** state belongs to the current session/frame, not unrelated tasks. A different query within the same task does not clear it. When task identity is uncertain, retain explicit scope instead of guessing switches.
7. **Budget:** use a small display budget for state. Move recoverable details out first; if critical content does not fit, report insufficiency or narrow the work rather than silently dropping constraints.
8. **Degradation:** an unconfirmed new summary does not replace trustworthy working evidence. State remains a provisional interpretation, not an authorized source. Removed exposure does not imply an event never occurred.

Illustrative content, not repository facts or a fixed template:

```text
Unicode regression still failing; inspect character boundaries next, preserving the public interface.
```

Use separate lines for independent unresolved issues. Include exact failure conditions or source entry points only when needed to continue; labels, IDs and references are not mandatory on every body.

Do not include every file read, test invocation or reasoning trace. Exact paths, test names, values and input conditions remain when they determine the next action; brevity must not destroy operational precision.

### 4. Exposure lifecycle: short snapshots cannot append indefinitely

Distinguish:

- current state retained inside AG;
- content exposed by this projection;
- messages already accumulated in the host's model context.

Even a short snapshot grows context if appended in full every turn. Slimming reduces increments, not necessarily history-free execution. Suggested injection behavior:

- Do not fully reinject unchanged state still visible in context. Maintenance frequency and display frequency can differ.
- Where the host supports input selection/replacement, include only the latest state message in the next model input. Audit records may remain in the session log without all entering model context.
- Where replacement is unavailable, expose short snapshots at meaningful changes/recovery boundaries and retain existing compaction lifecycle, explicitly acknowledging accumulation. A protocol cannot make old messages disappear.
- After compaction, replacement or recovery, restore necessary current state/evidence. The disclosure ledger must follow actual visibility rather than folding absent content because it was once shown.

Existing `projectionId` continues to attribute exposure and feedback. A state refresh is neither a new task nor factual confirmation. Do not attribute displayed state to a retrieval projection that did not contain it. Reuse existing projection/source mechanisms when association is needed, not another authoritative task state.

### 5. Total exposure budget and recovery boundaries

Measure this NMG dynamic exposure as a whole: directories, current state, reminders and expanded content, rather than independent generous limits per block. Defaults and explicit evidence expansion may have different budgets, but expansion remains bounded and reports undisclosed parts.

Measure existing output before choosing budget values/allocation; guessed token limits are not product guarantees. Besides per-call characters/tokens, measure per-turn increments, complete-context growth and compaction frequency. Resident item/character caps do not measure actual model exposure.

Slimming cannot erase critical constraints, identifiers, source access boundaries or truth labels. HistoryRecord, tool/host receipts and task records retain their existing admission/retention owners. Do not copy all output into LTG or retain hidden reasoning. Fetch authorized earlier sources when relevance emerges later; report gaps if missing. Release still deletes private AG. This protocol creates neither durable checkpoints nor shared state.

### 6. Implementable slices and document ownership

#### 6.1 Who writes state, and where it lives

The agent proposes a complete short text under §3's rules; shared admission checks identity, size and write policy; the daemon replaces the current frame's AG state. Content has no domain-field schema, nested patches or implicit merges.

Add a `working_state` item to existing `FrameState.items`, using a fixed frame-local internal identity rather than content-hashed entries for each revision. Retain content, fingerprint and invocation provenance internally. Reuse session/frame lifecycle and resident budgets, with no database or parallel store. Ordinary observe cannot write this dedicated item. Rejected/oversized writes preserve the previous value. Cooling, eviction and release follow the frame owner; report necessary-state insufficiency rather than truncating and reporting success.

Default tools have no direct current-AG-state writer. Propose a low-risk, session-scoped `working_state` capability through existing `nmg_lab`, initially explicit opt-in, forwarding directly to AG rather than the separate reasoning-workspace scratch graph. The model needs two operations:

```text
replace(input={text: complete new current state})
clear(input={})
```

Return only `updated`, `unchanged` or `cleared`, without echoing content or conventions. Bind session/frame from trusted host execution context rather than arbitrary model-selected frames; reject late writes after ownership/context changes. The first slice supports serial updates by the owning agent, not multi-writer merges. Internal reads reuse `sessionActiveGraph.snapshot`; the model need not read before every write. New capability/operations require existing discovery/gate integration and are proposals, not currently available tool functionality.

While current state is enabled, the host maps existing task identity to one AG frame and passes that binding through subsequent search/observe/replace calls; query changes do not change the binding. Without reliable task identity, use an explicit session working frame with clear scope, not query-hash-driven migration or a board channel as task identity. Such adapters promise session-local current state, not semantic A→B→A recovery.

Replacement changes provisional text only, not LTG or collaboration state. Shape/budget validation cannot prove free-text correctness. Hypothesis/outcome distinctions rely on maintenance rules and independent acceptance, not a claim that the API detects every false summary.

#### 6.2 Content-first representation

The shared renderer receives §2.2's admitted typed information views, actual visibility and display budget, without invoking a summarization model or script runtime. Choose a valid representation:

| Situation | Representation | Required check |
| --- | --- | --- |
| Short sufficient current text | Direct body | Clear task context; necessary labels retained |
| Critical values with long supporting evidence | Body plus necessary source entry point | No duplicate facts or lost exact conditions |
| Large detail not currently needed; source accessible | Meaningful short preview or reference | Valid entry point; reference/hint overhead justified |
| No safe compact form or oversized state | Insufficiency/overflow result | No silent loss or invented source |

Internal DTO metadata need not all enter model text. For forms preserving equally necessary information, compare complete cost including body, labels, references, separators and hints. Keep direct text when packaging is longer. No universal length threshold decides all content types. State and candidate directories remain distinct under §2; short bodies do not eliminate necessary addressing IDs.

Shared code owns budgets; state writers cannot raise them. Separate default-dynamic-surface and working-state limits, with the latter inside the former; determine values from baselines/matched experiments. Character hard caps provide inexpensive checks, existing token estimates support comparison, and real model token counts determine acceptance. Explicit evidence get keeps its existing contract without new truncation in this slice.

#### 6.3 Update, disclosure and input wiring

```text
necessary new observation -> agent decides whether to replace/clear
                         -> session-owned AG updates its unique current state
next model-input preparation -> collect recall/current state/necessary reminders
                             -> deduplicate, content-first rendering, shared budget
                             -> actual host exposure -> record disclosed content
```

Budget admission and §2.2's actual output confirmation precede disclosure-ledger commitment. Candidates/state absent from final input cannot become already_in_context. Direct tool responses and internal programmatic reads use the same result contract, but internal reads cannot commit disclosure early. If successful update arguments remain in the next model input, state is already visible and must not immediately be fully reinjected. Otherwise show the snapshot at the next necessary exposure/recovery boundary. Existing disclose mutates the ledger: implementation must adjust call ordering rather than marking every retrieved item and then dropping rendered content.

Host wiring must cover actual next-input preparation, including tool loops, not only user-turn start. Verify adapter support; one before-agent-start call is not proof every inference is processed. State/projection provenance follows §4. Failed exposure preserves working state; compaction/input replacement resets visibility, not current state.

A host with input selection can identify a dedicated AG-state message/fragment using internal session/frame/type metadata and retain its latest version before inference, without keyword-based history deletion. Touch only NMG-owned state fragments, not user messages, tool calls/results, source evidence or task policy. Existing mixed nmg-context messages cannot be removed wholesale without losing recall/evidence. State-writing tool arguments themselves remain historical context and count toward cost. Replacing state fragments does not make the whole dialogue history-free.

Hosts without input selection use §4's change-triggered append and compaction recovery, reporting append-only operation. Adapter capability reporting is internal, not repeated model-facing explanation.

#### 6.4 Smallest implementation sequence

| Slice | Change | Independent claim to verify |
| --- | --- | --- |
| A: shared views and pure slimming | Existing public types/results, shared agent-surface, prompt wording, total dynamic budget and output confirmation | Ordinary tools work without orchestration dependencies; less wrapping/repetition preserves critical information, excluding state-maintenance benefits |
| B: current-state protocol | AG dedicated item, replace/clear through existing RPC, Lab descriptor and short acknowledgement | Model can write one replaceable state while retaining private/provisional boundaries |
| C: host visibility | Actual input wiring, latest-fragment selection, compaction recovery and fallback reporting | Old AG state fragments genuinely leave input, without extending that claim to tool history |
| D: matched evaluation | Existing/slim/slim-plus-maintenance arms under Acceptance criteria | Continuity benefit at matched display cost and justified maintenance overhead |

Shared types/results live with existing core/protocol owners; exposure rules live at [`agent-surface.ts`](../../../src/integration/agent-surface.ts), the [prompt source](../../../src/prompts/nmg-prompts.yaml) and existing AG owner. Declare capabilities at [`lab-capabilities.ts`](../../../src/integration/lab-capabilities.ts) and daemon/protocol discovery. Adapters map identity, result fields, actual output confirmation and host lifecycle only. Core code imports no Pi/codemode API and adds no orchestration executor. Generated prompts are not edited directly. Complete-context rebuilding, domain schemas, structured patch engines and HA/MGR learning are not prerequisites.

The [shared information-output foundation](../implemented/2026-10-07-shared-information-output.md) is implemented: admitted source-bound views, pure per-text preparation, exact-fragment acknowledgement candidates, compatible AG/board text paths and opt-in long board conventions. The [bounded current-state slice](../implemented/2026-10-08-ag-working-state.md) now implements dedicated AG replace/clear and captured-generation fencing through ordinary Lab/RPC clients, using an explicit session working-frame fallback in current adapters. Neither slice wires final host exposure to the ledger, establishes one combined dynamic-input budget, replaces host history or proves model benefits. Pi's [dedicated input-selection slice](../implemented/2026-10-08-ag-working-state-input.md) implements per-inference state selection/restoration and captured direct-write deduplication without editing protected history. Final provider confirmation is explicitly unsupported. Those remaining parts of A/C, semantic task binding beyond the fallback, other-host selectors and slice D remain proposals. Current foundation boundaries are recorded in `design.md §7.1`, `memory-graphs.md §5`, runtime/display owners and completion audit; task contracts, collaboration judgments, durable knowledge and execution facts retain their existing owners.

## Alternatives considered

- **Only lower candidate count or truncate everything.** Insufficient: it saves tokens but may damage necessary information and does not maintain state.
- **Build schema/JSON-patch/dependency infrastructure first.** Not selected: lightweight rules have not been shown insufficient; it displaces context cost with new infrastructure.
- **Append a complete short summary each turn.** Not the target: shorter individual blocks still accumulate and stale summaries can conflict with current state.
- **Display only deltas.** Not sufficient alone: compaction can remove the baseline; a short latest snapshot must be recoverable.
- **Create a shared/durable SkillStateStore.** Not selected: it duplicates AG/task-protocol identity and lifecycle, blurring authority.
- **Permanently delete history to shorten prompts.** Not selected: default exposure, not audit sources, is being slimmed. The sufficient-statistic assumption is not unconditional.
- **Depend on Pi codemode orchestration or build a general script executor.** Not selected: borrowing format does not require runtime reuse; ordinary tools already supply invocation. Host dependencies reduce generality, and an executor exceeds a memory component's role.
- **Unify AG/board storage and state machines with scope/TTL flags alone.** Not selected: private working graphs and shared coordination differ in authority, concurrency and judgment, not just these parameters. Share information projections/output facilities only.

## Acceptance criteria

Verify exposure contracts before protocol benefits:

1. Compare representative old and slim outputs, substantially reducing default characters/tokens and repeated blocks. IDs remain retrievable; critical values, time/scope disambiguation, negation, hypotheses and revocation survive; explicit exact get is not arbitrarily truncated.
2. Each task has one logical current snapshot; defaults do not show superseded values alongside it. Unchanged visible state is not fully reinjected. Necessary state/evidence can be restored after compaction/replacement.
3. Record actual adapter capability: append-only integration cannot claim replacement or bounded complete context. Measure complete input, individual exposures and cumulative increments separately.
4. State stays session/task-local, cannot self-certify acceptance, success or permission, and cannot turn pending/failed/cancelled actions into success. Exposure writes no implicit LTG or positive retrieval/learning evidence.
5. Board-inspired exposure creates no shared entries or duplicate protocol headers; references used when necessary remain retrievable. Changes to existing sources refresh snapshots even without new entries. Creation cursors alone cannot establish unchanged state. Static conventions do not become new per-turn overhead.
6. Cover shorter-body-than-wrapper, necessary candidate IDs, broken references, budget-dropped items not marked disclosed, rejected replacement preserving state, and already-visible write arguments avoiding duplicate injection. Input selection removes only superseded AG-state fragments, never mixed recall or tool calls/results. Report append/replacement modes separately and include state-write tool costs.
7. Ordinary tool/RPC clients without Pi/codemode use the same typed views/result contract. Core code, tests and recovery depend on no JavaScript orchestration, Pi globals or codemode store, and require no extra emit call.
8. Internal reads of ten items with only two exposed, final clipping/output failure, unverifiable source binding and another agent's first read cannot create false disclosure. Unchanged bodies with changed coordination status refresh views. Shared rendering grants no claim/judgment authority; output failure is not reported as rollback of write effects.

Initial matched experiments use A, existing exposure; B, slimming only; C, identical slimming plus maintenance rules. Hold model, tasks, tools, retrieval and authority fixed. Match B/C display budgets so smaller inputs are not mistaken for better state maintenance. An additional same-format/no-update research arm can separate content updates from formatting cues; failure when all history is absent alone does not prove the mechanism.

Measure independently accepted terminal outcomes, missed obligations, repeated failed actions, state correctness/staleness, recovery, per-turn increments and accumulated context tokens, model input/output/extra summarization calls, latency and compaction frequency. Include task switches, external revisions and earlier observations that become relevant later. First test slimming's quality, then protocol continuity at matched exposure cost. Neither benefit is assumed. These experiments have not been run.

## Risks

- **Lossy compression:** missing exact identifiers, conditions or sources can increase searches/errors. Preserve source reads and measure quality/recovery.
- **Summaries posing as facts:** prose rules do not ensure correctness. Preserve hypothesis labels and original-owner acceptance.
- **Hidden accumulation:** caching discounts and shorter blocks do not prevent context growth. Verify host capability and cumulative cost.
- **Rule overhead:** repeatedly injecting verbose maintenance instructions creates another burden. Rules stay at existing owners; dynamic exposure carries current content only.
- **Insufficient implementation:** content deduplication in `observe()` cannot replace state. Verify the minimal carrier rather than declaring maintenance integrated after changing prompts alone.
- **Withdrawal condition:** if rules do not improve matched-budget continuity, frequently create incorrect state or cost more than they save, withdraw protocol default promotion. Retain or withdraw pure slimming independently; protocol failure does not erase independently demonstrated slimming benefits or justify hiding counterexamples behind a state engine.
