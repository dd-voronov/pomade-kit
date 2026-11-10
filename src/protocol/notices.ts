// Notices (HOST-API §4 `notices`, pomade:E-032): what a notice carries, its click action, the
// rules every host checks, and the closed-Pomade queue's file format — shared by Pomade, the fake
// host and `pomade-kit/node`'s `postNotice`.

import { APP_ID_RE } from "./manifest.js";
import { isPomadeFolderPath, normalizeWorkspacePath, pomadeFolderMessage } from "./paths.js";

/** What clicking a notice does: open a file or a terminal tab, open the posting app's own tab at a
 *  route (exactly `tabs.openApp`), or nothing. `projectId` defaults to the active project. */
export type NoticeAction =
  | { kind: "openFile"; path: string; projectId?: string }
  | { kind: "openTerminal"; cwd: string; command?: string; title?: string; projectId?: string }
  | { kind: "openApp"; route?: string; projectId?: string };

export const NOTICE_ACTION_KINDS: readonly NoticeAction["kind"][] = ["openFile", "openTerminal", "openApp"];

/** `notices.post` — one notice. */
export interface NoticeParams {
  /** One line, shown in bold; trimmed, 1–200 characters. */
  title: string;
  /** Plain text under the title, at most 2000 characters. */
  body?: string;
  /** What a click on the notice does; none = the notice is only read. */
  action?: NoticeAction;
}

export const NOTICE_TITLE_MAX_LENGTH = 200;
export const NOTICE_BODY_MAX_LENGTH = 2000;

/** A refused notice: the code and a readable message. */
export interface NoticeError {
  code: "invalid-params" | "outside-workspace" | "capability-denied";
  message: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: NoticeError };

function invalid(message: string): { ok: false; error: NoticeError } {
  return { ok: false, error: { code: "invalid-params", message } };
}

/** A path field of an action, by the workspace-path rule (HOST-API §4). */
function actionPath(raw: unknown, key: string): Checked<string> {
  if (typeof raw !== "string" || raw.includes("\0")) return invalid(`"action.${key}" must be a workspace path`);
  const n = normalizeWorkspacePath(raw);
  if (!n.ok) return { ok: false, error: { code: "outside-workspace", message: `${JSON.stringify(raw)} is outside the workspace` } };
  if (isPomadeFolderPath(n.path)) return { ok: false, error: { code: "capability-denied", message: pomadeFolderMessage(raw) } };
  return { ok: true, value: n.path };
}

function checkAction(raw: unknown): Checked<NoticeAction> {
  if (!isObj(raw)) return invalid('"action" must be an object');
  if (raw.projectId !== undefined && typeof raw.projectId !== "string") return invalid('"action.projectId" must be a project id');
  const project = raw.projectId !== undefined ? { projectId: raw.projectId } : {};
  switch (raw.kind) {
    case "openFile": {
      const path = actionPath(raw.path, "path");
      if (!path.ok) return path;
      if (path.value === "") return invalid('"action.path" must name a file');
      return { ok: true, value: { kind: "openFile", path: path.value, ...project } };
    }
    case "openTerminal": {
      const cwd = actionPath(raw.cwd ?? "", "cwd");
      if (!cwd.ok) return cwd;
      const out: NoticeAction = { kind: "openTerminal", cwd: cwd.value, ...project };
      if (raw.command !== undefined) {
        if (typeof raw.command !== "string" || raw.command.trim() === "" || /[\r\n]/.test(raw.command)) {
          return invalid('"action.command" must be one non-empty line');
        }
        out.command = raw.command;
      }
      if (raw.title !== undefined) {
        if (typeof raw.title !== "string" || raw.title.trim() === "") return invalid('"action.title" must be a non-empty string');
        out.title = raw.title.trim();
      }
      return { ok: true, value: out };
    }
    case "openApp": {
      if (raw.route !== undefined && typeof raw.route !== "string") return invalid('"action.route" must be a string');
      return { ok: true, value: { kind: "openApp", route: (raw.route as string | undefined) ?? "", ...project } };
    }
    default:
      return invalid(`"action.kind" must be one of ${NOTICE_ACTION_KINDS.join(", ")} (got ${JSON.stringify(raw.kind)})`);
  }
}

/** Check and normalize a notice: the title trimmed, action paths normalized; unknown keys dropped. */
export function checkNotice(params: unknown): Checked<NoticeParams> {
  if (!isObj(params)) return invalid("params must be an object");
  const title = typeof params.title === "string" ? params.title.trim() : null;
  if (!title) return invalid('"title" must be a non-empty string');
  if (title.length > NOTICE_TITLE_MAX_LENGTH || /[\r\n]/.test(title)) {
    return invalid(`"title" must be one line of at most ${NOTICE_TITLE_MAX_LENGTH} characters`);
  }
  const notice: NoticeParams = { title };
  if (params.body !== undefined) {
    if (typeof params.body !== "string" || params.body.length > NOTICE_BODY_MAX_LENGTH) {
      return invalid(`"body" must be a string of at most ${NOTICE_BODY_MAX_LENGTH} characters`);
    }
    if (params.body !== "") notice.body = params.body;
  }
  if (params.action !== undefined) {
    const action = checkAction(params.action);
    if (!action.ok) return action;
    notice.action = action.value;
  }
  return { ok: true, value: notice };
}

/** The capability a notice's action needs from the posting app, or `null`: opening a file or a
 *  terminal is `tabs.open` (as `tabs.openFile` / `tabs.openTerminal`); the app's own tab needs none. */
export function noticeActionCapability(action: NoticeAction | undefined): "tabs.open" | null {
  return action && action.kind !== "openApp" ? "tabs.open" : null;
}

// ── The closed-Pomade queue ─────────────────────────────────────────────────

/** The queue folder, relative to Pomade's user data. A poster writes `<name>.json` atomically
 *  (a dot-file first, then a rename); Pomade drains the folder on launch and watches it while running. */
export const NOTICE_QUEUE_DIR = "notices/queue";

/** One queued notice: a notice plus who posted it and when. */
export interface QueuedNotice extends NoticeParams {
  /** The poster: an app id, or a platform command (`pomade-git`). */
  source: string;
  /** When it was posted (ISO 8601). */
  postedAt: string;
}

/** Validate a queue file's parsed JSON. */
export function parseQueuedNotice(value: unknown): { ok: true; notice: QueuedNotice } | { ok: false; message: string } {
  if (!isObj(value)) return { ok: false, message: "a queued notice must be a JSON object" };
  if (typeof value.source !== "string" || !APP_ID_RE.test(value.source)) {
    return { ok: false, message: `"source" must be an app or command id matching ${APP_ID_RE.source}` };
  }
  if (typeof value.postedAt !== "string" || Number.isNaN(Date.parse(value.postedAt))) {
    return { ok: false, message: '"postedAt" must be an ISO 8601 date' };
  }
  const notice = checkNotice(value);
  if (!notice.ok) return { ok: false, message: notice.error.message };
  return { ok: true, notice: { ...notice.value, source: value.source, postedAt: new Date(value.postedAt).toISOString() } };
}

/** A queue file's name for a notice posted at `at`: sortable by time, unique by `nonce`. */
export function queuedNoticeFileName(at: Date, nonce: string): string {
  return `${at.getTime().toString().padStart(15, "0")}-${nonce}.json`;
}
