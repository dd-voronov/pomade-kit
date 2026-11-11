// Agent tabs (HOST-API §4 `agentTabs`, pomade:E-033): the agent tabs Pomade runs — which session
// each one is bound to, its title, its live state — and the calls that focus one, launch an agent
// or resume a session in a tab. Also the roster an agents app serves to Pomade (`roster.list`,
// PLATFORM rule 7: Pomade falls back to its own folder scan). Shared by Pomade and the fake host.

import { isPomadeFolderPath, normalizeWorkspacePath, pomadeFolderMessage } from "./paths.js";
import type { ErrorPayload } from "./types.js";

/** What the agent in a tab is doing. `working`: on a turn; `needs-you`: waiting at a permission or
 *  folder-trust prompt; `idle`: waiting for the next prompt (also before its first output says
 *  otherwise); `exited`: no agent process runs in the tab (it ended, or the tab was not revived). */
export type AgentTabState = "working" | "needs-you" | "idle" | "exited";

export const AGENT_TAB_STATES: readonly AgentTabState[] = ["working", "needs-you", "idle", "exited"];

/** Who gave the tab its title: Pomade's default (the agent's name), the user (renamed the tab), or an app (`agentTabs.setTitle`). */
export type AgentTabTitleSource = "default" | "user" | "app";

export const AGENT_TAB_TITLE_SOURCES: readonly AgentTabTitleSource[] = ["default", "user", "app"];

/** One agent tab, bound to a session or not yet. */
export interface AgentTabInfo {
  tabId: string;
  /** The tab's project (`"__workspace__"` for the Workspace scope). */
  projectId: string;
  /** The agent's roster id. */
  agentId: string;
  /** The folder the agent was launched in: absolute, symlinks resolved — the key of the agent's
   *  own session store. `null` until the launch has been seen. */
  cwd: string | null;
  /** When the agent was launched in this tab (ISO 8601); `null` until the launch has been seen. */
  launchedAt: string | null;
  /** The session bound to the tab; `null` when none is bound (not prompted yet, or the binding is unsure). */
  sessionId: string | null;
  /** The title the tab shows. */
  title: string;
  titleSource: AgentTabTitleSource;
  /** An app marked the tab's session unnamed: the tab shows its default title in italics with an "unnamed" dot. */
  unnamed: boolean;
  state: AgentTabState;
}

/** What changed in an `agentTab.changed` event. `opened`: the tab joined the list (launched,
 *  resumed, or a shell became an agent); `closed`: it left the list (closed, or its agent handed
 *  the shell back); `session`: the bound session; `title`: the title, its source or the unnamed
 *  mark; `state`: the live state; `project`: the tab moved to another project. */
export type AgentTabChange = "opened" | "closed" | "session" | "title" | "state" | "project";

export const AGENT_TAB_CHANGES: readonly AgentTabChange[] = ["opened", "closed", "session", "title", "state", "project"];

/** `agentTab.changed` — the tab as it is now, and what changed. */
export interface AgentTabChangedPayload {
  tab: AgentTabInfo;
  changes: AgentTabChange[];
}

// ── Methods ─────────────────────────────────────────────────────────────────

/** `agentTabs.list` — every agent tab, or one project's. */
export interface AgentTabsListParams {
  projectId?: string;
}

export interface AgentTabsListResult {
  tabs: AgentTabInfo[];
}

/** `agentTabs.setTitle` — name the tab (`title`), or mark its session unnamed (`null`). */
export interface AgentTabsSetTitleParams {
  tabId: string;
  /** Trimmed, 1–200 characters, one line; `null` = the session is unnamed. */
  title: string | null;
}

/** `agentTabs.focus` — bring the tab to the front: its project becomes active. */
export interface AgentTabsFocusParams {
  tabId: string;
}

