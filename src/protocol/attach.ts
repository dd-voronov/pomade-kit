// The attach protocol (pomade:E-034): how a client — Pomade's attached terminal tab, or the app
// that owns the sessions — talks to a keeper, the process that holds an app's terminal sessions.
// Platform-defined and keeper-agnostic: any keeper that speaks these messages serves Pomade's
// attached tabs. Pure — the message shapes, their checks, the framing and the socket location;
// the keeper is `pomade-kit/keeper`, the Node client `pomade-kit/node`.
//
// Framing: one JSON object per line over a unix socket (`encodeLine` / `createLineDecoder`, the
// Host API socket's framing). Terminal output travels as JSON strings.

import { APP_ID_RE } from "./manifest.js";
import { socketPathProblem } from "./socket.js";

const isAppId = (v: unknown): v is string => typeof v === "string" && APP_ID_RE.test(v);

/** The attach protocol version a client and a keeper speak; `hello` requires an exact match. */
export const ATTACH_PROTOCOL = 1;

/** Where every app's keeper socket lives, relative to Pomade's user-data folder (mode 0700). */
export const KEEPER_SOCKET_DIR = "run/keepers";

/** The socket of `appId`'s keeper: `<userData>/run/keepers/<appId>.sock`. Pomade gives the app's
 *  backend this path (`POMADE_KEEPER_SOCKET`) and connects to it directly to attach. */
export function keeperSocketPath(userData: string, appId: string): string {
  return `${userData.replace(/\/+$/, "")}/${KEEPER_SOCKET_DIR}/${appId}.sock`;
}

/** Why `appId`'s keeper socket cannot be used under `userData` (too long for macOS), or `null`. */
export function keeperSocketProblem(userData: string, appId: string): string | null {
  return socketPathProblem(keeperSocketPath(userData, appId));
}

/** A terminal session anywhere on the platform: the app whose keeper holds it, and its id there. */
export interface SessionRef {
  app: string;
  session: string;
}

/** A session id: letters, digits and `._:-`, starting with a letter or digit, at most 128 long. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID_PATTERN.test(v);
}

/** Check a session reference; returns the reference (unknown keys dropped) or what is wrong. */
export function checkSessionRef(raw: unknown): { ok: true; value: SessionRef } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '"session" must be an object { app, session }' };
  }
  const r = raw as Record<string, unknown>;
  if (!isAppId(r.app)) return { ok: false, message: '"session.app" must be an app id' };
  if (!isSessionId(r.session)) return { ok: false, message: `"session.session" must match ${SESSION_ID_PATTERN}` };
  return { ok: true, value: { app: r.app, session: r.session } };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** How a session ended. `stopped`: its owner stopped it · `stopped-by-you`: a person did (an
 *  interrupt typed through an attached tab, then the exit; or a Stop) · `time-limit`: its owner
 *  stopped it for running too long · `lost-in-keeper-crash`: the keeper died under it. */
export type ExitReason = "exited" | "crashed" | "stopped" | "stopped-by-you" | "time-limit" | "lost-in-keeper-crash";

export const EXIT_REASONS: readonly ExitReason[] = [
  "exited",
  "crashed",
  "stopped",
  "stopped-by-you",
  "time-limit",
  "lost-in-keeper-crash",
];

export interface SessionExit {
  /** The exit status; `null` when unknown (killed by a signal outside the shim, lost). */
  code: number | null;
  /** The signal that ended it (`SIGINT`, `SIGKILL`, …), or `null`. */
  signal: string | null;
  reason: ExitReason;
  /** Epoch milliseconds. */
  at: number;
}

/** A header action the owner contributes to an attached tab (Restart). Pomade shows it and, on a
 *  click, tells the owner through the event bus (`attachedTab.action`) — never over the keeper
 *  socket. */
export interface SessionAction {
  /** `^[a-z][a-z0-9-]{0,31}$`, unique within the session. */
  id: string;
  title: string;
}

