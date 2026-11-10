// Structural guards for messages crossing postMessage. Both sides parse what they receive and
// ignore anything that is not a well-formed protocol message (HOST-API §3).

import {
  CHANNEL,
  ERROR_CODES,
  type ErrorCode,
  type HelloMessage,
  type HostToAppMessage,
  type KeyMessage,
  type ProjectRef,
  type FileChange,
  type Surface,
} from "./types.js";
import { isJsonValue } from "./state.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for any object carrying `channel: "pomade"` and a string `type`. */
export function isPomadeMessage(v: unknown): v is { channel: typeof CHANNEL; type: string } {
  return isObj(v) && v.channel === CHANNEL && typeof v.type === "string";
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

export function isSurface(v: unknown): v is Surface {
  return v === "tab" || v === "panel" || v === "overlay";
}

export function isProjectRef(v: unknown): v is ProjectRef {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    (v.kind === "project" || v.kind === "workspace") &&
    typeof v.name === "string" &&
    typeof v.root === "string"
  );
}

export function isFileChange(v: unknown): v is FileChange {
  if (!isObj(v) || typeof v.path !== "string") return false;
  if (v.kind === "rename") return typeof v.oldPath === "string";
  return (v.kind === "create" || v.kind === "change" || v.kind === "delete") && v.oldPath === undefined;
}

/** A call as the host receives it: the method may be unknown and params are unchecked. */
export interface IncomingCall {
  channel: typeof CHANNEL;
  type: "call";
  id: string;
  method: string;
  params: unknown;
}

export type IncomingAppMessage = HelloMessage | IncomingCall | KeyMessage;

/** Host side: parse an app → host message, or `null` to ignore it. */
export function parseAppMessage(v: unknown): IncomingAppMessage | null {
  if (!isPomadeMessage(v)) return null;
  const m = v as unknown as Obj;
  switch (m.type) {
    case "hello":
      return typeof m.hostApi === "number" && Number.isInteger(m.hostApi)
        ? { channel: CHANNEL, type: "hello", hostApi: m.hostApi }
        : null;
    case "call":
      return typeof m.id === "string" && typeof m.method === "string"
        ? { channel: CHANNEL, type: "call", id: m.id, method: m.method, params: m.params }
        : null;
    case "key":
      return typeof m.key === "string" &&
        typeof m.code === "string" &&
        typeof m.metaKey === "boolean" &&
        typeof m.ctrlKey === "boolean" &&
        typeof m.altKey === "boolean" &&
        typeof m.shiftKey === "boolean"
        ? {
            channel: CHANNEL,
            type: "key",
            key: m.key,
            code: m.code,
            metaKey: m.metaKey,
            ctrlKey: m.ctrlKey,
            altKey: m.altKey,
            shiftKey: m.shiftKey,
          }
        : null;
    default:
      return null;
  }
}

/** App side: parse a host → app message, or `null` to ignore it. Unknown event names are ignored. */
export function parseHostMessage(v: unknown): HostToAppMessage | null {
  if (!isPomadeMessage(v)) return null;
  const m = v as unknown as Obj;
  switch (m.type) {
    case "welcome":
      return typeof m.hostApi === "number" &&
        typeof m.pomadeVersion === "string" &&
        typeof m.appId === "string" &&
        isSurface(m.surface) &&
        (m.icon === undefined || typeof m.icon === "string") &&
        typeof m.route === "string" &&
        isProjectRef(m.project)
        ? {
            channel: CHANNEL,
            type: "welcome",
            hostApi: m.hostApi,
            pomadeVersion: m.pomadeVersion,
            appId: m.appId,
            surface: m.surface,
            ...(typeof m.icon === "string" ? { icon: m.icon } : {}),
            route: m.route,
            project: m.project,
          }
        : null;
    case "reject":
      return (m.reason === "needs-newer-pomade" || m.reason === "app-too-old") &&
        typeof m.hostApi === "number"
        ? { channel: CHANNEL, type: "reject", reason: m.reason, hostApi: m.hostApi }
        : null;
    case "result": {
      if (typeof m.id !== "string") return null;
      if (m.ok === true) return { channel: CHANNEL, type: "result", id: m.id, ok: true, value: m.value };
      if (m.ok === false && isObj(m.error) && isErrorCode(m.error.code) && typeof m.error.message === "string") {
        return {
          channel: CHANNEL,
          type: "result",
          id: m.id,
          ok: false,
          error: { code: m.error.code, message: m.error.message },
        };
      }
      return null;
    }
    case "event":
      if (m.name === "project.changed" && isProjectRef(m.payload)) {
        return { channel: CHANNEL, type: "event", name: "project.changed", payload: m.payload };
      }
      if (
        m.name === "files.changed" &&
        isObj(m.payload) &&
        typeof m.payload.watchId === "string" &&
        Array.isArray(m.payload.changes) &&
        m.payload.changes.every(isFileChange)
      ) {
        return {
          channel: CHANNEL,
          type: "event",
          name: "files.changed",
          payload: { watchId: m.payload.watchId, changes: m.payload.changes },
        };
      }
      if (m.name === "state.changed" && isObj(m.payload) && typeof m.payload.key === "string" && isJsonValue(m.payload.value)) {
        return { channel: CHANNEL, type: "event", name: "state.changed", payload: { key: m.payload.key, value: m.payload.value } };
      }
      if (m.name === "route.changed" && isObj(m.payload) && typeof m.payload.route === "string") {
        return { channel: CHANNEL, type: "event", name: "route.changed", payload: { route: m.payload.route } };
      }
      return null;
    default:
      return null;
  }
}