/** `agentTabs.launch` — start an agent in a new tab. */
export interface AgentTabsLaunchParams {
  /** The roster id. */
  agentId: string;
  /** The project whose tab strip gets the tab; default the active project. Pomade switches to it. */
  projectId?: string;
  /** A folder, workspace-relative; default the project's folder (the workspace root for the Workspace scope). */
  cwd?: string;
  /** A mode the roster lists for the agent; default `"normal"`. */
  mode?: string;
  /** The first prompt, submitted once the agent is ready. */
  prompt?: string;
}

/** `agentTabs.resume` — resume a session in a new tab, or focus the tab it is already bound to. */
export interface AgentTabsResumeParams {
  agentId: string;
  sessionId: string;
  projectId?: string;
  /** The folder the session ran in, workspace-relative; default the project's folder. */
  cwd?: string;
}

export interface AgentTabsOpenResult {
  /** The tab the agent runs in. */
  tabId: string;
}

/** A tab title's longest length. */
export const AGENT_TAB_TITLE_MAX = 200;
/** A launch prompt's longest length, in characters. */
export const AGENT_PROMPT_MAX = 16_384;
/** The mode every agent has: the agent's own settings. */
export const DEFAULT_AGENT_MODE = "normal";
/** A roster id or mode id: no slashes, no line breaks, no surrounding blanks. */
const ID_RE = /^[^\s/\\][^/\\\r\n]{0,127}$/;
/** A session id as agent CLIs write them (uuids, codex rollout ids). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AgentTabsMethod = "agentTabs.list" | "agentTabs.setTitle" | "agentTabs.focus" | "agentTabs.launch" | "agentTabs.resume";

export interface AgentTabsParamsMap {
  "agentTabs.list": AgentTabsListParams;
  "agentTabs.setTitle": AgentTabsSetTitleParams;
  "agentTabs.focus": AgentTabsFocusParams;
  "agentTabs.launch": AgentTabsLaunchParams;
  "agentTabs.resume": AgentTabsResumeParams;
}

type Checked<M extends AgentTabsMethod> = { ok: true; params: AgentTabsParamsMap[M] } | { ok: false; error: ErrorPayload };

class ParamError extends Error {
  constructor(readonly error: ErrorPayload) {
    super(error.message);
  }
}

function fail(code: ErrorPayload["code"], message: string): never {
  throw new ParamError({ code, message });
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") fail("invalid-params", `"${key}" must be a string`);
  return v;
}

function optionalStr(o: Record<string, unknown>, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}

function id(o: Record<string, unknown>, key: string): string {
  const v = str(o, key);
  if (!ID_RE.test(v) || v !== v.trim()) fail("invalid-params", `"${key}" must be an id: no slashes, line breaks or surrounding blanks`);
  return v;
}

function folder(o: Record<string, unknown>): { cwd?: string } {
  if (o.cwd === undefined) return {};
  const raw = str(o, "cwd");
  if (raw.includes("\0")) fail("invalid-params", '"cwd" must not contain NUL');
  const n = normalizeWorkspacePath(raw);
  if (!n.ok) fail("outside-workspace", `${JSON.stringify(raw)} is outside the workspace`);
  if (isPomadeFolderPath(n.path)) fail("capability-denied", pomadeFolderMessage(raw));
  return { cwd: n.path };
}

function project(o: Record<string, unknown>): { projectId?: string } {
  const projectId = optionalStr(o, "projectId");
  return projectId === undefined ? {} : { projectId };
}

/** A title to set: trimmed, one line, 1–`AGENT_TAB_TITLE_MAX` characters; or `null`. A problem as a message. */
export function checkAgentTabTitle(v: unknown): { ok: true; title: string | null } | { ok: false; message: string } {
  if (v === null) return { ok: true, title: null };
  if (typeof v !== "string") return { ok: false, message: '"title" must be a string or null' };
  const title = v.trim();
  if (title === "") return { ok: false, message: '"title" must not be empty (null marks the session unnamed)' };
  if (/[\r\n]/.test(title)) return { ok: false, message: '"title" must be one line' };
  if ([...title].length > AGENT_TAB_TITLE_MAX) return { ok: false, message: `"title" must be at most ${AGENT_TAB_TITLE_MAX} characters` };
  return { ok: true, title };
}

