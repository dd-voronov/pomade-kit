// App state (HOST-API §4 `state`): the key and value rules `state.get` / `state.set` enforce,
// shared by Pomade and the fake host.

import type { JsonValue } from "./types.js";

/** A key is a non-empty string of at most this many UTF-16 code units. */
export const STATE_KEY_MAX_LENGTH = 200;
/** A value's JSON text may take at most this many bytes (UTF-8). */
export const STATE_VALUE_MAX_BYTES = 1024 * 1024;
/** Arrays and objects may nest at most this deep. */
export const STATE_VALUE_MAX_DEPTH = 64;

/** Why `key` is not a state key, or `null` when it is one. */
export function checkStateKey(key: unknown): string | null {
  if (typeof key !== "string" || key === "") return '"key" must be a non-empty string';
  if (key.length > STATE_KEY_MAX_LENGTH) return `"key" must be at most ${STATE_KEY_MAX_LENGTH} characters`;
  return null;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Where `v` stops being plain JSON (`""` = the value itself), or `null` when it is JSON. */
function nonJsonAt(v: unknown, path: string, depth: number, seen: Set<object>): string | null {
  if (v === null || typeof v === "boolean" || typeof v === "string") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : path;
  if (typeof v !== "object") return path;
  if (depth >= STATE_VALUE_MAX_DEPTH || seen.has(v)) return path;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const bad = nonJsonAt(v[i], `${path}[${i}]`, depth + 1, seen);
        if (bad !== null) return bad;
      }
      return null;
    }
    if (!isPlainObject(v)) return path;
    for (const [k, item] of Object.entries(v)) {
      const bad = nonJsonAt(item, `${path}.${k}`, depth + 1, seen);
      if (bad !== null) return bad;
    }
    return null;
  } finally {
    seen.delete(v);
  }
}

/** True for a plain JSON value: null, booleans, finite numbers, strings, arrays and plain objects of them. */
export function isJsonValue(v: unknown): v is JsonValue {
  return nonJsonAt(v, "", 0, new Set()) === null;
}

/** Why `value` cannot be stored, or `null` when it can. */
export function checkStateValue(value: unknown): string | null {
  if (value === undefined) return '"value" is required (null removes the key)';
  const bad = nonJsonAt(value, "", 0, new Set());
  if (bad !== null) {
    return `"value${bad}" is not plain JSON (null, boolean, finite number, string, array, plain object; nesting ≤ ${STATE_VALUE_MAX_DEPTH})`;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > STATE_VALUE_MAX_BYTES) {
    return `"value" must be at most ${STATE_VALUE_MAX_BYTES} bytes as JSON`;
  }
  return null;
}
