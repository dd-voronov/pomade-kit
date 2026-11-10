// Validation and merging for the per-project data an app writes (pomade:E-030): its settings
// (plain JSON, size-capped) and the project's visible agents. Shared by Pomade and the fake host.

import { PROJECT_SETTINGS_MAX_BYTES, type JsonValue } from "./types.js";

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