export const SESSION_ACTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** At most this many header actions per session. */
export const SESSION_ACTIONS_MAX = 4;

/** What a keeper says about a session (`list`, `attach`, `info`). */
export interface SessionInfo {
  id: string;
  /** The owner's name for it ("Coda web"). */
  title: string;
  /** What runs: the command line, or the program and its arguments joined. */
  command: string;
  /** Absolute. */
  cwd: string;
  /** The session's process (the keeper's shim), or `null` once it ended. */
  pid: number | null;
  startedAt: number;
  cols: number;
  rows: number;
  state: "running" | "exited";
  exit: SessionExit | null;
  /** Clients attached now. */
  clients: number;
  actions: SessionAction[];
}

/** `spawn` — a new session (the owner only). */
export interface SpawnSpec {
  /** The session's id; default a generated one. An id held by an exited session is reused: its
   *  clients stay attached and get the new session's screen. A running session's id is refused. */
  id?: string;
  title: string;
  /** A shell command line, run by the user's login shell (`$SHELL -l -c`). */
  command?: string;
  /** Or a program and its arguments, run directly. Exactly one of `command` / `argv`. */
  argv?: string[];
  /** Absolute folder it runs in. */
  cwd: string;
  /** Added to the session's environment (after the keeper's terminal variables). */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Run with macOS background priority (`taskpolicy -b`). */
  background?: boolean;
  /** Also append the raw output to this file (absolute). */
  log?: string;
  actions?: SessionAction[];
}

/** Bounds for a terminal size. */
export const MIN_COLS = 2;
export const MIN_ROWS = 1;
export const MAX_COLS = 1000;
export const MAX_ROWS = 500;

// ── Messages ─────────────────────────────────────────────────────────────────

/** `owner`: the app whose sessions the keeper holds (proves it with the app's key) · `viewer`:
 *  anyone else — Pomade's attached tabs, another app. */
export type KeeperRole = "owner" | "viewer";

export interface KeeperHello {
  type: "hello";
  protocol: number;
  client: { app: string; role: KeeperRole; key?: string };
}

/** Client → keeper. `rid` matches a reply (`result` or `error`); messages without it are not
 *  answered. */
export type KeeperRequest =
  | KeeperHello
  | { type: "list"; rid: string }
  | { type: "spawn"; rid: string; spec: SpawnSpec }
  | {
      type: "attach";
      rid: string;
      session: string;
      /** Resize the session to this first (last active client wins). */
      cols?: number;
      rows?: number;
      /** What this client has seen of the session: its `startedAt` and the last `seq`. The keeper
       *  answers with the output since then (`delta`) when it is the same session and the keeper
       *  still holds that output, else with a `snapshot`. */
      since?: { startedAt: number; seq: number };
      /** Scrollback lines in a snapshot; default all the keeper keeps. */
      scrollback?: number;
    }
  | { type: "input"; session: string; data: string }
  | { type: "paste"; session: string; text: string }
  | { type: "resize"; session: string; cols: number; rows: number }
  | { type: "detach"; session: string }
  | {
      type: "stop";
      rid: string;
      session: string;
      /** The owner may say why (default `stopped`); a viewer's stop is always `stopped-by-you`. */
      reason?: "stopped" | "stopped-by-you" | "time-limit";
      /** Milliseconds between SIGTERM and SIGKILL; default 3000. */
      graceMs?: number;
    }
  | { type: "update"; rid: string; session: string; title?: string; actions?: SessionAction[] }
  | { type: "forget"; rid: string; session: string }
  | { type: "upgrade"; rid: string; entry: string; args?: string[] };

export type KeeperRequestType = KeeperRequest["type"];

/** Requests only the owner may send. */
export const OWNER_ONLY: readonly KeeperRequestType[] = ["spawn", "update", "forget", "upgrade"];

