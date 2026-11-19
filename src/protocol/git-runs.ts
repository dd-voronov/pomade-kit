// Git runs (pomade:E-042): what Pomade's `pomade-git` command prints with `--json` — the structured
// result a scheduler such as `pomade-runner` keeps — and the scheduled-jobs answer Pomade reads from
// `pomade-runner` for a repo row (`jobs.forRepo`, PLATFORM rule 7: no answer, no row). Shared by
// Pomade, Runner and test stand-ins.

/** The operations `pomade-git` runs. */
export type GitRunOp = "commit-push" | "pull" | "push" | "fetch";

export const GIT_RUN_OPS: readonly GitRunOp[] = ["commit-push", "pull", "push", "fetch"];

export type GitRunStatus = "done" | "skipped" | "failed";

export const GIT_RUN_STATUSES: readonly GitRunStatus[] = ["done", "skipped", "failed"];

/** The steps, in the order an operation runs them. */
export type GitRunStepName = "agents" | "commit" | "pull" | "push" | "fetch";

export const GIT_RUN_STEP_NAMES: readonly GitRunStepName[] = ["agents", "commit", "pull", "push", "fetch"];

export interface GitRunStep {
  step: GitRunStepName;
  outcome: GitRunStatus;
  /** What happened, in words ("nothing to commit", "got 2 commits from origin/main"). */
  detail: string;
}

/** One repo's result. */
export interface GitRunResult {
  /** The repo's name as the Git panel shows it (its folder name). */
  repo: string;
  /** Its absolute path (the real path). */
  path: string;
  op: GitRunOp;
  status: GitRunStatus;
  /** Why it was skipped or failed, in words; null when done. */
  reason: string | null;
  steps: GitRunStep[];
  /** The commit this run made (full hash), or null. A failed run that took its commit back has none. */
  commit: string | null;
}

/** What `pomade-git <op> … --json` prints: one result per repo argument, in order. */
export interface GitRunOutput {
  op: GitRunOp;
  job: string | null;
  /** When the run started (ISO 8601). */
  at: string;
  results: GitRunResult[];
}

/** The longest job name `pomade-git --job` accepts (one line, trimmed, 1–100 characters). */
export const JOB_NAME_MAX_LENGTH = 100;

/** `pomade-git`'s exit codes: every repo done or skipped. */
export const GIT_RUN_EXIT_OK = 0;
/** At least one repo failed. */
export const GIT_RUN_EXIT_FAILED = 1;
/** The command line was wrong (unknown operation, no repo, a bad option); nothing ran. */
export const GIT_RUN_EXIT_USAGE = 2;

const has = <T>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStep(s: unknown): s is GitRunStep {
  return isObj(s) && has(GIT_RUN_STEP_NAMES, s.step) && has(GIT_RUN_STATUSES, s.outcome) && typeof s.detail === "string";
}

/** True for a well-formed `GitRunResult`. */
export function isGitRunResult(r: unknown): r is GitRunResult {
  return (
    isObj(r) &&
    typeof r.repo === "string" &&
    typeof r.path === "string" &&
    has(GIT_RUN_OPS, r.op) &&
    has(GIT_RUN_STATUSES, r.status) &&
    (r.reason === null || typeof r.reason === "string") &&
    Array.isArray(r.steps) &&
    r.steps.every(isStep) &&
    (r.commit === null || typeof r.commit === "string")
  );
}

/** True for a well-formed `--json` output. */
export function isGitRunOutput(o: unknown): o is GitRunOutput {
  return (
    isObj(o) &&
    has(GIT_RUN_OPS, o.op) &&
    (o.job === null || typeof o.job === "string") &&
    typeof o.at === "string" &&
    Array.isArray(o.results) &&
    o.results.every(isGitRunResult)
  );
}

// ── Scheduled jobs: pomade-runner's answer ────────────────────────────────────

/** The app Pomade asks for the jobs that target a repo, and the method it calls. */
export const REPO_JOBS_APP_ID = "pomade-runner";
export const REPO_JOBS_METHOD = "jobs.forRepo";

/** `jobs.forRepo` — the jobs whose repos include this one. */
export interface RepoJobsParams {
  /** The repo by the identity `pomade-git` accepts (`name`, the Git panel's) and its real path. */
  repo: { name: string; path: string };
}

export interface RepoJob {
  id: string;
  name: string;
  operation: GitRunOp;
  /** When it runs, in words: "13:00, 20:00", "weekdays at 9:00". */
  schedule: string;
  /** The next run (ISO 8601), or null when none is planned. */
  nextRun: string | null;
  lastResult: { status: GitRunStatus; at: string } | null;
  /** Runner's tab route that opens the job. */
  route: string;
}

export interface RepoJobsResult {
  /** `[]` when no job targets the repo. */
  jobs: RepoJob[];
}

function isRepoJob(j: unknown): j is RepoJob {
  return (
    isObj(j) &&
    typeof j.id === "string" &&
    typeof j.name === "string" &&
    has(GIT_RUN_OPS, j.operation) &&
    typeof j.schedule === "string" &&
    (j.nextRun === null || typeof j.nextRun === "string") &&
    (j.lastResult === null || (isObj(j.lastResult) && has(GIT_RUN_STATUSES, j.lastResult.status) && typeof j.lastResult.at === "string")) &&
    typeof j.route === "string"
  );
}

/** Runner's answer → its jobs, with only `RepoJob`'s fields; null when the answer is not
 *  `{ jobs: [...] }` (no row then). A malformed job in a valid list is dropped. */
export function checkRepoJobs(answer: unknown): RepoJob[] | null {
  if (!isObj(answer) || !Array.isArray(answer.jobs)) return null;
  return answer.jobs.filter(isRepoJob).map((j) => ({
    id: j.id,
    name: j.name,
    operation: j.operation,
    schedule: j.schedule,
    nextRun: j.nextRun,
    lastResult: j.lastResult ? { status: j.lastResult.status, at: j.lastResult.at } : null,
    route: j.route,
  }));
}
