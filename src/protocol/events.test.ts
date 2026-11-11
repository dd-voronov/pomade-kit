import { describe, expect, it } from "vitest";
import {
  checkEventPayload,
  checkHasSubscribers,
  checkPublish,
  checkSubscribe,
  checkUnsubscribe,
  EVENT_PAYLOAD_MAX_BYTES,
  isAppEventName,
  isBusEventName,
  parseBusEventName,
  PLATFORM_EVENTS,
  qualifiedEventName,
  type ManifestEvents,
} from "./events.js";
import { parseHostMessage } from "./guards.js";
import { parseManifest } from "./manifest.js";

const BASE = { id: "pomade-runner", name: "Runner", version: "0.1.0", hostApi: 0, capabilities: [] };
const DECLARED: ManifestEvents = { publish: ["run.started", "run.finished"], subscribe: ["project.renamed", "pomade-agents:session.closed"] };

describe("event names", () => {
  it("platform events are the documented nine", () => {
    expect(PLATFORM_EVENTS).toEqual([
      "pomade.ready",
      "project.created",
      "project.renamed",
      "project.opened",
      "project.changed",
      "project.updated",
      "agentTab.exited",
      "agentTab.changed",
      "attachedTab.action",
    ]);
  });

  it.each([
    ["run.started", true],
    ["run", true],
    ["session.statusChanged", true],
    ["a1.b2", true],
    ["Run.started", false],
    ["run..started", false],
    ["run.", false],
    [".run", false],
    ["run-started", false],
    ["run:started", false],
    ["", false],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
  ])("app event name %j → %s", (name, ok) => {
    expect(isAppEventName(name)).toBe(ok);
  });

  it("splits bus names: platform, qualified app events, nothing else", () => {
    expect(parseBusEventName("project.renamed")).toEqual({ kind: "platform", name: "project.renamed" });
    expect(parseBusEventName("pomade-runner:run.finished")).toEqual({ kind: "app", appId: "pomade-runner", event: "run.finished" });
    expect(parseBusEventName(qualifiedEventName("hello", "pinged"))).toEqual({ kind: "app", appId: "hello", event: "pinged" });
    for (const bad of ["project.deleted", "run.finished", "Pomade:run", "x:run", "pomade-runner:", ":run", "a:b:c", 3, null]) {
      expect(parseBusEventName(bad)).toBeNull();
      expect(isBusEventName(bad)).toBe(false);
    }
  });
});

describe("payloads", () => {
  it("accepts plain JSON up to 64 KiB", () => {
    expect(checkEventPayload(null)).toBeNull();
    expect(checkEventPayload({ id: "r1", ok: true, steps: [1, 2] })).toBeNull();
    expect(checkEventPayload("é".repeat(EVENT_PAYLOAD_MAX_BYTES / 2))).toMatch(/at most 65536 bytes/);
    expect(checkEventPayload({ when: new Date(0) })).toMatch(/plain JSON/);
    expect(checkEventPayload(Number.NaN)).toMatch(/plain JSON/);
    expect(checkEventPayload(undefined)).toMatch(/plain JSON/);
  });
});

