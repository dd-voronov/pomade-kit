import { describe, expect, it } from "vitest";

import {
  checkAgentTabTitle,
  checkRosterList,
  isAgentTabChanged,
  parseAgentTabsParams,
  providerModes,
  type AgentTabInfo,
} from "./agent-tabs.js";
import { parseHostMessage } from "./guards.js";
import { METHOD_CAPABILITY } from "./types.js";

const TAB: AgentTabInfo = {
  tabId: "t1",
  projectId: "p1",
  agentId: "claude",
  cwd: "/ws/Projects/alpha",
  launchedAt: "2026-11-11T10:00:00.000Z",
  sessionId: null,
  title: "Claude",
  titleSource: "default",
  unnamed: false,
  state: "idle",
};

describe("agentTabs params", () => {
  it("list: projectId optional; unknown keys dropped", () => {
    expect(parseAgentTabsParams("agentTabs.list", undefined)).toEqual({ ok: true, params: {} });
    expect(parseAgentTabsParams("agentTabs.list", { projectId: "p1", x: 1 })).toEqual({ ok: true, params: { projectId: "p1" } });
    expect(parseAgentTabsParams("agentTabs.list", { projectId: 3 })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    expect(parseAgentTabsParams("agentTabs.list", [1])).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });

  it("setTitle: a trimmed one-line title, or null for unnamed; title is required", () => {
    expect(parseAgentTabsParams("agentTabs.setTitle", { tabId: "t1", title: "  G4 tickets " })).toEqual({
      ok: true,
      params: { tabId: "t1", title: "G4 tickets" },
    });
    expect(parseAgentTabsParams("agentTabs.setTitle", { tabId: "t1", title: null })).toEqual({ ok: true, params: { tabId: "t1", title: null } });
    for (const bad of [{ tabId: "t1" }, { tabId: "t1", title: "" }, { tabId: "t1", title: "a\nb" }, { tabId: "t1", title: 5 }, { title: "x" }]) {
      expect(parseAgentTabsParams("agentTabs.setTitle", bad)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    }
  });

  it("titles: at most 200 characters", () => {
    expect(checkAgentTabTitle("x".repeat(200))).toEqual({ ok: true, title: "x".repeat(200) });
    expect(checkAgentTabTitle("x".repeat(201))).toMatchObject({ ok: false });
  });

  it("launch: agent id, optional project, cwd by the path rule, mode id, non-empty prompt", () => {
    expect(parseAgentTabsParams("agentTabs.launch", { agentId: "claude-pm", projectId: "p1", cwd: "Projects/alpha/", mode: "full-autonomy", prompt: "Hi" })).toEqual({
      ok: true,
      params: { agentId: "claude-pm", projectId: "p1", cwd: "Projects/alpha", mode: "full-autonomy", prompt: "Hi" },
    });
    expect(parseAgentTabsParams("agentTabs.launch", { agentId: "claude" })).toEqual({ ok: true, params: { agentId: "claude" } });
    expect(parseAgentTabsParams("agentTabs.launch", { agentId: "claude", cwd: "../x" })).toMatchObject({ ok: false, error: { code: "outside-workspace" } });
    expect(parseAgentTabsParams("agentTabs.launch", { agentId: "claude", cwd: "/abs" })).toMatchObject({ ok: false, error: { code: "outside-workspace" } });
    expect(parseAgentTabsParams("agentTabs.launch", { agentId: "claude", cwd: ".pomade/x" })).toMatchObject({ ok: false, error: { code: "capability-denied" } });
    for (const bad of [{}, { agentId: "a/b" }, { agentId: " a" }, { agentId: "claude", mode: "" }, { agentId: "claude", prompt: "  " }, { agentId: "claude", prompt: "x".repeat(16385) }]) {
      expect(parseAgentTabsParams("agentTabs.launch", bad)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    }
  });

  it("resume: agent and session ids", () => {
    expect(parseAgentTabsParams("agentTabs.resume", { agentId: "claude", sessionId: "1111-aa", cwd: "" })).toEqual({
      ok: true,
      params: { agentId: "claude", sessionId: "1111-aa", cwd: "" },
    });
    for (const bad of [{ agentId: "claude" }, { agentId: "claude", sessionId: "a b" }, { agentId: "claude", sessionId: "../x" }, { sessionId: "s" }]) {
      expect(parseAgentTabsParams("agentTabs.resume", bad)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    }
  });

  it("capabilities: read and write for the list and titles, tabs.open for opening and focusing", () => {
    expect(METHOD_CAPABILITY["agentTabs.list"]).toBe("agentTabs.read");
    expect(METHOD_CAPABILITY["agentTabs.setTitle"]).toBe("agentTabs.write");
    expect(METHOD_CAPABILITY["agentTabs.focus"]).toBe("tabs.open");
    expect(METHOD_CAPABILITY["agentTabs.launch"]).toBe("tabs.open");
    expect(METHOD_CAPABILITY["agentTabs.resume"]).toBe("tabs.open");
  });
});

describe("agentTab.changed", () => {
  it("is parsed by shape: a well-formed tab and known changes", () => {
    expect(isAgentTabChanged({ tab: TAB, changes: ["opened"] })).toBe(true);
    expect(isAgentTabChanged({ tab: TAB, changes: [] })).toBe(false);
    expect(isAgentTabChanged({ tab: TAB, changes: ["renamed"] })).toBe(false);
    expect(isAgentTabChanged({ tab: { ...TAB, state: "busy" }, changes: ["state"] })).toBe(false);
    expect(isAgentTabChanged({ tab: { ...TAB, launchedAt: "yesterday" }, changes: ["state"] })).toBe(false);
    expect(isAgentTabChanged({ tab: { ...TAB, titleSource: "agent" }, changes: ["title"] })).toBe(false);
  });

  it("reaches the app with only the documented fields", () => {
    const msg = parseHostMessage({ channel: "pomade", type: "event", name: "agentTab.changed", payload: { tab: { ...TAB, extra: 1 }, changes: ["title", "session"] } });
    expect(msg).toEqual({ channel: "pomade", type: "event", name: "agentTab.changed", payload: { tab: TAB, changes: ["title", "session"] } });
  });
});

describe("roster.list answers", () => {
  it("accepts agents with providers, config folders and modes; trims names", () => {
    expect(
      checkRosterList({
        agents: [
          { id: "claude-pm", name: " PM ", command: "claude-pm", provider: "claude", configDir: "/ws/Agents/claude-pm", modes: [{ id: "normal", name: "Normal", args: [] }] },
          { id: "codex", name: "Codex", command: "codex", provider: "codex", extra: true },
        ],
      }),
    ).toEqual({
      ok: true,
      agents: [
        { id: "claude-pm", name: "PM", command: "claude-pm", provider: "claude", configDir: "/ws/Agents/claude-pm", modes: [{ id: "normal", name: "Normal", args: [] }] },
        { id: "codex", name: "Codex", command: "codex", provider: "codex" },
      ],
    });
  });

  it.each([
    [null],
    [{ agents: {} }],
    [{ agents: [{ id: "a", name: "A", command: "a", provider: "gemini" }] }],
    [{ agents: [{ id: "a", name: "A", command: "", provider: "claude" }] }],
    [{ agents: [{ id: "a", name: "A", command: "a", provider: "claude", configDir: "rel" }] }],
    [{ agents: [{ id: "a", name: "A", command: "a", provider: "claude", modes: [{ id: "n", name: "N", args: ["a\nb"] }] }] }],
    [{ agents: [{ id: "a", name: "A", command: "a", provider: "claude" }, { id: "a", name: "B", command: "b", provider: "claude" }] }],
  ])("refuses a malformed answer whole: %j", (answer) => {
    expect(checkRosterList(answer)).toMatchObject({ ok: false });
  });

  it("provider modes: Normal, and Full autonomy with the provider's flag", () => {
    expect(providerModes("claude")).toEqual([
      { id: "normal", name: "Normal", args: [] },
      { id: "full-autonomy", name: "Full autonomy", args: ["--dangerously-skip-permissions"] },
    ]);
    expect(providerModes("codex")[1]?.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
});
