// The fake host's call errors and params readers, shared by its method handlers.

import { isPomadeFolderPath, normalizeWorkspacePath, pomadeFolderMessage, type ErrorCode } from "../protocol/index.js";
import type { Workspace } from "./workspace.js";

export class CallError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Obj = Record<string, unknown>;

export function paramsObject(params: unknown): Obj {
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new CallError("invalid-params", "params must be an object");
  }
  return params as Obj;
}

export function stringParam(p: Obj, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new CallError("invalid-params", `"${key}" must be a string`);
  return v;
}

export function booleanParam(p: Obj, key: string): boolean {
  const v = p[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new CallError("invalid-params", `"${key}" must be a boolean`);
  return v;
}

/** A request path, normalized: `outside-workspace` for an escape, `capability-denied` at or inside
 *  the workspace's `.pomade` folder. */
export function requestPath(raw: string): string {
  const n = normalizeWorkspacePath(raw);
  if (!n.ok) throw new CallError("outside-workspace", `${JSON.stringify(raw)} is outside the workspace`);
  if (isPomadeFolderPath(n.path)) throw new CallError("capability-denied", pomadeFolderMessage(raw));
  return n.path;
}

/** A workspace path param, normalized by `requestPath`. */
export function pathParam(p: Obj, key: string): string {
  return requestPath(stringParam(p, key));
}

/** Refuse `path` when what it names — symlinks followed — is at or inside the workspace's `.pomade` folder. */
export function requireAllowedTarget(ws: Workspace, path: string): string {
  if (isPomadeFolderPath(ws.realPath(path))) throw new CallError("capability-denied", pomadeFolderMessage(path));
  return path;
}

/** A path param naming an entry below the workspace root (never the root itself). */
export function entryParam(p: Obj, key: string): string {
  const path = pathParam(p, key);
  if (path === "") throw new CallError("invalid-params", `"${key}" must name an entry inside the workspace, not its root`);
  return path;
}
