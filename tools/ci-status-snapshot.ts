import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

export interface WorkflowRunEvent {
  repository?: { full_name?: string };
  workflow_run?: {
    id?: number;
    name?: string;
    run_number?: number;
    event?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    head_sha?: string;
    head_branch?: string;
    pull_requests?: Array<{ number?: number; url?: string }>;
  };
}

export interface WorkflowJob {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    number?: number;
  }>;
}

export interface CiStatusSnapshot {
  schemaVersion: "nmg.ci-status.v1";
  authority: "observation-only";
  generatedAt: string;
  repository: string;
  workflow: {
    id: number;
    name: string;
    runNumber: number;
    event: string;
    status: string;
    conclusion: string | null;
    url: string;
    headSha: string;
    headBranch: string;
  };
  pullRequests: Array<{ number: number }>;
  jobs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  failures: Array<{
    job: string;
    conclusion: string;
    url: string;
    failedSteps: string[];
  }>;
}

const FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function conclusion(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function buildCiStatusSnapshot(
  event: WorkflowRunEvent,
  inputJobs: WorkflowJob[],
  generatedAt = new Date().toISOString(),
): CiStatusSnapshot {
  const run = event.workflow_run;
  if (!run || !number(run.id) || !text(event.repository?.full_name)) {
    throw new Error("Expected a GitHub workflow_run event with repository and run identity");
  }

  const jobs = inputJobs
    .map((job) => ({
      id: number(job.id),
      name: text(job.name) || "unnamed job",
      status: text(job.status) || "unknown",
      conclusion: conclusion(job.conclusion),
      url: text(job.html_url),
      startedAt: text(job.started_at) || null,
      completedAt: text(job.completed_at) || null,
      failedSteps: (job.steps ?? [])
        .filter((step) => FAILURE_CONCLUSIONS.has(text(step.conclusion)))
        .map((step) => text(step.name) || `step ${number(step.number)}`),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);

  const pullRequests = [...new Set((run.pull_requests ?? []).map((pull) => number(pull.number)).filter(Boolean))]
    .sort((left, right) => left - right)
    .map((pullNumber) => ({ number: pullNumber }));

  return {
    schemaVersion: "nmg.ci-status.v1",
    authority: "observation-only",
    generatedAt,
    repository: text(event.repository?.full_name),
    workflow: {
      id: number(run.id),
      name: text(run.name),
      runNumber: number(run.run_number),
      event: text(run.event),
      status: text(run.status),
      conclusion: conclusion(run.conclusion),
      url: text(run.html_url),
      headSha: text(run.head_sha),
      headBranch: text(run.head_branch),
    },
    pullRequests,
    jobs: jobs.map(({ failedSteps: _failedSteps, ...job }) => job),
    failures: jobs
      .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion ?? ""))
      .map((job) => ({
        job: job.name,
        conclusion: job.conclusion ?? "unknown",
        url: job.url,
        failedSteps: job.failedSteps,
      })),
  };
}

export function renderCiStatusSummary(snapshot: CiStatusSnapshot): string {
  const lines = [
    "## CI status observation",
    "",
    `- Repository: \`${snapshot.repository}\``,
    `- Workflow: [${snapshot.workflow.name} #${snapshot.workflow.runNumber}](${snapshot.workflow.url})`,
    `- Commit: \`${snapshot.workflow.headSha}\``,
    `- Conclusion: **${snapshot.workflow.conclusion ?? snapshot.workflow.status}**`,
    `- Pull requests: ${snapshot.pullRequests.length > 0 ? snapshot.pullRequests.map((pull) => `#${pull.number}`).join(", ") : "none"}`,
    "",
  ];

  if (snapshot.failures.length === 0) {
    lines.push("No failed jobs were reported.", "");
  } else {
    lines.push("### Failed jobs", "");
    for (const failure of snapshot.failures) {
      const label = failure.url ? `[${failure.job}](${failure.url})` : failure.job;
      lines.push(`- ${label}: ${failure.conclusion}`);
      for (const step of failure.failedSteps) lines.push(`  - ${step}`);
    }
    lines.push("");
  }

  lines.push(
    "> This is a read-only observation of GitHub state, not an authorization or merge decision.",
    "",
  );
  return lines.join("\n");
}

async function fetchWorkflowJobs(repository: string, runId: number, token: string): Promise<WorkflowJob[]> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const jobs: WorkflowJob[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${api}/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "node-memory-graph-ci-status",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub jobs API failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as JsonRecord;
    const pageJobs = Array.isArray(payload.jobs) ? (payload.jobs as WorkflowJob[]) : [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) return jobs;
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const eventPath = option("--event") ?? process.env.GITHUB_EVENT_PATH;
  const outputPath = option("--output") ?? ".nmg-ci/status.json";
  const summaryPath = option("--summary") ?? process.env.GITHUB_STEP_SUMMARY;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!eventPath || !token) throw new Error("GITHUB_EVENT_PATH and GITHUB_TOKEN are required");

  const event = JSON.parse(await readFile(eventPath, "utf8")) as WorkflowRunEvent;
  const repository = text(event.repository?.full_name);
  const runId = number(event.workflow_run?.id);
  if (!repository || !runId) throw new Error("Invalid workflow_run event payload");

  const snapshot = buildCiStatusSnapshot(event, await fetchWorkflowJobs(repository, runId, token));
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  if (summaryPath) await appendFile(summaryPath, renderCiStatusSummary(snapshot), "utf8");
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
