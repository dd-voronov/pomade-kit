// The broker (HOST-API §4 `apps`, pomade:E-028): an app offers an API — methods named in its
// manifest's `api` — and Pomade carries other apps' calls to it (`apps.call` → a `request` to the
// serving frame or backend → its `response`). The parameter rules, shared by Pomade and the fake host.

import type { ErrorPayload, JsonValue } from "./types.js";
import { isJsonValue } from "./state.js";

/** An API method name: `today`, `jobsForRepo`, `sessions.list`. */
export const API_METHOD_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;
export const API_METHOD_MAX_LENGTH = 64;

/** How long `apps.call` waits for the serving app by default, and the bounds of `timeoutMs`. */
export const APP_CALL_TIMEOUT_MS = 5000;
export const APP_CALL_TIMEOUT_MIN_MS = 100;
export const APP_CALL_TIMEOUT_MAX_MS = 60000;

/** `apps.call` params as the host validated them. */
export interface AppCallRequest {
  app: string;
  method: string;
  params: JsonValue;
  timeoutMs: number;
}

/** Validate `apps.call` params: `{ app, method, params?, timeoutMs? }`; `params` defaults to `{}`. */
export function parseAppCall(raw: unknown): { ok: true; call: AppCallRequest } | { ok: false; error: ErrorPayload } {
  const bad = (message: string) => ({ ok: false as const, error: { code: "invalid-params" as const, message } });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("params must be an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.app !== "string" || o.app === "") return bad('"app" must be an app id');
  if (typeof o.method !== "string" || o.method === "") return bad('"method" must be a method name');
  const params = o.params === undefined ? {} : o.params;
  if (!isJsonValue(params)) return bad('"params" must be plain JSON');
  const timeoutMs = o.timeoutMs === undefined ? APP_CALL_TIMEOUT_MS : o.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < APP_CALL_TIMEOUT_MIN_MS ||
    timeoutMs > APP_CALL_TIMEOUT_MAX_MS
  ) {
    return bad(`"timeoutMs" must be an integer from ${APP_CALL_TIMEOUT_MIN_MS} to ${APP_CALL_TIMEOUT_MAX_MS}`);
  }
  return { ok: true, call: { app: o.app, method: o.method, params, timeoutMs } };
}

/** The answer a caller gets when the target app is absent, does not answer, or cannot be called. */
export const brokerErrors = {
  notDeclared: (caller: string, target: string): ErrorPayload => ({
    code: "capability-denied",
    message: `"${target}" is not in the "calls" of ${caller}'s manifest`,
  }),
  notInstalled: (target: string): ErrorPayload => ({ code: "app-absent", message: `The app "${target}" is not installed` }),
  notRunning: (target: string): ErrorPayload => ({ code: "app-absent", message: `The app "${target}" is not running` }),
  unknownMethod: (target: string, method: string): ErrorPayload => ({
    code: "unknown-method",
    message: `The app "${target}" offers no method ${JSON.stringify(method)}`,
  }),
  timeout: (target: string, ms: number): ErrorPayload => ({
    code: "app-not-responding",
    message: `The app "${target}" did not answer within ${ms} ms`,
  }),
  gone: (target: string): ErrorPayload => ({ code: "app-not-responding", message: `The app "${target}" went away before answering` }),
  notJson: (target: string): ErrorPayload => ({ code: "app-error", message: `The app "${target}" answered with a value that is not plain JSON` }),
};
