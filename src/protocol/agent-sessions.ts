// Agent sessions an agents app serves to Pomade (PLATFORM rule 7; pomade-agents DESIGN §5): which
// sessions worked in a repository or worktree (`sessions.forRepo`, the Git panel's branch ↔ session
// link) and whether an agent is live in a folder (`sessions.liveIn`, what merge blocking and
// `pomade-git` ask). Pomade falls back to its own terminals when the app is absent, not answering
// or answers malformed. Shared by Pomade, the agents app and test stand-ins.

/** The app Pomade asks about agent sessions, and the methods it calls. */
export const SESSIONS_APP_ID = "pomade-agents";
export const SESSIONS_FOR_REPO_METHOD = "sessions.forRepo";
export const SESSIONS_LIVE_IN_METHOD = "sessions.liveIn";

/** A session's live state: on a turn, waiting at a prompt for the user, waiting for the next
 *  prompt, or not running anywhere. */
export type SessionLiveState = "working" | "needs-you" | "idle" | "closed";

export const SESSION_LIVE_STATES: readonly SessionLiveState[] = ["working", "needs-you", "idle", "closed"];

/** A session's status, set by the user in the agents app. */
export type SessionStatus = "active" | "on-hold" | "done" | "done-skip";

export const SESSION_STATUSES: readonly SessionStatus[] = ["active", "on-hold", "done", "done-skip"];

/** `sessions.forRepo` — the sessions whose start folder is `folder` or inside it, and, with
 *  `branch`, whose recorded branch is that one. */
export interface SessionsForRepoParams {
  /** A repository's or worktree's folder: absolute, symlinks resolved. */
  folder: string;
  /** A local branch name (`feature/login`). */
  branch?: string;
}

/** One session, as `sessions.forRepo` lists it. */
export interface RepoSession {
  /** The provider's session id. */
  id: string;
  /** The agent's roster id. */
  agent: string;
  /** The session's name; `null` = unnamed. */
  name: string | null;
  status: SessionStatus;
  live: SessionLiveState;
  /** The start folder: absolute, symlinks resolved. */
  cwd: string;
  /** The branch recorded when the session started; `null` when the provider records none. */
  branch: string | null;
  /** The session's project (stable id); `null` = the Workspace. */
  project: string | null;
  /** First and last activity (ISO 8601). */
  startedAt: string;
  lastActiveAt: string;
}

export interface SessionsForRepoResult {
  /** Newest activity first; `[]` when none. */
  sessions: RepoSession[];
}

/** `sessions.liveIn` — what runs at or below `folder` now. */
export interface SessionsLiveInParams {
  /** Absolute, symlinks resolved. */
  folder: string;
}

/** One agent running at or below the folder. */
export interface LiveSession {
  /** The session; `null` for an agent tab that has no session yet (not prompted). */
  sessionId: string | null;
  /** The agent's roster id. */
  agent: string;
  /** Where it runs: absolute, symlinks resolved. */
  cwd: string;
  /** `tab`: an agent tab in Pomade; `run`: an unattended Runner run. */
  source: "tab" | "run";
  /** The Runner job of a run; `null` for a tab. */
  job: string | null;
}

export interface SessionsLiveInResult {
  /** True exactly when `sessions` is not empty. */
  live: boolean;
  sessions: LiveSession[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[^\s/\\][^/\\\r\n]{0,127}$/.test(v);
const isAbs = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isNullableText = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.trim() !== "");

function isRepoSession(v: unknown): v is RepoSession {
  return (
    isObj(v) &&
    isId(v.id) &&
    isId(v.agent) &&
    isNullableText(v.name) &&
    (SESSION_STATUSES as readonly unknown[]).includes(v.status) &&
    (SESSION_LIVE_STATES as readonly unknown[]).includes(v.live) &&
    isAbs(v.cwd) &&
    isNullableText(v.branch) &&
    isNullableText(v.project) &&
    isIso(v.startedAt) &&
    isIso(v.lastActiveAt)
  );
}

/** Check an agents app's `sessions.forRepo` answer: its sessions with only `RepoSession`'s fields
 *  (a malformed session is dropped); `null` when the answer is not `{ sessions: [...] }` — Pomade
 *  then shows no link, as for an absent app. */
export function checkRepoSessions(v: unknown): RepoSession[] | null {
  if (!isObj(v) || !Array.isArray(v.sessions)) return null;
  return v.sessions.filter(isRepoSession).map((s) => ({
    id: s.id,
    agent: s.agent,
    name: s.name === null ? null : s.name.trim(),
    status: s.status,
    live: s.live,
    cwd: s.cwd,
    branch: s.branch,
    project: s.project,
    startedAt: s.startedAt,
    lastActiveAt: s.lastActiveAt,
  }));
}

function isLiveSession(v: unknown): v is LiveSession {
  return (
    isObj(v) &&
    (v.sessionId === null || isId(v.sessionId)) &&
    isId(v.agent) &&
    isAbs(v.cwd) &&
    (v.source === "tab" || v.source === "run") &&
    (v.source === "run" ? isNullableText(v.job) && v.job !== null : v.job === null)
  );
}

/** Check an agents app's `sessions.liveIn` answer. A malformed answer is refused whole (a bad
 *  entry, or `live` that disagrees with `sessions`) — Pomade then answers from its own terminals,
 *  exactly as for an absent app. */
export function checkLiveIn(v: unknown): { ok: true; result: SessionsLiveInResult } | { ok: false; message: string } {
  if (!isObj(v) || typeof v.live !== "boolean" || !Array.isArray(v.sessions)) {
    return { ok: false, message: "expected { live: boolean, sessions: [...] }" };
  }
  const sessions: LiveSession[] = [];
  for (const [i, s] of v.sessions.entries()) {
    if (!isLiveSession(s)) return { ok: false, message: `sessions[${i}]` };
    sessions.push({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd, source: s.source, job: s.job });
  }
  if (v.live !== sessions.length > 0) return { ok: false, message: '"live" must be true exactly when "sessions" is not empty' };
  return { ok: true, result: { live: v.live, sessions } };
}