export type KeeperErrorCode =
  | "bad-request"
  | "unauthorized"
  | "version-mismatch"
  | "not-owner"
  | "unknown-session"
  | "session-running"
  | "spawn-failed"
  | "upgrade-failed";

/** Keeper → client. */
export type KeeperMessage =
  | { type: "welcome"; protocol: number; app: string; keeper: { version: string; pid: number } }
  | { type: "reject"; protocol: number; code: "unauthorized" | "version-mismatch"; message: string }
  | { type: "result"; rid: string; value: unknown }
  | { type: "error"; rid?: string; code: KeeperErrorCode; message: string }
  | {
      /** The session's screen, serialized: drawing it into an empty terminal reproduces the
       *  keeper's screen, scrollback, cursor and modes. Never a recording — it asks the terminal
       *  nothing. Sent on `attach`, and again (`resync`) after a client fell behind. */
      type: "snapshot";
      session: string;
      info: SessionInfo;
      data: string;
      seq: number;
      resync: boolean;
    }
  | {
      /** The output since the `since` an `attach` named; the client's screen stays. */
      type: "delta";
      session: string;
      info: SessionInfo;
      data: string;
      seq: number;
    }
  | { type: "output"; session: string; data: string; seq: number }
  | { type: "resized"; session: string; cols: number; rows: number }
  | { type: "exit"; session: string; exit: SessionExit }
  | { type: "info"; session: string; info: SessionInfo }
  | { type: "keeper-restarting"; reconnectAfterMs: number };

// ── Checks ───────────────────────────────────────────────────────────────────

type Check<T> = { ok: true; value: T } | { ok: false; message: string };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** A header-action list; returns the list or what is wrong with it. */
export function checkActions(raw: unknown, field = "actions"): Check<SessionAction[]> {
  if (!Array.isArray(raw)) return { ok: false, message: `"${field}" must be an array` };
  if (raw.length > SESSION_ACTIONS_MAX) return { ok: false, message: `"${field}" holds at most ${SESSION_ACTIONS_MAX} actions` };
  const out: SessionAction[] = [];
  for (const [i, a] of raw.entries()) {
    if (!obj(a) || typeof a.id !== "string" || !SESSION_ACTION_ID_PATTERN.test(a.id)) {
      return { ok: false, message: `"${field}[${i}].id" must match ${SESSION_ACTION_ID_PATTERN}` };
    }
    if (typeof a.title !== "string" || a.title.trim() === "" || a.title.length > 40) {
      return { ok: false, message: `"${field}[${i}].title" must be 1–40 characters` };
    }
    if (out.some((o) => o.id === a.id)) return { ok: false, message: `"${field}[${i}].id" repeats "${a.id}"` };
    out.push({ id: a.id, title: a.title.trim() });
  }
  return { ok: true, value: out };
}

function checkTitle(v: unknown, field: string): Check<string> {
  if (typeof v !== "string" || v.trim() === "" || v.length > 200) return { ok: false, message: `"${field}" must be 1–200 characters` };
  return { ok: true, value: v.trim() };
}

