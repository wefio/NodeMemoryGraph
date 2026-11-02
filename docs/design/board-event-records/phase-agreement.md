# Scoped phase agreement

[简体中文](phase-agreement.zh-CN.md) · [Terms](phase-agreement.terms.yaml)

**Status:** current

An event may carry an optional `collaboration` declaration, independent of its
open/closed lifecycle. Absence means no phase has been declared, not implicit
permission to execute. The declaration contains `phase` (`discussion`, `execution`
or null before the first switch), `phaseRevision`, and a pending proposal or null.
Only a committed switch advances `phaseRevision`; ordinary event updates retain it.
All mutations still require the current event `expectedRevision` and event-participant
authority. Parent and child phases do not propagate automatically.

Phase changes use `eventUpdate` with `expectedPhaseRevision`, `proposalId` and
`text`. `phasePropose` additionally supplies `target` and optional
`requiredApprovers`. The default confirmation set is the current participants;
an explicit set describes the affected participants under the collaboration
agreement. The proposer is always included and its proposal records its agreement.
Other named approvers must be recorded participants. This declaration does not
independently prove that the affected set is complete or grant resource authority.

`phaseAgree` records a named approver's confirmation of that proposal. Any authorized
event participant can `phaseSwitch` after all named confirmations exist. Only the
proposer can `phaseWithdraw`; replacement requires withdrawal first. A proposal ID
cannot be reused in the same retained event history, preventing withdrawn confirmations
from attaching to a replacement. Phase operations require an active event; closing
and reopening preserve the declaration and pending proposal without switching phase.

The first proposal uses phase revision zero. Reading the updated event supplies
both revisions for the next operation. History and subscribed event notices use
the existing transactional publication path. Event directory and detail views
disclose phase/version and pending proposal through InformationView. The broader
[phase draft](collaboration-phase.md) retains the adjustable
design for activity purposes, permits and in-flight operations.

This is coordination state, not tool enforcement. Execution phase does not grant
execution permission, and switching does not cancel, drain or fence running tools.
Hosts own those boundaries. Discussion candidates and execution requests can use
ordinary board messages; they are not automatically converted into phase proposals.
