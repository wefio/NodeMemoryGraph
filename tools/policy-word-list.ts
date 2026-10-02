export const POLICY_WORDS: readonly string[] = [
  "patch",
  "editable",
  "files",
  "instruction",
  "checks",
  "repair-first",
];

/** The measured middle, plus the compiler model and the shared session mechanism. */
export const MECHANISM_PATHS: readonly string[] = [
  "src/core/store",
  "src/integration/ooo-board.ts",
  "src/integration/ooo-dispatch.ts",
  "src/integration/ooo-execution.ts",
  "src/integration/ooo-candidate.ts",
  "src/integration/ooo-fusion-plan.ts",
  "src/integration/ooo-session-mechanism.ts",
  "src/integration/task-semantics.ts",
  "src/integration/task-semantics-model.ts",
  "src/integration/task-semantics-interleavings.ts",
];

export interface ClassifiedSite {
  path: string;
  scope: string;
  word: string;
  count: number;
  classification: "mechanism" | "policy" | "undecided";
  reason: string;
}

// Counts are maintained by review, never refreshed automatically by the checker.
export const CLASSIFICATIONS: readonly ClassifiedSite[] = [
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.freezeTaskRunTask",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.freezeTaskRunTask",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.freezeTaskRunTask",
    word: "editable",
    count: 1,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.insertTaskRunTask",
    word: "patch",
    count: 8,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.insertTaskRunTask",
    word: "files",
    count: 4,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.insertTaskRunTask",
    word: "editable",
    count: 4,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.taskRunTasks",
    word: "patch",
    count: 8,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.taskRunTasks",
    word: "files",
    count: 4,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/base.ts",
    scope: "NmgStoreBase.taskRunTasks",
    word: "editable",
    count: 4,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/maintenance.ts",
    scope: "withMaintenance.recordActiveGraphAttribution",
    word: "patch",
    count: 1,
    classification: "mechanism",
    reason: "SQLite json_patch merges diagnostic timing fields; not a work shape.",
  },
  {
    path: "src/core/store/schema.ts",
    scope: "migrate",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/schema.ts",
    scope: "migrate",
    word: "editable",
    count: 1,
    classification: "policy",
    reason:
      "Persists or parses the patch-specific frozen declaration rather than an opaque work shape.",
  },
  {
    path: "src/core/store/schema.ts",
    scope: "migrate",
    word: "files",
    count: 2,
    classification: "undecided",
    reason:
      "One DDL literal contains both patch_files storage and filesystem fingerprint prose; ownership is mixed.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "<module>",
    word: "patch",
    count: 8,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "PatchTaskSpec",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "PatchTaskSpec",
    word: "instruction",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "PatchTaskSpec",
    word: "files",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "PatchTaskSpec",
    word: "editable",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "Row",
    word: "patch",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "Row",
    word: "files",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "Row",
    word: "editable",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission",
    word: "patch",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.constructor",
    word: "patch",
    count: 10,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.constructor",
    word: "editable",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.constructor",
    word: "files",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.constructor",
    word: "instruction",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.createManifestTables",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.createManifestTables",
    word: "editable",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.createManifestTables",
    word: "files",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.createCheckTable",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.migrateToTaskTables",
    word: "checks",
    count: 14,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.migrateToTaskTables",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.migrateToTaskTables",
    word: "editable",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.migrateToTaskTables",
    word: "files",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.patchSpec",
    word: "patch",
    count: 3,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.patchFrozen",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.patchFrozen",
    word: "instruction",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.patchFrozen",
    word: "files",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.patchFrozen",
    word: "editable",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.inputDigest",
    word: "patch",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.externalReady",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.issueCheck",
    word: "checks",
    count: 2,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.cancelCheck",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.checkRecord",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.submitCheck",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.projection",
    word: "patch",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.claim",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.proposalCommit",
    word: "patch",
    count: 6,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.proposalCommit",
    word: "files",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.installPatchTask",
    word: "patch",
    count: 4,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.submit",
    word: "patch",
    count: 1,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.verifyCandidate",
    word: "patch",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.cancel",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.refreshDerived",
    word: "patch",
    count: 2,
    classification: "policy",
    reason: "The board ticket, schema, freeze or submission path knows the patch work shape.",
  },
  {
    path: "src/integration/ooo-board.ts",
    scope: "BoardAdmission.abandonCheck",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-dispatch.ts",
    scope: "WorkerMetrics",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-candidate.ts",
    scope: "DataCheck",
    word: "files",
    count: 1,
    classification: "policy",
    reason: "The data-check contract binds candidate values to a file-shaped mapping.",
  },
  {
    path: "src/integration/ooo-candidate.ts",
    scope: "verifyCandidate",
    word: "files",
    count: 3,
    classification: "mechanism",
    reason: "Writes caller-supplied relative paths at the filesystem runner boundary.",
  },
  {
    path: "src/integration/ooo-candidate.ts",
    scope: "verifyCandidate",
    word: "checks",
    count: 4,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-candidate.ts",
    scope: "verifyDataChecks",
    word: "checks",
    count: 5,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-candidate.ts",
    scope: "verifyDataChecks",
    word: "files",
    count: 3,
    classification: "policy",
    reason: "The data-check contract binds candidate values to a file-shaped mapping.",
  },
  {
    path: "src/integration/ooo-fusion-plan.ts",
    scope: "<module>",
    word: "repair-first",
    count: 1,
    classification: "policy",
    reason: "The protocol constraint vocabulary is still declared inside the planner module.",
  },
  {
    path: "src/integration/ooo-fusion-plan.ts",
    scope: "nextSessionMove",
    word: "repair-first",
    count: 2,
    classification: "mechanism",
    reason: "Checks the plan-declared constraint and reports why this session cannot continue.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "<module>",
    word: "patch",
    count: 6,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "CheckTool",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "checkToolCandidate",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "checkToolCandidate",
    word: "files",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "ArtifactParams",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "artifactEnvelope",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "artifactEnvelope",
    word: "files",
    count: 4,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "patchEnvelope",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "patchEnvelope",
    word: "files",
    count: 3,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "conclusionEnvelope",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "conclusionEnvelope",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "PatchExecOptions",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "patchSessionInput",
    word: "patch",
    count: 4,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "patchSessionInput",
    word: "files",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "piCompletionAllowed",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "PiRun",
    word: "checks",
    count: 1,
    classification: "mechanism",
    reason:
      "Executes or records caller-declared checks; does not choose their wording or enablement.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "UnitState",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "snapshotText",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "snapshotText",
    word: "files",
    count: 4,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "snapshotText",
    word: "instruction",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "snapshotText",
    word: "editable",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "artifactFromText",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "artifactFromText",
    word: "files",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/ooo-session-mechanism.ts",
    scope: "SessionRunInput",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "Patch-specific worker inputs, artifact envelopes or prompt rendering remain in the session module.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "<module>",
    word: "patch",
    count: 7,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "TaskUnit",
    word: "instruction",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "TaskUnit",
    word: "patch",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "TaskUnit",
    word: "files",
    count: 2,
    classification: "undecided",
    reason:
      "Combines patch envelope paths with input-file granularity; the latter remains an experiment question.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "TaskUnit",
    word: "editable",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "CompileInput",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "<module>",
    word: "instruction",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "<module>",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "<module>",
    word: "editable",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "within",
    word: "patch",
    count: 2,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refuseForeignSpecs",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refuseOutOfRange",
    word: "patch",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refusePermissionExpansion",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refusePermissionExpansion",
    word: "editable",
    count: 2,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refusePermissionExpansion",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refuseSpecFields",
    word: "patch",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "freezeEnvelope",
    word: "patch",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "freezeEnvelope",
    word: "instruction",
    count: 2,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "freezeEnvelope",
    word: "files",
    count: 4,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "freezeEnvelope",
    word: "editable",
    count: 4,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "frozenPatch",
    word: "patch",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "frozenPatch",
    word: "files",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "unitFor",
    word: "patch",
    count: 7,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "unitFor",
    word: "instruction",
    count: 2,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "unitFor",
    word: "files",
    count: 2,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "unitFor",
    word: "editable",
    count: 1,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refuseWidening",
    word: "patch",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
  {
    path: "src/integration/task-semantics.ts",
    scope: "refuseWidening",
    word: "editable",
    count: 3,
    classification: "policy",
    reason:
      "The compiler or refinement rule names patch-specific fields, validation and permissions.",
  },
];