describe("manifest events", () => {
  it("parses publish and subscribe lists", () => {
    const r = parseManifest({ ...BASE, events: DECLARED });
    expect(r.ok && r.manifest.events).toEqual(DECLARED);
    expect(r.ok && r.unsupportedKeys).toEqual([]);
  });

  it("either list may be missing", () => {
    const r = parseManifest({ ...BASE, events: { subscribe: ["pomade.ready"] } });
    expect(r.ok && r.manifest.events).toEqual({ publish: [], subscribe: ["pomade.ready"] });
  });

  it("a manifest without events has none", () => {
    const r = parseManifest(BASE);
    expect(r.ok && r.manifest.events).toBeUndefined();
  });

  it("reports every invalid entry by index, and repeats on the later one", () => {
    const r = parseManifest({
      ...BASE,
      events: { publish: ["run.started", "Bad", "run.started"], subscribe: ["project.deleted", "pomade-agents:session.closed", 7] },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual(["events.publish[1]", "events.publish[2]", "events.subscribe[0]", "events.subscribe[2]"]);
    expect(r.errors[1]!.message).toBe('"events.publish[2]" repeats "run.started"');
    expect(r.errors[2]!.message).toContain('(got "project.deleted")');
  });

  it("rejects a non-object and non-array lists", () => {
    const bad = parseManifest({ ...BASE, events: ["run"] });
    expect(!bad.ok && bad.errors.map((e) => e.field)).toEqual(["events"]);
    const lists = parseManifest({ ...BASE, events: { publish: "run", subscribe: {} } });
    expect(!lists.ok && lists.errors.map((e) => e.field)).toEqual(["events.publish", "events.subscribe"]);
  });
});

describe("call checks", () => {
  it("publish: a declared own event, payload default null", () => {
    expect(checkPublish(DECLARED, { name: "run.started" })).toEqual({ ok: true, name: "run.started", payload: null });
    expect(checkPublish(DECLARED, { name: "run.finished", payload: { ok: true } })).toEqual({
      ok: true,
      name: "run.finished",
      payload: { ok: true },
    });
    expect(checkPublish(DECLARED, { name: "run.paused" })).toMatchObject({ ok: false, error: { code: "capability-denied" } });
    expect(checkPublish(undefined, { name: "run.started" })).toMatchObject({ ok: false, error: { code: "capability-denied" } });
    expect(checkPublish(DECLARED, { name: "pomade-runner:run.started" })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    expect(checkPublish(DECLARED, { name: "run.started", payload: () => 1 })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });

  it("subscribe: a declared bus event", () => {
    expect(checkSubscribe(DECLARED, { name: "project.renamed" })).toEqual({ ok: true, name: "project.renamed" });
    expect(checkSubscribe(DECLARED, { name: "pomade-agents:session.closed" })).toEqual({ ok: true, name: "pomade-agents:session.closed" });
    expect(checkSubscribe(DECLARED, { name: "pomade.ready" })).toMatchObject({ ok: false, error: { code: "capability-denied" } });
    expect(checkSubscribe(DECLARED, { name: "session.closed" })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    expect(checkSubscribe(DECLARED, {})).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });

  it("unsubscribe: any string", () => {
    expect(checkUnsubscribe({ name: "anything" })).toEqual({ ok: true, name: "anything" });
    expect(checkUnsubscribe({ name: 1 })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });

  it("hasSubscribers: a declared own event", () => {
    expect(checkHasSubscribers(DECLARED, { name: "run.finished" })).toEqual({ ok: true, name: "run.finished" });
    expect(checkHasSubscribers(DECLARED, { name: "run.paused" })).toMatchObject({ ok: false, error: { code: "capability-denied" } });
    expect(checkHasSubscribers(DECLARED, { name: "x:y" })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });
});

describe("bus events on the wire", () => {
  const ev = (name: string, payload: unknown) => parseHostMessage({ channel: "pomade", type: "event", name, payload });
  const project = { id: "p1", kind: "project", name: "Alpha", root: "Projects/alpha" };

  it("parses platform events by shape", () => {
    expect(ev("pomade.ready", {})).toMatchObject({ name: "pomade.ready", payload: {} });
    expect(ev("project.created", project)).toMatchObject({ name: "project.created", payload: project });
    expect(ev("project.opened", project)).toMatchObject({ name: "project.opened" });
    expect(ev("project.renamed", { project, previous: { ...project, name: "Old" } })).toMatchObject({
      payload: { project, previous: { ...project, name: "Old" } },
    });
    const info = { ...project, groupId: "g1", groupPath: ["Tools"] };
    expect(ev("project.updated", { project: info, changes: ["group", "agents"] })).toMatchObject({
      name: "project.updated",
      payload: { project: info, changes: ["group", "agents"] },
    });
    expect(ev("project.updated", { project: { ...info, groupId: null, groupPath: [], extra: 1 }, changes: ["settings"] })).toEqual({
      channel: "pomade",
      type: "event",
      name: "project.updated",
      payload: { project: { ...info, groupId: null, groupPath: [] }, changes: ["settings"] },
    });
    expect(ev("project.updated", { project: info, changes: [] })).toBeNull();
    expect(ev("project.updated", { project: info, changes: ["name"] })).toBeNull();
    expect(ev("project.updated", { project: info, changes: ["group", "group"] })).toBeNull();
    expect(ev("project.updated", { project, changes: ["group"] })).toBeNull();
    expect(ev("project.updated", { project: { ...info, kind: "workspace" }, changes: ["group"] })).toBeNull();
    const exited = { tabId: "t1", projectId: "p1", agentId: "claude", sessionId: null, reason: "tab-closed" };
    expect(ev("agentTab.exited", exited)).toMatchObject({ payload: exited });
    expect(ev("agentTab.exited", { ...exited, reason: "killed" })).toBeNull();
    expect(ev("project.created", { id: "p1" })).toBeNull();
    expect(ev("pomade.ready", null)).toBeNull();
  });

  it("parses another app's event with any JSON payload, and the publisher's subscriber news", () => {
    expect(ev("pomade-runner:run.finished", { ok: [1, "x"] })).toMatchObject({ name: "pomade-runner:run.finished", payload: { ok: [1, "x"] } });
    expect(ev("events.subscribersChanged", { name: "run.finished", subscribed: true })).toMatchObject({
      payload: { name: "run.finished", subscribed: true },
    });
    expect(ev("events.subscribersChanged", { name: "run.finished" })).toBeNull();
    expect(ev("pomade-runner:Bad", 1)).toBeNull();
    expect(ev("run.finished", 1)).toBeNull();
  });
});