/** Validate an `agentTabs.*` call's params: omitted params are `{}`, unknown keys are dropped,
 *  `cwd` follows the workspace-path rule. Whether the tab, project, folder, agent, mode or session
 *  exists is the host's check. */
export function parseAgentTabsParams<M extends AgentTabsMethod>(method: M, params: unknown): Checked<M> {
  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
    return { ok: false, error: { code: "invalid-params", message: "params must be an object" } };
  }
  const o = (params ?? {}) as Record<string, unknown>;
  try {
    const out = ((): AgentTabsParamsMap[AgentTabsMethod] => {
      switch (method as AgentTabsMethod) {
        case "agentTabs.list":
          return project(o);
        case "agentTabs.setTitle": {
          const tabId = str(o, "tabId");
          if (!Object.hasOwn(o, "title")) fail("invalid-params", '"title" is required (null marks the session unnamed)');
          const t = checkAgentTabTitle(o.title);
          if (!t.ok) fail("invalid-params", t.message);
          return { tabId, title: t.title };
        }
        case "agentTabs.focus":
          return { tabId: str(o, "tabId") };
        case "agentTabs.launch": {
          const agentId = id(o, "agentId");
          const mode = o.mode === undefined ? {} : { mode: id(o, "mode") };
          const prompt = optionalStr(o, "prompt");
          if (prompt !== undefined) {
            if (prompt.trim() === "") fail("invalid-params", '"prompt" must not be empty');
            if (prompt.length > AGENT_PROMPT_MAX) fail("invalid-params", `"prompt" must be at most ${AGENT_PROMPT_MAX} characters`);
          }
          return { agentId, ...project(o), ...folder(o), ...mode, ...(prompt !== undefined ? { prompt } : {}) };
        }
        case "agentTabs.resume": {
          const agentId = id(o, "agentId");
          const sessionId = str(o, "sessionId");
          if (!SESSION_ID_RE.test(sessionId)) fail("invalid-params", '"sessionId" must be a session id (letters, digits, ".", "_", ":", "-")');
          return { agentId, sessionId, ...project(o), ...folder(o) };
        }
      }
    })();
    return { ok: true, params: out as AgentTabsParamsMap[M] };
  } catch (e) {
    if (e instanceof ParamError) return { ok: false, error: e.error };
    throw e;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/** True for a well-formed `AgentTabInfo`. */
export function isAgentTabInfo(v: unknown): v is AgentTabInfo {
  return (
    isObj(v) &&
    typeof v.tabId === "string" &&
    typeof v.projectId === "string" &&
    typeof v.agentId === "string" &&
    (v.cwd === null || typeof v.cwd === "string") &&
    (v.launchedAt === null || (typeof v.launchedAt === "string" && ISO_RE.test(v.launchedAt))) &&
    (v.sessionId === null || typeof v.sessionId === "string") &&
    typeof v.title === "string" &&
    (AGENT_TAB_TITLE_SOURCES as readonly unknown[]).includes(v.titleSource) &&
    typeof v.unnamed === "boolean" &&
    (AGENT_TAB_STATES as readonly unknown[]).includes(v.state)
  );
}

/** A copy of `v` with only `AgentTabInfo`'s fields. */
export function pickAgentTabInfo(v: AgentTabInfo): AgentTabInfo {
  return {
    tabId: v.tabId,
    projectId: v.projectId,
    agentId: v.agentId,
    cwd: v.cwd,
    launchedAt: v.launchedAt,
    sessionId: v.sessionId,
    title: v.title,
    titleSource: v.titleSource,
    unnamed: v.unnamed,
    state: v.state,
  };
}

/** True for a well-formed `agentTab.changed` payload (at least one change, each known). */
export function isAgentTabChanged(v: unknown): v is AgentTabChangedPayload {
  return (
    isObj(v) &&
    isAgentTabInfo(v.tab) &&
    Array.isArray(v.changes) &&
    v.changes.length > 0 &&
    v.changes.every((c) => (AGENT_TAB_CHANGES as readonly unknown[]).includes(c))
  );
}

// ── The roster an agents app serves (PLATFORM rule 7) ───────────────────────

/** The app Pomade asks for the agent roster, and the method it calls. */
export const ROSTER_APP_ID = "pomade-agents";
export const ROSTER_METHOD = "roster.list";

/** An agent's provider: which CLI it is, which decides its session store and resume flag. */
export type AgentProvider = "claude" | "codex";

/** One way to launch an agent: `args` follow the agent's command. */
export interface RosterMode {
  /** `"normal"` is the agent's own settings; others as the app names them (`"full-autonomy"`). */
  id: string;
  name: string;
  args: string[];
}

/** One agent of the roster, as the agents app answers `roster.list`. */
export interface RosterAgent {
  id: string;
  name: string;
  /** What the shell runs (an alias or a command on `PATH`). */
  command: string;
  provider: AgentProvider;
  /** The agent's own config folder, absolute — where its session store is. Default the provider's
   *  (`$CLAUDE_CONFIG_DIR` or `~/.claude`; `$CODEX_HOME` or `~/.codex`). */
  configDir?: string;
  /** The modes it offers, `"normal"` first; default the provider's (`providerModes`). */
  modes?: RosterMode[];
}

export interface RosterListResult {
  agents: RosterAgent[];
}

function isMode(v: unknown): v is RosterMode {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    ID_RE.test(v.id) &&
    typeof v.name === "string" &&
    v.name.trim() !== "" &&
    Array.isArray(v.args) &&
    v.args.every((a) => typeof a === "string" && !/[\r\n]/.test(a))
  );
}