/** Check a `spawn` spec: one of `command` / `argv`, an absolute `cwd`, sizes in bounds. */
export function checkSpawnSpec(raw: unknown): Check<SpawnSpec> {
  if (!obj(raw)) return { ok: false, message: '"spec" must be an object' };
  const title = checkTitle(raw.title, "title");
  if (!title.ok) return title;
  const spec: SpawnSpec = { title: title.value, cwd: "" };
  if (raw.id !== undefined) {
    if (!isSessionId(raw.id)) return { ok: false, message: `"id" must match ${SESSION_ID_PATTERN}` };
    spec.id = raw.id;
  }
  const hasCommand = raw.command !== undefined;
  const hasArgv = raw.argv !== undefined;
  if (hasCommand === hasArgv) return { ok: false, message: 'exactly one of "command" and "argv" is required' };
  if (hasCommand) {
    if (typeof raw.command !== "string" || raw.command.trim() === "") return { ok: false, message: '"command" must be a non-empty string' };
    spec.command = raw.command;
  } else {
    const argv = raw.argv;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string") || argv[0] === "") {
      return { ok: false, message: '"argv" must be a non-empty array of strings' };
    }
    spec.argv = [...(argv as string[])];
  }
  if (typeof raw.cwd !== "string" || !raw.cwd.startsWith("/")) return { ok: false, message: '"cwd" must be an absolute path' };
  spec.cwd = raw.cwd;
  if (raw.env !== undefined) {
    if (!obj(raw.env) || !Object.values(raw.env).every((v) => typeof v === "string")) {
      return { ok: false, message: '"env" must map names to strings' };
    }
    spec.env = { ...(raw.env as Record<string, string>) };
  }
  if (raw.cols !== undefined) {
    if (!intIn(raw.cols, MIN_COLS, MAX_COLS)) return { ok: false, message: `"cols" must be an integer ${MIN_COLS}–${MAX_COLS}` };
    spec.cols = raw.cols;
  }
  if (raw.rows !== undefined) {
    if (!intIn(raw.rows, MIN_ROWS, MAX_ROWS)) return { ok: false, message: `"rows" must be an integer ${MIN_ROWS}–${MAX_ROWS}` };
    spec.rows = raw.rows;
  }
  if (raw.background !== undefined) {
    if (typeof raw.background !== "boolean") return { ok: false, message: '"background" must be a boolean' };
    spec.background = raw.background;
  }
  if (raw.log !== undefined) {
    if (typeof raw.log !== "string" || !raw.log.startsWith("/")) return { ok: false, message: '"log" must be an absolute path' };
    spec.log = raw.log;
  }
  if (raw.actions !== undefined) {
    const actions = checkActions(raw.actions);
    if (!actions.ok) return actions;
    spec.actions = actions.value;
  }
  return { ok: true, value: spec };
}

/** Parse one client → keeper message. Returns the request, or what is wrong (with its `rid` when
 *  it had one, so the keeper can answer). */
