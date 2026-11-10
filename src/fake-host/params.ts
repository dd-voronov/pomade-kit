// The fake host's call errors and params readers, shared by its method handlers.

import { normalizeWorkspacePath, type ErrorCode } from "../protocol/index.js";

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

/** A workspace path param, normalized (`outside-workspace` for an escape). */
export function pathParam(p: Obj, key: string): string {
  const raw = stringParam(p, key);
  const n = normalizeWorkspacePath(raw);
  if (!n.ok) throw new CallError("outside-workspace", `${JSON.stringify(raw)} is outside the workspace`);
  return n.path;
}

/** A path param naming an entry below the workspace root (never the root itself). */
export function entryParam(p: Obj, key: string): string {
  const path = pathParam(p, key);
  if (path === "") throw new CallError("invalid-params", `"${key}" must name an entry inside the workspace, not its root`);
  return path;
}
