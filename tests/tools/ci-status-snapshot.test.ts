import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCiStatusSnapshot,
  renderCiStatusSummary,
} from "../../tools/ci-status-snapshot.ts";

test("CI status snapshot preserves GitHub identity and reports failed steps", () => {
  const snapshot = buildCiStatusSnapshot(
    {
      repository: { full_name: "wefio/NodeMemoryGraph" },
      workflow_run: {
        id: 42,
        name: "CI",
        run_number: 7,
        event: "pull_request",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.example/actions/runs/42",
        head_sha: "abc123",
        head_branch: "feature/status",
        pull_requests: [
          {
            number: 9,
            url: "https://api.github.example/repos/wefio/NodeMemoryGraph/pulls/9",
          },
        ],
      },
    },
    [
      {
        id: 101,
        name: "Static and package contracts",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.example/jobs/101",
        started_at: "2026-08-31T00:00:00Z",
        completed_at: "2026-08-31T00:01:00Z",
        steps: [
          { name: "npm ci", status: "completed", conclusion: "success", number: 1 },
          { name: "Shared static verification contract", status: "completed", conclusion: "failure", number: 2 },
        ],
      },
      {
        id: 102,
        name: "Product tests and coverage",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.example/jobs/102",
        started_at: "2026-08-31T00:00:00Z",
        completed_at: "2026-08-31T00:02:00Z",
        steps: [],
      },
    ],
    "2026-08-31T00:03:00Z",
  );

  assert.equal(snapshot.schemaVersion, "nmg.ci-status.v1");
  assert.equal(snapshot.authority, "observation-only");
  assert.equal(snapshot.repository, "wefio/NodeMemoryGraph");
  assert.equal(snapshot.workflow.headSha, "abc123");
  assert.deepEqual(snapshot.pullRequests, [{ number: 9 }]);
  assert.deepEqual(snapshot.failures, [
    {
      job: "Static and package contracts",
      conclusion: "failure",
      url: "https://github.example/jobs/101",
      failedSteps: ["Shared static verification contract"],
    },
  ]);

  const summary = renderCiStatusSummary(snapshot);
  assert.match(summary, /CI status observation/);
  assert.match(summary, /Static and package contracts/);
  assert.match(summary, /Shared static verification contract/);
  assert.match(summary, /not an authorization or merge decision/i);
});

test("status observer workflow is read-only and listens only to canonical CI completion", () => {
  const workflow = readFileSync(".github/workflows/ci-status.yml", "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\["CI"\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.match(workflow, /actions\/upload-artifact@/);
});
