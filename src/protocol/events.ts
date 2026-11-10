// The event bus (HOST-API §4 `events`, pomade:E-031): platform event names and payloads, app
// event names, the manifest's `events` declarations and the payload rule — shared by Pomade and
// the fake host.

import { APP_ID_RE } from "./manifest.js";
import { isJsonValue } from "./state.js";
import type { JsonValue, ProjectRef } from "./types.js";

/** The events Pomade itself publishes, in the order they are documented. */
export const PLATFORM_EVENTS = [
  "pomade.ready",
  "project.created",
  "project.renamed",
  "project.opened",
  "project.changed",
  "agentTab.exited",
] as const;
export type PlatformEventName = (typeof PLATFORM_EVENTS)[number];

/** Why an agent process in a tab ended. `exit`: the agent quit on its own with status 0 (or was
 *  interrupted with Ctrl+C); `crash`: it ended with any other status, or the tab's shell died
 *  under it; `tab-closed`: the user closed the tab (or a bulk action closed it); `quit`: Pomade
 *  quit or closed the workspace. */
export type AgentExitReason = "exit" | "crash" | "tab-closed" | "quit";

export const AGENT_EXIT_REASONS: readonly AgentExitReason[] = ["exit", "crash", "tab-closed", "quit"];

/** `project.renamed` — a project's name or folder changed; its id stays. */
export interface ProjectRenamedPayload {
  project: ProjectRef;
  /** The project as it was before the change. */
  previous: ProjectRef;
}

/** `agentTab.exited` — an agent process in a Pomade tab ended, whatever ended it. */
export interface AgentTabExitedPayload {
  tabId: string;
  /** The project the tab belongs to (`"__workspace__"` for the Workspace scope). */
  projectId: string;
  /** The agent's roster id (`claude`, `codex`, a folder agent). */
  agentId: string;
  /** The session bound to the tab at that moment; `null` when none was bound yet. */
  sessionId: string | null;
  reason: AgentExitReason;
}

/** Platform event name → payload. */
export interface PlatformEvents {
  /** Pomade finished restoring the workspace's tabs. Sticky: a subscription made later gets it at once. */
  "pomade.ready": Record<string, never>;
  "project.created": ProjectRef;
  "project.renamed": ProjectRenamedPayload;
  /** A project (or the Workspace scope) became active for the first time since Pomade started. */
  "project.opened": ProjectRef;
  "project.changed": ProjectRef;
  "agentTab.exited": AgentTabExitedPayload;
}

/** An app's own event name: dot-separated lowerCamel words (`run.started`, `session.statusChanged`). */
export const EVENT_NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
export const EVENT_NAME_MAX_LENGTH = 64;
/** A published payload may take at most this many bytes as JSON (UTF-8). */
export const EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

export function isPlatformEventName(name: unknown): name is PlatformEventName {
  return typeof name === "string" && (PLATFORM_EVENTS as readonly string[]).includes(name);
}

/** True for an app's own event name (unqualified). */
export function isAppEventName(name: unknown): name is string {
  return typeof name === "string" && name.length <= EVENT_NAME_MAX_LENGTH && EVENT_NAME_RE.test(name);
}

/** An app event as the bus names it: `<appId>:<event>`. */
export function qualifiedEventName(appId: string, name: string): string {
  return `${appId}:${name}`;
}

/** Split a bus event name: a platform event, an app event (`<appId>:<event>`), or `null` when it is neither. */
export function parseBusEventName(
  name: unknown,
): { kind: "platform"; name: PlatformEventName } | { kind: "app"; appId: string; event: string } | null {
  if (isPlatformEventName(name)) return { kind: "platform", name };
  if (typeof name !== "string") return null;
  const colon = name.indexOf(":");
  if (colon === -1) return null;
  const appId = name.slice(0, colon);
  const event = name.slice(colon + 1);
  return APP_ID_RE.test(appId) && isAppEventName(event) ? { kind: "app", appId, event } : null;
}

/** True for any name the bus can carry: a platform event or a qualified app event. */
export function isBusEventName(name: unknown): name is string {
  return parseBusEventName(name) !== null;
}

/** Why `payload` cannot be published, or `null` when it can. */
export function checkEventPayload(payload: unknown): string | null {
  if (!isJsonValue(payload)) return '"payload" must be plain JSON (null, boolean, finite number, string, array, plain object)';
  if (new TextEncoder().encode(JSON.stringify(payload)).length > EVENT_PAYLOAD_MAX_BYTES) {
    return `"payload" must be at most ${EVENT_PAYLOAD_MAX_BYTES} bytes as JSON`;
  }
  return null;
}

/** A bus event delivered to a subscriber. */
export interface BusEvent {
  /** A platform event name or `<appId>:<event>`. */
  name: string;
  payload: JsonValue;
}

/** `events.subscribersChanged` — whether one of the app's own declared events now has subscribers. */
export interface SubscribersChangedPayload {
  /** The app's own event name (unqualified, as in its manifest). */
  name: string;
  subscribed: boolean;
}

// ── Methods ─────────────────────────────────────────────────────────────────

/** `events.publish` — one of the app's own declared events. */
export interface PublishParams {
  /** The event name as declared in the manifest's `events.publish` (unqualified). */
  name: string;
  /** Plain JSON, at most 64 KiB; default `null`. */
  payload?: JsonValue;
}

