// Structural guards for messages crossing postMessage. Both sides parse what they receive and
// ignore anything that is not a well-formed protocol message (HOST-API §3).

import {
  CHANNEL,
  CLIENT_ROLES,
  ERROR_CODES,
  type ErrorCode,
  type ErrorPayload,
  type HelloMessage,
  type HostToAppMessage,
  type KeyMessage,
  type ProjectInfo,
  type ProjectRef,
  type FileChange,
  type SocketClient,
  type Surface,
} from "./types.js";
import { isJsonValue } from "./state.js";
import { isGitRepoState } from "./git.js";
import { AGENT_EXIT_REASONS, PROJECT_CHANGES, parseBusEventName, type AgentTabExitedPayload, type ProjectUpdatedPayload } from "./events.js";
import { checkSessionRef } from "./attach.js";
import { isAgentTabChanged, pickAgentTabInfo } from "./agent-tabs.js";

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
  return v === "tab" || v === "panel" || v === "overlay" || v === "backend" || v === "command";
}

function isSocketClient(v: unknown): v is SocketClient {
  return (
    isObj(v) &&
    typeof v.appId === "string" &&
    typeof v.key === "string" &&
    typeof v.role === "string" &&
    (CLIENT_ROLES as readonly string[]).includes(v.role)
  );
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isProjectInfo(v: unknown): v is ProjectInfo {
  if (!isProjectRef(v) || v.kind !== "project") return false;
  const o = v as unknown as Obj;
  return (o.groupId === null || typeof o.groupId === "string") && isStringArray(o.groupPath);
}

/** A well-formed `project.updated` payload: a project and at least one known change, each once. */
function isProjectUpdated(v: unknown): v is ProjectUpdatedPayload {
  return (
    isObj(v) &&
    isProjectInfo(v.project) &&
    Array.isArray(v.changes) &&
    v.changes.length > 0 &&
    new Set(v.changes).size === v.changes.length &&
    v.changes.every((c) => (PROJECT_CHANGES as readonly unknown[]).includes(c))
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

/** A response as the host receives it: the value is unchecked. */
export interface IncomingResponse {
  channel: typeof CHANNEL;
  type: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: ErrorPayload;
}

export type IncomingAppMessage = HelloMessage | IncomingCall | KeyMessage | IncomingResponse;

/** Host side: parse an app → host message, or `null` to ignore it. */
export function parseAppMessage(v: unknown): IncomingAppMessage | null {
  if (!isPomadeMessage(v)) return null;
  const m = v as unknown as Obj;
  switch (m.type) {
    case "hello": {
      if (typeof m.hostApi !== "number" || !Number.isInteger(m.hostApi)) return null;
      const hello: HelloMessage = { channel: CHANNEL, type: "hello", hostApi: m.hostApi };
      // A malformed identity is dropped here; the socket host then refuses the hello as unauthorized.
      if (isSocketClient(m.client)) hello.client = { appId: m.client.appId, key: m.client.key, role: m.client.role };
      return hello;
    }
    case "call":
      return typeof m.id === "string" && typeof m.method === "string"
        ? { channel: CHANNEL, type: "call", id: m.id, method: m.method, params: m.params }
        : null;
    case "response": {
      if (typeof m.id !== "string") return null;
      if (m.ok === true) return { channel: CHANNEL, type: "response", id: m.id, ok: true, value: m.value };
      if (m.ok === false && isObj(m.error) && isErrorCode(m.error.code) && typeof m.error.message === "string") {
        return { channel: CHANNEL, type: "response", id: m.id, ok: false, error: { code: m.error.code, message: m.error.message } };
      }
      return null;
    }
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
    case "request":
      return typeof m.id === "string" && typeof m.from === "string" && typeof m.method === "string" && isJsonValue(m.params)
        ? { channel: CHANNEL, type: "request", id: m.id, from: m.from, method: m.method, params: m.params }
        : null;
    case "reject":
      return (m.reason === "needs-newer-pomade" || m.reason === "app-too-old" || m.reason === "unauthorized") &&
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
      if (
        m.name === "git.changed" &&
        isObj(m.payload) &&
        typeof m.payload.watchId === "string" &&
        Array.isArray(m.payload.repos) &&
        m.payload.repos.every(isGitRepoState)
      ) {
        return { channel: CHANNEL, type: "event", name: "git.changed", payload: { watchId: m.payload.watchId, repos: m.payload.repos } };
      }
      return parseBusEvent(m.name, m.payload);
    default:
      return null;
  }
}

function isAgentTabExited(v: unknown): v is AgentTabExitedPayload {
  return (
    isObj(v) &&
    typeof v.tabId === "string" &&
    typeof v.projectId === "string" &&
    typeof v.agentId === "string" &&
    (v.sessionId === null || typeof v.sessionId === "string") &&
    (AGENT_EXIT_REASONS as readonly unknown[]).includes(v.reason)
  );
}

/** An event the bus carries (pomade:E-031): the platform's, checked by shape, another app's
 *  (`<appId>:<event>`, any JSON payload), or the publisher's `events.subscribersChanged`. */
function parseBusEvent(name: unknown, payload: unknown): HostToAppMessage | null {
  if (name === "events.subscribersChanged") {
    return isObj(payload) && typeof payload.name === "string" && typeof payload.subscribed === "boolean"
      ? { channel: CHANNEL, type: "event", name, payload: { name: payload.name, subscribed: payload.subscribed } }
      : null;
  }
  const bus = parseBusEventName(name);
  if (!bus) return null;
  if (bus.kind === "app") {
    return isJsonValue(payload) ? { channel: CHANNEL, type: "event", name: `${bus.appId}:${bus.event}`, payload } : null;
  }
  switch (bus.name) {
    case "pomade.ready":
      return isObj(payload) ? { channel: CHANNEL, type: "event", name: bus.name, payload: {} } : null;
    case "project.created":
    case "project.removed":
    case "project.opened":
      return isProjectRef(payload) ? { channel: CHANNEL, type: "event", name: bus.name, payload } : null;
    case "project.changed":
      return isProjectRef(payload) ? { channel: CHANNEL, type: "event", name: bus.name, payload } : null;
    case "project.renamed":
      return isObj(payload) && isProjectRef(payload.project) && isProjectRef(payload.previous)
        ? { channel: CHANNEL, type: "event", name: bus.name, payload: { project: payload.project, previous: payload.previous } }
        : null;
    case "project.updated": {
      if (!isProjectUpdated(payload)) return null;
      const { id, kind, name, root, groupId, groupPath } = payload.project;
      return {
        channel: CHANNEL,
        type: "event",
        name: bus.name,
        payload: { project: { id, kind, name, root, groupId, groupPath: [...groupPath] }, changes: [...payload.changes] },
      };
    }
    case "agentTab.exited":
      return isAgentTabExited(payload)
        ? {
            channel: CHANNEL,
            type: "event",
            name: bus.name,
            payload: {
              tabId: payload.tabId,
              projectId: payload.projectId,
              agentId: payload.agentId,
              sessionId: payload.sessionId,
              reason: payload.reason,
            },
          }
        : null;
    case "agentTab.changed":
      return isAgentTabChanged(payload)
        ? { channel: CHANNEL, type: "event", name: bus.name, payload: { tab: pickAgentTabInfo(payload.tab), changes: [...payload.changes] } }
        : null;
    case "attachedTab.action": {
      if (!isObj(payload) || typeof payload.action !== "string" || typeof payload.projectId !== "string") return null;
      const ref = checkSessionRef(payload.session);
      return ref.ok
        ? { channel: CHANNEL, type: "event", name: bus.name, payload: { session: ref.value, action: payload.action, projectId: payload.projectId } }
        : null;
    }
  }
}
