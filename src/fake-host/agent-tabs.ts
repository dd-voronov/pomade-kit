// The fake host's agent tabs (HOST-API §4 `agentTabs`, pomade:E-033): tabs seeded by the test or
// opened by the app, the same params checks as Pomade, and `agentTab.changed` on every change —
// the app's own calls and the user's actions a test plays (`renameAgentTab`, `updateAgentTab`,
// `closeAgentTab`).

import {
  DEFAULT_AGENT_MODE,
  parseAgentTabsParams,
  providerModes,
  type AgentTabChange,
  type AgentTabChangedPayload,
  type AgentTabInfo,
  type AgentTabSessionCause,
  type AgentTabState,
  type AgentTabsMethod,
  type ProjectRef,
  type RosterAgent,
} from "../protocol/index.js";
import { CallError } from "./params.js";
import type { Workspace } from "./workspace.js";

/** An agent tab a test seeds (`FakeHostOptions.agentTabs`); unset fields take a fresh tab's values. */
export type FakeAgentTabSeed = Pick<AgentTabInfo, "tabId" | "projectId" | "agentId"> & Partial<AgentTabInfo>;

/** A session `agentTabs.resume` can find (`FakeHostOptions.sessions`). */
export interface FakeSession {
  agentId: string;
  sessionId: string;
  /** The folder it ran in, workspace-relative; default any. */
  cwd?: string;
}

/** An agent tab the app opened (`agentTabs.launch` / `agentTabs.resume`), as the fake host records it. */
export interface FakeOpenedAgentTab {
  kind: "agent";
  tabId: string;
  projectId: string;
  agentId: string;
  /** Workspace-relative. */
  cwd: string;
  mode: string;
  prompt?: string;
  /** Resume only. */
  sessionId?: string;
}

/** What the agent tabs need from the fake host. */
export interface AgentTabsContext {
  readonly workspace: Workspace;
  /** The absolute folder the fake workspace stands for (`AgentTabInfo.cwd` is absolute). */
  readonly workspaceRoot: string;
  /** The project `id` names (the active one when absent); `not-found` for an unknown id. */
  project(id: string | undefined): ProjectRef;
  activate(id: string): void;
  publish(payload: AgentTabChangedPayload): void;
  now(): number;
}

/** The roster `agentTabs.launch` checks against when the test names none: Pomade's two built-ins. */
export const DEFAULT_FAKE_ROSTER: readonly RosterAgent[] = [
  { id: "claude", name: "Claude", command: "claude", provider: "claude" },
  { id: "codex", name: "Codex", command: "codex", provider: "codex" },
];

const TRACKED: readonly (keyof AgentTabInfo)[] = ["sessionId", "title", "titleSource", "unnamed", "state", "projectId"];

function changesBetween(before: AgentTabInfo, after: AgentTabInfo): AgentTabChange[] {
  const out = new Set<AgentTabChange>();
  for (const key of TRACKED) {
    if (before[key] === after[key]) continue;
    if (key === "sessionId") out.add("session");
    else if (key === "state") out.add("state");
    else if (key === "projectId") out.add("project");
    else out.add("title");
  }
  return [...out];
}

export class FakeAgentTabs {
  /** Every agent tab the app opened, in order. */
  readonly opened: FakeOpenedAgentTab[] = [];
  /** Every tab the app focused (`agentTabs.focus`, and `resume` of a bound session), in order. */
  readonly focused: string[] = [];
  private readonly tabs: AgentTabInfo[] = [];
  private nextId = 1;

  constructor(
    private readonly ctx: AgentTabsContext,
    private readonly roster: readonly RosterAgent[],
    private readonly sessions: readonly FakeSession[],
    seeds: readonly FakeAgentTabSeed[],
  ) {
    for (const seed of seeds) {
      if (this.tabs.some((t) => t.tabId === seed.tabId)) throw new Error(`fake host: agent tab ${JSON.stringify(seed.tabId)} seeded twice`);
      this.tabs.push({ ...this.fresh(seed.agentId, seed.projectId, seed.tabId, null), ...seed });
    }
  }

