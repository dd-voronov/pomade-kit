import { describe, expect, it } from "vitest";

import {
  checkLiveIn,
  LIVE_AGENT_STATES,
  checkRepoSessions,
  SESSIONS_APP_ID,
  SESSIONS_FOR_REPO_METHOD,
  SESSIONS_LIVE_IN_METHOD,
  type RepoSession,
} from "./index.js";

const session: RepoSession = {
  id: "7b5c3451-0370-4bf9-b6fd-617d56545a78",
  agent: "claude",
  name: "G4 agents grill",
  status: "active",
  live: "idle",
  cwd: "/ws/Projects/Pomade/.claude/worktrees/t1",
  branch: "agent/t1",
  project: "p1",
  startedAt: "2026-11-09T14:00:00Z",
  lastActiveAt: "2026-11-09T14:32:00Z",
};

describe("the agents app's session methods", () => {
  it("names the app and its methods", () => {
    expect([SESSIONS_APP_ID, SESSIONS_FOR_REPO_METHOD, SESSIONS_LIVE_IN_METHOD]).toEqual(["pomade-agents", "sessions.forRepo", "sessions.liveIn"]);
  });
});

describe("sessions.forRepo answers", () => {
  it("keeps well-formed sessions with only their fields; trims names; unnamed and Workspace are null", () => {
    const unnamed = { ...session, id: "s2", name: null, branch: null, project: null, live: "closed", status: "done-skip" };
    expect(checkRepoSessions({ sessions: [{ ...session, name: " G4 agents grill ", firstMessage: "hi" }, unnamed] })).toEqual([session, unnamed]);
    expect(checkRepoSessions({ sessions: [] })).toEqual([]);
  });

  it.each([
    ["an unknown live state", { live: "exited" }],
    ["an unknown status", { status: "archived" }],
    ["a relative folder", { cwd: "Projects/Pomade" }],
    ["a blank name", { name: "  " }],
    ["a missing branch", { branch: undefined }],
    ["an id with a slash", { id: "a/b" }],
    ["an agent with a line break", { agent: "a\nb" }],
    ["a bad time", { lastActiveAt: "yesterday" }],
  ])("drops a session with %s", (_what, change) => {
    expect(checkRepoSessions({ sessions: [{ ...session, ...change }, session] })).toEqual([session]);
  });

  it.each([[null], [{}], [{ sessions: {} }], [[session]]])("a malformed answer is no answer: %j", (answer) => {
    expect(checkRepoSessions(answer)).toBeNull();
  });
});

describe("sessions.liveIn answers", () => {
  const tab = { sessionId: "s1", agent: "claude", cwd: "/ws/repo", source: "tab", job: null };
  const run = { sessionId: null, agent: "claude-pm", cwd: "/ws/repo/docs", source: "run", job: "Morning summary" };

  it("accepts tabs (prompted or not) and Runner runs, with only their fields", () => {
    expect(checkLiveIn({ live: true, sessions: [{ ...tab, extra: 1 }, { ...tab, sessionId: null }, run] })).toEqual({
      ok: true,
      result: { live: true, sessions: [tab, { ...tab, sessionId: null }, run] },
    });
    expect(checkLiveIn({ live: false, sessions: [] })).toEqual({ ok: true, result: { live: false, sessions: [] } });
  });

  it("accepts a session's state absent or as working, needs-you or idle", () => {
    for (const state of LIVE_AGENT_STATES) {
      expect(checkLiveIn({ live: true, sessions: [{ ...tab, state }] })).toEqual({
        ok: true,
        result: { live: true, sessions: [{ ...tab, state }] },
      });
    }
    expect(LIVE_AGENT_STATES).toEqual(["working", "needs-you", "idle"]);
    const checked = checkLiveIn({ live: true, sessions: [tab, { ...run, state: "working" }] });
    expect(checked).toEqual({ ok: true, result: { live: true, sessions: [tab, { ...run, state: "working" }] } });
    expect(checked.ok && Object.keys(checked.result.sessions[0] ?? {})).not.toContain("state");
  });

  it.each([
    [null],
    [{ live: true }],
    [{ live: "yes", sessions: [] }],
    [{ live: true, sessions: [] }],
    [{ live: false, sessions: [tab] }],
    [{ live: true, sessions: [{ ...tab, cwd: "repo" }] }],
    [{ live: true, sessions: [{ ...tab, source: "terminal" }] }],
    [{ live: true, sessions: [{ ...tab, job: "x" }] }],
    [{ live: true, sessions: [{ ...run, job: null }] }],
    [{ live: true, sessions: [tab, { ...tab, agent: "" }] }],
    [{ live: true, sessions: [{ ...tab, state: "closed" }] }],
    [{ live: true, sessions: [{ ...tab, state: "busy" }] }],
    [{ live: true, sessions: [{ ...run, state: null }] }],
  ])("refuses a malformed answer whole: %j", (answer) => {
    expect(checkLiveIn(answer)).toMatchObject({ ok: false });
  });
});