export function parseKeeperRequest(raw: unknown): { ok: true; value: KeeperRequest } | { ok: false; rid?: string; message: string } {
  if (!obj(raw) || typeof raw.type !== "string") return { ok: false, message: "not a keeper message" };
  const rid = typeof raw.rid === "string" && raw.rid !== "" && raw.rid.length <= 64 ? raw.rid : undefined;
  const bad = (message: string): { ok: false; rid?: string; message: string } => (rid === undefined ? { ok: false, message } : { ok: false, rid, message });
  const needRid = (): string | null => rid ?? null;
  const session = (): string | null => (isSessionId(raw.session) ? raw.session : null);
  switch (raw.type) {
    case "hello": {
      const c = raw.client;
      if (!intIn(raw.protocol, 0, Number.MAX_SAFE_INTEGER)) return bad('"protocol" must be an integer');
      if (!obj(c) || !isAppId(c.app) || (c.role !== "owner" && c.role !== "viewer")) {
        return bad('"client" must be { app, role: "owner" | "viewer", key? }');
      }
      if (c.key !== undefined && typeof c.key !== "string") return bad('"client.key" must be a string');
      const client: KeeperHello["client"] = { app: c.app, role: c.role };
      if (typeof c.key === "string") client.key = c.key;
      return { ok: true, value: { type: "hello", protocol: raw.protocol, client } };
    }
    case "list": {
      const r = needRid();
      return r === null ? bad('"rid" is required') : { ok: true, value: { type: "list", rid: r } };
    }
    case "spawn": {
      const r = needRid();
      if (r === null) return bad('"rid" is required');
      const spec = checkSpawnSpec(raw.spec);
      return spec.ok ? { ok: true, value: { type: "spawn", rid: r, spec: spec.value } } : bad(spec.message);
    }
    case "attach": {
      const r = needRid();
      const s = session();
      if (r === null) return bad('"rid" is required');
      if (s === null) return bad('"session" must be a session id');
      const m: Extract<KeeperRequest, { type: "attach" }> = { type: "attach", rid: r, session: s };
      if (raw.cols !== undefined || raw.rows !== undefined) {
        if (!intIn(raw.cols, MIN_COLS, MAX_COLS) || !intIn(raw.rows, MIN_ROWS, MAX_ROWS)) return bad('"cols" and "rows" go together, in bounds');
        m.cols = raw.cols;
        m.rows = raw.rows;
      }
      if (raw.since !== undefined) {
        const since = raw.since;
        if (!obj(since) || !intIn(since.startedAt, 0, Number.MAX_SAFE_INTEGER) || !intIn(since.seq, 0, Number.MAX_SAFE_INTEGER)) {
          return bad('"since" must be { startedAt, seq }, non-negative integers');
        }
        m.since = { startedAt: since.startedAt, seq: since.seq };
      }
      if (raw.scrollback !== undefined) {
        if (!intIn(raw.scrollback, 0, 1_000_000)) return bad('"scrollback" must be a non-negative integer');
        m.scrollback = raw.scrollback;
      }
      return { ok: true, value: m };
    }
    case "input":
    case "paste":
    case "resize":
    case "detach": {
      const s = session();
      if (s === null) return bad('"session" must be a session id');
      if (raw.type === "detach") return { ok: true, value: { type: "detach", session: s } };
      if (raw.type === "input") {
        return typeof raw.data === "string" ? { ok: true, value: { type: "input", session: s, data: raw.data } } : bad('"data" must be a string');
      }
      if (raw.type === "paste") {
        return typeof raw.text === "string" ? { ok: true, value: { type: "paste", session: s, text: raw.text } } : bad('"text" must be a string');
      }
      if (!intIn(raw.cols, MIN_COLS, MAX_COLS) || !intIn(raw.rows, MIN_ROWS, MAX_ROWS)) return bad('"cols" / "rows" out of bounds');
      return { ok: true, value: { type: "resize", session: s, cols: raw.cols, rows: raw.rows } };
    }
    case "stop": {
      const r = needRid();
      const s = session();
      if (r === null) return bad('"rid" is required');
      if (s === null) return bad('"session" must be a session id');
      const m: Extract<KeeperRequest, { type: "stop" }> = { type: "stop", rid: r, session: s };
      if (raw.reason !== undefined) {
        if (raw.reason !== "stopped" && raw.reason !== "stopped-by-you" && raw.reason !== "time-limit") {
          return bad('"reason" must be "stopped", "stopped-by-you" or "time-limit"');
        }
        m.reason = raw.reason;
      }
      if (raw.graceMs !== undefined) {
        if (!intIn(raw.graceMs, 0, 600_000)) return bad('"graceMs" must be an integer 0–600000');
        m.graceMs = raw.graceMs;
      }
      return { ok: true, value: m };
    }
    case "update": {
      const r = needRid();
      const s = session();
      if (r === null) return bad('"rid" is required');
      if (s === null) return bad('"session" must be a session id');
      const m: Extract<KeeperRequest, { type: "update" }> = { type: "update", rid: r, session: s };
      if (raw.title !== undefined) {
        const t = checkTitle(raw.title, "title");
        if (!t.ok) return bad(t.message);
        m.title = t.value;
      }
      if (raw.actions !== undefined) {
        const a = checkActions(raw.actions);
        if (!a.ok) return bad(a.message);
        m.actions = a.value;
      }
      return { ok: true, value: m };
    }
    case "forget": {
      const r = needRid();
      const s = session();
      if (r === null) return bad('"rid" is required');
      if (s === null) return bad('"session" must be a session id');
      return { ok: true, value: { type: "forget", rid: r, session: s } };
    }
    case "upgrade": {
      const r = needRid();
      if (r === null) return bad('"rid" is required');
      if (typeof raw.entry !== "string" || !raw.entry.startsWith("/")) return bad('"entry" must be an absolute path');
      if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))) {
        return bad('"args" must be an array of strings');
      }
      const m: Extract<KeeperRequest, { type: "upgrade" }> = { type: "upgrade", rid: r, entry: raw.entry };
      if (raw.args !== undefined) m.args = [...(raw.args as string[])];
      return { ok: true, value: m };
    }
    default:
      return bad(`unknown message type ${JSON.stringify(raw.type)}`);
  }
}

