import { describe, expect, it } from "vitest";

import {
  checkRepoJobs,
  GIT_RUN_EXIT_FAILED,
  GIT_RUN_EXIT_OK,
  GIT_RUN_EXIT_USAGE,
  isGitRunOutput,
  isGitRunResult,
  JOB_NAME_MAX_LENGTH,
  REPO_JOBS_APP_ID,
  REPO_JOBS_METHOD,
  type GitRunResult,
} from "./index.js";

const result: GitRunResult = {
  repo: "Knowledge",
  path: "/ws/Knowledge",
  op: "commit-push",
  status: "skipped",
  reason: "agent working",
  steps: [{ step: "agents", outcome: "skipped", detail: "claude in /ws/Knowledge (a Pomade terminal)" }],
  commit: null,
};

describe("pomade-git limits and exit codes", () => {
  it("a job name is at most 100 characters", () => {
    expect(JOB_NAME_MAX_LENGTH).toBe(100);
  });

  it("exit 0 done or skipped, 1 a repo failed, 2 usage", () => {
    expect([GIT_RUN_EXIT_OK, GIT_RUN_EXIT_FAILED, GIT_RUN_EXIT_USAGE]).toEqual([0, 1, 2]);
  });
});

describe("pomade-git --json output", () => {
  it("accepts a well-formed result and output", () => {
    expect(isGitRunResult(result)).toBe(true);
    expect(isGitRunResult({ ...result, status: "done", reason: null, commit: "a".repeat(40) })).toBe(true);
    expect(isGitRunOutput({ op: "commit-push", job: "Knowledge twice daily", at: "2026-11-09T13:00:00Z", results: [result] })).toBe(true);
    expect(isGitRunOutput({ op: "fetch", job: null, at: "2026-11-09T13:00:00Z", results: [] })).toBe(true);
  });

  it.each([
    [null],
    [{ ...result, op: "merge" }],
    [{ ...result, status: "ok" }],
    [{ ...result, reason: 1 }],
    [{ ...result, steps: [{ step: "rebase", outcome: "done", detail: "" }] }],
    [{ ...result, steps: [{ step: "agents", outcome: "done" }] }],
    [{ ...result, commit: undefined }],
  ])("refuses a malformed result: %j", (r) => {
    expect(isGitRunResult(r)).toBe(false);
  });

  it("refuses a malformed output", () => {
    expect(isGitRunOutput({ op: "commit-push", job: null, at: "x", results: [{ ...result, op: "merge" }] })).toBe(false);
    expect(isGitRunOutput({ op: "commit-push", job: 3, at: "x", results: [] })).toBe(false);
    expect(isGitRunOutput({ op: "commit-push", job: null, results: [] })).toBe(false);
  });
});

describe("jobs.forRepo answers", () => {
  const job = { id: "j1", name: "Knowledge twice daily", operation: "commit-push", schedule: "13:00, 20:00", nextRun: null, lastResult: null, route: "jobs/j1" };

  it("names Runner's method", () => {
    expect([REPO_JOBS_APP_ID, REPO_JOBS_METHOD]).toEqual(["pomade-runner", "jobs.forRepo"]);
  });

  it("keeps valid jobs with only their fields; drops malformed ones", () => {
    const last = { ...job, nextRun: "2026-11-09T20:00:00Z", lastResult: { status: "failed", at: "2026-11-09T13:00:00Z", extra: 1 }, extra: true };
    expect(checkRepoJobs({ jobs: [job, last, { ...job, operation: "merge" }, { ...job, lastResult: { status: "ok", at: "x" } }, null] })).toEqual([
      job,
      { ...job, nextRun: "2026-11-09T20:00:00Z", lastResult: { status: "failed", at: "2026-11-09T13:00:00Z" } },
    ]);
    expect(checkRepoJobs({ jobs: [] })).toEqual([]);
  });

  it.each([[null], [{}], [{ jobs: {} }], ["jobs"]])("a malformed answer is no answer: %j", (answer) => {
    expect(checkRepoJobs(answer)).toBeNull();
  });
});