  /** A snapshot of every agent tab, in order. */
  list(): AgentTabInfo[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  private defaultTitle(agentId: string): string {
    return this.roster.find((a) => a.id === agentId)?.name ?? agentId;
  }

  private fresh(agentId: string, projectId: string, tabId: string, cwd: string | null): AgentTabInfo {
    return {
      tabId,
      projectId,
      agentId,
      cwd,
      launchedAt: new Date(this.ctx.now()).toISOString(),
      sessionId: null,
      title: this.defaultTitle(agentId),
      titleSource: "default",
      unnamed: false,
      state: "idle",
    };
  }

  private find(tabId: string): AgentTabInfo {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new CallError("not-found", `No agent tab ${JSON.stringify(tabId)}`);
    return tab;
  }

  /** Apply `patch` and publish what changed. A session change carries its cause: `cause` when the
   *  test names one, else `first` for a tab that had none and `unknown` otherwise; a binding that
   *  goes to `null` is always `unknown`, as in Pomade. */
  private change(tab: AgentTabInfo, patch: Partial<AgentTabInfo>, cause?: AgentTabSessionCause): void {
    const before = { ...tab };
    Object.assign(tab, patch);
    const changes = changesBetween(before, tab);
    if (changes.length === 0) return;
    if (!changes.includes("session")) {
      this.ctx.publish({ tab: { ...tab }, changes });
      return;
    }
    const why = tab.sessionId === null ? "unknown" : (cause ?? (before.sessionId === null ? "first" : "unknown"));
    this.ctx.publish({ tab: { ...tab }, changes, session: { cause: why, previousSessionId: before.sessionId } });
  }

  private absolute(rel: string): string {
    return rel === "" ? this.ctx.workspaceRoot : `${this.ctx.workspaceRoot}/${rel}`;
  }

  private folder(cwd: string | undefined, project: ProjectRef): string {
    const rel = cwd ?? project.root;
    const kind = this.ctx.workspace.kindOf(rel);
    if (rel !== "" && kind === null) throw new CallError("not-found", `${JSON.stringify(rel)} does not exist`);
    if (rel !== "" && kind !== "dir") throw new CallError("io-error", `${JSON.stringify(rel)} is not a folder`);
    return rel;
  }

  private open(record: Omit<FakeOpenedAgentTab, "kind" | "tabId">): string {
    const tabId = `agent-tab-${this.nextId++}`;
    const tab = { ...this.fresh(record.agentId, record.projectId, tabId, this.absolute(record.cwd)), sessionId: record.sessionId ?? null };
    this.tabs.push(tab);
    this.opened.push({ kind: "agent", tabId, ...record });
    this.ctx.activate(record.projectId);
    this.ctx.publish({ tab: { ...tab }, changes: ["opened"] });
    return tabId;
  }

  dispatch(method: AgentTabsMethod, raw: unknown): unknown {
    const parsed = parseAgentTabsParams(method, raw);
    if (!parsed.ok) throw new CallError(parsed.error.code, parsed.error.message);
    switch (method) {
      case "agentTabs.list": {
        const p = parsed.params as { projectId?: string };
        if (p.projectId !== undefined) this.ctx.project(p.projectId);
        return { tabs: this.list().filter((t) => p.projectId === undefined || t.projectId === p.projectId) };
      }
      case "agentTabs.setTitle": {
        const p = parsed.params as { tabId: string; title: string | null };
        const tab = this.find(p.tabId);
        this.change(
          tab,
          p.title === null
            ? { title: this.defaultTitle(tab.agentId), titleSource: "default", unnamed: true }
            : { title: p.title, titleSource: "app", unnamed: false },
        );
        return {};
      }
      case "agentTabs.focus": {
        const tab = this.find((parsed.params as { tabId: string }).tabId);
        this.ctx.activate(tab.projectId);
        this.focused.push(tab.tabId);
        return {};
      }
      case "agentTabs.launch": {
        const p = parsed.params as { agentId: string; projectId?: string; cwd?: string; mode?: string; prompt?: string };
        const agent = this.roster.find((a) => a.id === p.agentId);
        if (!agent) throw new CallError("not-found", `No agent ${JSON.stringify(p.agentId)} in the roster`);
        const mode = p.mode ?? DEFAULT_AGENT_MODE;
        if (!(agent.modes ?? providerModes(agent.provider)).some((m) => m.id === mode)) {
          throw new CallError("invalid-params", `Agent ${JSON.stringify(agent.id)} has no mode ${JSON.stringify(mode)}`);
        }
        const project = this.ctx.project(p.projectId);
        const cwd = this.folder(p.cwd, project);
        return { tabId: this.open({ projectId: project.id, agentId: agent.id, cwd, mode, ...(p.prompt !== undefined ? { prompt: p.prompt } : {}) }) };
      }
      case "agentTabs.resume": {
        const p = parsed.params as { agentId: string; sessionId: string; projectId?: string; cwd?: string };
        if (!this.roster.some((a) => a.id === p.agentId)) throw new CallError("not-found", `No agent ${JSON.stringify(p.agentId)} in the roster`);
        const project = this.ctx.project(p.projectId);
        const cwd = this.folder(p.cwd, project);
        const bound = this.tabs.find((t) => t.agentId === p.agentId && t.sessionId === p.sessionId && t.state !== "exited");
        if (bound) {
          this.ctx.activate(bound.projectId);
          this.focused.push(bound.tabId);
          return { tabId: bound.tabId };
        }
        const known = this.sessions.some((s) => s.agentId === p.agentId && s.sessionId === p.sessionId && (s.cwd === undefined || s.cwd === cwd));
        if (!known) throw new CallError("not-found", `No session ${JSON.stringify(p.sessionId)} of ${JSON.stringify(p.agentId)} in ${JSON.stringify(cwd)}`);
        return { tabId: this.open({ projectId: project.id, agentId: p.agentId, cwd, mode: DEFAULT_AGENT_MODE, sessionId: p.sessionId }) };
      }
    }
  }

  // ── Test controls ──────────────────────────────────────────────────────────

  /** The user renames the tab. */
  rename(tabId: string, title: string): void {
    this.change(this.require(tabId), { title, titleSource: "user", unnamed: false });
  }

  /** Something happened in the tab: a session bound (`sessionId`, for `cause`), a state change, a move (`projectId`). */
  update(
    tabId: string,
    patch: Partial<Pick<AgentTabInfo, "sessionId" | "state" | "projectId" | "cwd" | "launchedAt">>,
    cause?: AgentTabSessionCause,
  ): void {
    this.change(this.require(tabId), patch, cause);
  }

  /** The tab closes (or its agent hands the shell back): it leaves the list. */
  close(tabId: string, state: AgentTabState = "exited"): void {
    const tab = this.require(tabId);
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.ctx.publish({ tab: { ...tab, state }, changes: ["closed"] });
  }

  private require(tabId: string): AgentTabInfo {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error(`fake host: no agent tab ${JSON.stringify(tabId)}`);
    return tab;
  }
}