function isExit(v: unknown): v is SessionExit {
  return (
    obj(v) &&
    (v.code === null || typeof v.code === "number") &&
    (v.signal === null || typeof v.signal === "string") &&
    (EXIT_REASONS as readonly unknown[]).includes(v.reason) &&
    typeof v.at === "number"
  );
}

function isInfo(v: unknown): v is SessionInfo {
  return (
    obj(v) &&
    isSessionId(v.id) &&
    typeof v.title === "string" &&
    typeof v.command === "string" &&
    typeof v.cwd === "string" &&
    (v.pid === null || typeof v.pid === "number") &&
    typeof v.startedAt === "number" &&
    typeof v.cols === "number" &&
    typeof v.rows === "number" &&
    (v.state === "running" || v.state === "exited") &&
    (v.exit === null || isExit(v.exit)) &&
    typeof v.clients === "number" &&
    Array.isArray(v.actions)
  );
}

/** Parse one keeper → client message; `null` when it is not one. */
export function parseKeeperMessage(raw: unknown): KeeperMessage | null {
  if (!obj(raw) || typeof raw.type !== "string") return null;
  const s = isSessionId(raw.session);
  switch (raw.type) {
    case "welcome":
      return typeof raw.protocol === "number" && typeof raw.app === "string" && obj(raw.keeper) &&
        typeof raw.keeper.version === "string" && typeof raw.keeper.pid === "number"
        ? (raw as KeeperMessage)
        : null;
    case "reject":
      return typeof raw.protocol === "number" && (raw.code === "unauthorized" || raw.code === "version-mismatch") &&
        typeof raw.message === "string"
        ? (raw as KeeperMessage)
        : null;
    case "result":
      return typeof raw.rid === "string" ? (raw as KeeperMessage) : null;
    case "error":
      return typeof raw.code === "string" && typeof raw.message === "string" ? (raw as KeeperMessage) : null;
    case "snapshot":
      return s && isInfo(raw.info) && typeof raw.data === "string" && typeof raw.seq === "number" && typeof raw.resync === "boolean"
        ? (raw as KeeperMessage)
        : null;
    case "delta":
      return s && isInfo(raw.info) && typeof raw.data === "string" && typeof raw.seq === "number" ? (raw as KeeperMessage) : null;
    case "output":
      return s && typeof raw.data === "string" && typeof raw.seq === "number" ? (raw as KeeperMessage) : null;
    case "resized":
      return s && typeof raw.cols === "number" && typeof raw.rows === "number" ? (raw as KeeperMessage) : null;
    case "exit":
      return s && isExit(raw.exit) ? (raw as KeeperMessage) : null;
    case "info":
      return s && isInfo(raw.info) ? (raw as KeeperMessage) : null;
    case "keeper-restarting":
      return typeof raw.reconnectAfterMs === "number" ? (raw as KeeperMessage) : null;
    default:
      return null;
  }
}

// ── The platform side ──────────────────────────────────────────────────────

/** `attachedTab.action` (a platform event, delivered only to the owning app): the person clicked
 *  a header action the owner contributed on an attached tab. */
export interface AttachedTabActionPayload {
  session: SessionRef;
  /** The action's id. */
  action: string;
  /** The tab's project; `"__workspace__"` for the Workspace scope. */
  projectId: string;
}