/** Check an agents app's `roster.list` answer. A malformed answer is refused whole — Pomade then
 *  falls back to its own scan, exactly as for an absent app. */
export function checkRosterList(v: unknown): { ok: true; agents: RosterAgent[] } | { ok: false; message: string } {
  if (!isObj(v) || !Array.isArray(v.agents)) return { ok: false, message: 'expected { agents: [...] }' };
  const seen = new Set<string>();
  const agents: RosterAgent[] = [];
  for (const [i, a] of v.agents.entries()) {
    if (!isObj(a)) return { ok: false, message: `agents[${i}] must be an object` };
    if (typeof a.id !== "string" || !ID_RE.test(a.id) || seen.has(a.id)) return { ok: false, message: `agents[${i}].id` };
    if (typeof a.name !== "string" || a.name.trim() === "") return { ok: false, message: `agents[${i}].name` };
    if (typeof a.command !== "string" || a.command.trim() === "" || /[\r\n]/.test(a.command)) return { ok: false, message: `agents[${i}].command` };
    if (a.provider !== "claude" && a.provider !== "codex") return { ok: false, message: `agents[${i}].provider` };
    if (a.configDir !== undefined && (typeof a.configDir !== "string" || !a.configDir.startsWith("/"))) {
      return { ok: false, message: `agents[${i}].configDir` };
    }
    if (a.modes !== undefined && (!Array.isArray(a.modes) || !a.modes.every(isMode))) return { ok: false, message: `agents[${i}].modes` };
    seen.add(a.id);
    agents.push({
      id: a.id,
      name: a.name.trim(),
      command: a.command.trim(),
      provider: a.provider,
      ...(a.configDir !== undefined ? { configDir: a.configDir as string } : {}),
      ...(a.modes !== undefined ? { modes: (a.modes as RosterMode[]).map((m) => ({ id: m.id, name: m.name.trim(), args: [...m.args] })) } : {}),
    });
  }
  return { ok: true, agents };
}

/** The modes a provider offers when the roster names none (Pomade's own scan, or an app entry
 *  without `modes`): Normal, and Full autonomy — the provider's own skip-every-prompt flag. */
export function providerModes(provider: AgentProvider): RosterMode[] {
  return [
    { id: DEFAULT_AGENT_MODE, name: "Normal", args: [] },
    {
      id: "full-autonomy",
      name: "Full autonomy",
      args: provider === "codex" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--dangerously-skip-permissions"],
    },
  ];
}