/** `events.subscribe` / `events.unsubscribe` — a platform event or `<appId>:<event>`. */
export interface SubscribeParams {
  name: string;
}

/** `events.hasSubscribers` — one of the app's own declared events (unqualified). */
export interface HasSubscribersParams {
  name: string;
}

export interface HasSubscribersResult {
  subscribed: boolean;
}

// ── Manifest `events` ───────────────────────────────────────────────────────

/** What an app publishes and listens to (manifest `events`, HOST-API §1). */
export interface ManifestEvents {
  /** The app's own event names (unqualified), unique. */
  publish: string[];
  /** Platform events and other apps' events (`<appId>:<event>`), unique. */
  subscribe: string[];
}

/** One invalid field, as the manifest parser reports it. */
interface FieldError {
  field: string;
  message: string;
}

function received(v: unknown): string {
  return v === undefined ? "(missing)" : `(got ${JSON.stringify(v)})`;
}

/** `events` (HOST-API §1): `{ publish?: string[], subscribe?: string[] }`. Errors name the entry by
 *  index (`"events.subscribe[1]"`); a repeated name is reported on the later entry. */
export function parseManifestEvents(raw: unknown, errors: FieldError[]): ManifestEvents {
  const out: ManifestEvents = { publish: [], subscribe: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ field: "events", message: `"events" must be an object with "publish" and/or "subscribe" ${received(raw)}` });
    return out;
  }
  const o = raw as Record<string, unknown>;
  const list = (key: "publish" | "subscribe", valid: (v: unknown) => boolean, rule: string): void => {
    const value = o[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push({ field: `events.${key}`, message: `"events.${key}" must be an array of event names ${received(value)}` });
      return;
    }
    (value as unknown[]).forEach((item, i) => {
      const at = `events.${key}[${i}]`;
      if (!valid(item)) {
        errors.push({ field: at, message: `"${at}" ${rule} ${received(item)}` });
      } else if (out[key].includes(item as string)) {
        errors.push({ field: at, message: `"${at}" repeats ${JSON.stringify(item)}` });
      } else {
        out[key].push(item as string);
      }
    });
  };
  list("publish", isAppEventName, `must be an event name matching ${EVENT_NAME_RE.source} (at most ${EVENT_NAME_MAX_LENGTH} characters)`);
  list("subscribe", isBusEventName, `must be a platform event (${PLATFORM_EVENTS.join(", ")}) or "<appId>:<event>"`);
  return out;
}

// ── Call checks, shared by every host ───────────────────────────────────────

/** A refused bus call: the code and a readable message. */
export interface EventCallError {
  code: "invalid-params" | "capability-denied";
  message: string;
}

/** Check `events.publish` params against the app's declarations; the payload defaults to `null`. */
export function checkPublish(
  declared: ManifestEvents | undefined,
  params: Record<string, unknown>,
): { ok: true; name: string; payload: JsonValue } | { ok: false; error: EventCallError } {
  const name = params.name;
  if (!isAppEventName(name)) {
    return { ok: false, error: { code: "invalid-params", message: `"name" must be one of the app's own event names (got ${JSON.stringify(name)})` } };
  }
  if (!declared?.publish.includes(name)) {
    return { ok: false, error: { code: "capability-denied", message: `"${name}" is not declared in the manifest's events.publish` } };
  }
  const payload = params.payload === undefined ? null : params.payload;
  const bad = checkEventPayload(payload);
  if (bad) return { ok: false, error: { code: "invalid-params", message: bad } };
  return { ok: true, name, payload: payload as JsonValue };
}

/** Check `events.subscribe` params: a bus event name the manifest's `events.subscribe` declares. */
export function checkSubscribe(
  declared: ManifestEvents | undefined,
  params: Record<string, unknown>,
): { ok: true; name: string } | { ok: false; error: EventCallError } {
  const name = params.name;
  if (!isBusEventName(name)) {
    return {
      ok: false,
      error: { code: "invalid-params", message: `"name" must be a platform event or "<appId>:<event>" (got ${JSON.stringify(name)})` },
    };
  }
  if (!declared?.subscribe.includes(name)) {
    return { ok: false, error: { code: "capability-denied", message: `"${name}" is not declared in the manifest's events.subscribe` } };
  }
  return { ok: true, name };
}

/** Check `events.unsubscribe` params: any string (an unknown or unsubscribed name is a no-op). */
export function checkUnsubscribe(params: Record<string, unknown>): { ok: true; name: string } | { ok: false; error: EventCallError } {
  return typeof params.name === "string"
    ? { ok: true, name: params.name }
    : { ok: false, error: { code: "invalid-params", message: '"name" must be a string' } };
}

/** Check `events.hasSubscribers` params: one of the app's own declared events. */
export function checkHasSubscribers(
  declared: ManifestEvents | undefined,
  params: Record<string, unknown>,
): { ok: true; name: string } | { ok: false; error: EventCallError } {
  const name = params.name;
  if (!isAppEventName(name)) {
    return { ok: false, error: { code: "invalid-params", message: `"name" must be one of the app's own event names (got ${JSON.stringify(name)})` } };
  }
  if (!declared?.publish.includes(name)) {
    return { ok: false, error: { code: "capability-denied", message: `"${name}" is not declared in the manifest's events.publish` } };
  }
  return { ok: true, name };
}
