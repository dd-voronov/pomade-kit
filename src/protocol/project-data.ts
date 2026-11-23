// Validation and merging for the per-project data an app writes (pomade:E-030): its settings
// (plain JSON, size-capped), the project's visible agents, and its scope folders (pomade:E-047).
// Shared by Pomade and the fake host.

import { isPomadeFolderPath, normalizeWorkspacePath, pomadeFolderMessage } from "./paths.js";
import { PROJECT_SETTINGS_MAX_BYTES, type ErrorPayload, type JsonValue } from "./types.js";

const MAX_DEPTH = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Why `v` is not plain JSON (a finite number, string, boolean, null, array or plain object, at
 *  most 32 levels deep), or `null` when it is. */
export function jsonProblem(v: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return `nested deeper than ${MAX_DEPTH} levels`;
  if (v === null || typeof v === "string" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : `${String(v)} is not a JSON number`;
  if (Array.isArray(v)) {
    for (const item of v) {
      const p = jsonProblem(item, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (isPlainObject(v)) {
    for (const item of Object.values(v)) {
      const p = jsonProblem(item, depth + 1);
      if (p) return p;
    }
    return null;
  }
  return `a ${typeof v} is not JSON`;
}

/** Merge a `project.setSettings` patch into an app's settings: a `null` value removes its key. */
export function mergeProjectSettings(
  current: Readonly<Record<string, JsonValue>>,
  patch: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Why merged settings cannot be stored (over `PROJECT_SETTINGS_MAX_BYTES` as UTF-8 JSON), or `null`. */
export function settingsSizeProblem(settings: Readonly<Record<string, JsonValue>>): string | null {
  const bytes = new TextEncoder().encode(JSON.stringify(settings)).length;
  return bytes > PROJECT_SETTINGS_MAX_BYTES ? `settings are ${bytes} bytes; the limit is ${PROJECT_SETTINGS_MAX_BYTES}` : null;
}

/** A visible-agents list as stored: trimmed, deduplicated, in order; `["*"]` alone means every
 *  agent. Returns a reason string when the list is not valid. */
export function normalizeVisibleAgents(v: unknown): string[] | string {
  if (!Array.isArray(v)) return '"visibleAgents" must be an array of agent ids';
  const out: string[] = [];
  for (const raw of v as unknown[]) {
    if (typeof raw !== "string" || raw.trim() === "" || /[/\\\r\n]/.test(raw)) {
      return `"visibleAgents" has an invalid agent id ${JSON.stringify(raw)}`;
    }
    const id = raw.trim();
    if (!out.includes(id)) out.push(id);
  }
  if (out.includes("*") && out.length > 1) return '"*" (every agent) cannot be combined with agent ids';
  return out;
}

/** An absolute POSIX path with `.`, `..` and empty segments resolved (`..` stops at `/`). */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * A scope folder's path as stored (`project.addScopeFolder` / `removeScopeFolder`): workspace-relative
 * when it lies inside the workspace (`workspaceRoot`, absolute), absolute when outside it. Takes a
 * workspace-relative path or an absolute one; a relative path that climbs out of the workspace, a
 * `~` path, the workspace root itself and `/` are `invalid-params`; the workspace's `.pomade` folder
 * is `capability-denied`. Whether the folder exists does not matter.
 */
export function scopeFolderPath(raw: unknown, workspaceRoot: string): { ok: true; path: string } | { ok: false; error: ErrorPayload } {
  const invalid = (message: string): { ok: false; error: ErrorPayload } => ({ ok: false, error: { code: "invalid-params", message } });
  if (typeof raw !== "string") return invalid('"path" must be a string');
  if (raw.includes("\0")) return invalid('"path" must not contain NUL');
  if (raw.trim() === "") return invalid('"path" must not be empty');
  if (raw.startsWith("~")) return invalid(`${JSON.stringify(raw)}: give an absolute or a workspace-relative path`);
  let path: string;
  if (raw.startsWith("/")) {
    const abs = normalizeAbsolute(raw);
    const root = normalizeAbsolute(workspaceRoot);
    if (abs === "/") return invalid('"/" cannot be a scope folder');
    path = abs === root ? "" : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  } else {
    const rel = normalizeWorkspacePath(raw);
    if (!rel.ok) return invalid(`${JSON.stringify(raw)} climbs out of the workspace; give a folder outside it as an absolute path`);
    path = rel.path;
  }
  if (path === "") return invalid("The workspace root cannot be a scope folder");
  if (!path.startsWith("/") && isPomadeFolderPath(path)) {
    return { ok: false, error: { code: "capability-denied", message: pomadeFolderMessage(path) } };
  }
  return { ok: true, path };
}
