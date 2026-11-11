import { describe, expect, it } from "vitest";

import { connect, type HostClient } from "../sdk/index.js";
import type { AgentTabChangedPayload } from "../protocol/index.js";
import { createFakeHost, type FakeHostOptions } from "./index.js";

const MANIFEST = {
  id: "pomade-agents",
  name: "Agents",
  version: "0.1.0",
  hostApi: 0,
  capabilities: ["agentTabs.read", "agentTabs.write", "tabs.open"],
  events: { subscribe: ["agentTab.changed"] },
};

const NOW = Date.parse("2026-11-11T10:00:00.000Z");

async function client(options: FakeHostOptions = {}, manifest: unknown = MANIFEST) {
  const fake = createFakeHost({
    manifest,
    now: () => NOW,
    files: { "Projects/alpha/README.md": "# A\n", "Projects/beta/README.md": "# B\n" },
    projects: [
      { id: "p-alpha", name: "Alpha", root: "Projects/alpha" },
      { id: "p-beta", name: "Beta", root: "Projects/beta" },
    ],
    activeProject: "p-alpha",
    ...options,
  });
  const r = await connect({ transport: fake.transport, keySource: null });
  if (r.status !== "connected") throw new Error(r.status);
  return { host: r.host, fake };
}

async function changes(host: HostClient): Promise<AgentTabChangedPayload[]> {
  const heard: AgentTabChangedPayload[] = [];
  await host.events.subscribe("agentTab.changed", (p) => heard.push(p));
  return heard;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return (err as { code: string }).code;
  }
}

describe("agent tabs in the fake host", () => {
  it("lists seeded tabs, whole or per project, with fresh-tab defaults", async () => {
    const { host } = await client({
      agentTabs: [
        { tabId: "t1", projectId: "p-alpha", agentId: "claude", sessionId: "s1", state: "working" },
        { tabId: "t2", projectId: "p-beta", agentId: "codex" },
      ],
    });
    const all = await host.agentTabs.list();
    expect(all.map((t) => t.tabId)).toEqual(["t1", "t2"]);
    expect(all[1]).toEqual({
      tabId: "t2",
      projectId: "p-beta",
      agentId: "codex",
      cwd: null,
      launchedAt: "2026-11-11T10:00:00.000Z",
      sessionId: null,
      title: "Codex",
      titleSource: "default",
      unnamed: false,
      state: "idle",
    });
    expect((await host.agentTabs.list({ projectId: "p-alpha" })).map((t) => t.tabId)).toEqual(["t1"]);
    expect(await codeOf(host.agentTabs.list({ projectId: "nope" }))).toBe("not-found");
  });

  it("setTitle names a tab or marks it unnamed; a user rename is heard as titleSource user", async () => {
    const { host, fake } = await client({ agentTabs: [{ tabId: "t1", projectId: "p-alpha", agentId: "claude" }] });
    const heard = await changes(host);
    await host.agentTabs.setTitle("t1", "G4 tickets");
    expect(fake.agentTabs[0]).toMatchObject({ title: "G4 tickets", titleSource: "app", unnamed: false });
    await host.agentTabs.setTitle("t1", null);
    expect(fake.agentTabs[0]).toMatchObject({ title: "Claude", titleSource: "default", unnamed: true });
    fake.renameAgentTab("t1", "Mine");
    await tick();
    expect(heard.map((h) => [h.changes, h.tab.title, h.tab.titleSource, h.tab.unnamed])).toEqual([
      [["title"], "G4 tickets", "app", false],
      [["title"], "Claude", "default", true],
      [["title"], "Mine", "user", false],
    ]);
    expect(await codeOf(host.agentTabs.setTitle("nope", "x"))).toBe("not-found");
  });

  it("launch opens a tab in the project (switching to it) with the mode and prompt; checks agent, mode, folder", async () => {
    const { host, fake } = await client();
    const heard = await changes(host);
    const { tabId } = await host.agentTabs.launch({ agentId: "claude", projectId: "p-beta", mode: "full-autonomy", prompt: "Go" });
    expect(fake.activeProject.id).toBe("p-beta");
    expect(fake.openedAgentTabs).toEqual([{ kind: "agent", tabId, projectId: "p-beta", agentId: "claude", cwd: "Projects/beta", mode: "full-autonomy", prompt: "Go" }]);
    expect(fake.agentTabs[0]).toMatchObject({ tabId, cwd: "/fake/workspace/Projects/beta", state: "idle", sessionId: null });
    await tick();
    expect(heard.map((h) => h.changes)).toEqual([["opened"]]);
    expect(await codeOf(host.agentTabs.launch({ agentId: "ghost" }))).toBe("not-found");
    expect(await codeOf(host.agentTabs.launch({ agentId: "claude", mode: "turbo" }))).toBe("invalid-params");
    expect(await codeOf(host.agentTabs.launch({ agentId: "claude", cwd: "Projects/missing" }))).toBe("not-found");
    expect(await codeOf(host.agentTabs.launch({ agentId: "claude", cwd: "Projects/alpha/README.md" }))).toBe("io-error");
  });

  it("resume opens a known session, focuses the tab already bound to it, refuses an unknown one", async () => {
    const { host, fake } = await client({
      sessions: [{ agentId: "claude", sessionId: "s-old", cwd: "Projects/alpha" }],
      agentTabs: [{ tabId: "t1", projectId: "p-beta", agentId: "claude", sessionId: "s-live", state: "idle" }],
    });
    const { tabId } = await host.agentTabs.resume({ agentId: "claude", sessionId: "s-old" });
    expect(fake.openedAgentTabs.at(-1)).toMatchObject({ tabId, sessionId: "s-old", cwd: "Projects/alpha" });
    expect(fake.agentTabs.find((t) => t.tabId === tabId)?.sessionId).toBe("s-old");
    expect(await host.agentTabs.resume({ agentId: "claude", sessionId: "s-live" })).toEqual({ tabId: "t1" });
    expect(fake.focusedAgentTabs).toEqual(["t1"]);
    expect(fake.activeProject.id).toBe("p-beta");
    expect(await codeOf(host.agentTabs.resume({ agentId: "claude", sessionId: "s-none" }))).toBe("not-found");
  });

  it("focus switches to the tab's project; updates and closes are heard with what changed", async () => {
    const { host, fake } = await client({ agentTabs: [{ tabId: "t1", projectId: "p-beta", agentId: "claude" }] });
    const heard = await changes(host);
    await host.agentTabs.focus("t1");
    expect(fake.activeProject.id).toBe("p-beta");
    fake.updateAgentTab("t1", { sessionId: "s1", state: "working" });
    fake.updateAgentTab("t1", { state: "working" });
    fake.closeAgentTab("t1");
    await tick();
    expect(heard.map((h) => [h.changes, h.tab.state])).toEqual([
      [["session", "state"], "working"],
      [["closed"], "exited"],
    ]);
    expect(fake.agentTabs).toEqual([]);
  });

  it("needs its capabilities", async () => {
    const { host } = await client({}, { ...MANIFEST, capabilities: [] });
    expect(await codeOf(host.agentTabs.list())).toBe("capability-denied");
    expect(await codeOf(host.agentTabs.setTitle("t", "x"))).toBe("capability-denied");
    expect(await codeOf(host.agentTabs.launch({ agentId: "claude" }))).toBe("capability-denied");
  });
});
