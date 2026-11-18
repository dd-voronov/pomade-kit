import { describe, expect, it } from "vitest";
import { isFileChange, isPomadeMessage, isProjectRef, isSurface, parseAppMessage, parseHostMessage } from "./guards.js";
import { ERROR_CODES, METHOD_CAPABILITY, METHOD_NAMES } from "./types.js";

const project = { id: "p1", kind: "project", name: "Pomade", root: "Projects/Pomade" } as const;

describe("isPomadeMessage", () => {
  it("needs channel 'pomade' and a string type", () => {
    expect(isPomadeMessage({ channel: "pomade", type: "hello" })).toBe(true);
    expect(isPomadeMessage({ channel: "other", type: "hello" })).toBe(false);
    expect(isPomadeMessage({ type: "hello" })).toBe(false);
    expect(isPomadeMessage({ channel: "pomade" })).toBe(false);
    expect(isPomadeMessage({ channel: "pomade", type: 1 })).toBe(false);
    expect(isPomadeMessage(null)).toBe(false);
    expect(isPomadeMessage("pomade")).toBe(false);
    expect(isPomadeMessage([])).toBe(false);
  });
});

describe("isSurface", () => {
  it.each<[unknown, boolean]>([
    ["tab", true],
    ["panel", true],
    ["overlay", true],
    ["Tab", false],
    ["both", false],
    ["", false],
    [undefined, false],
    [null, false],
  ])("%j → %s", (v, expected) => {
    expect(isSurface(v)).toBe(expected);
  });
});

describe("isProjectRef / isFileChange", () => {
  it("project refs", () => {
    expect(isProjectRef(project)).toBe(true);
    expect(isProjectRef({ id: "workspace", kind: "workspace", name: "Workspace", root: "" })).toBe(true);
    expect(isProjectRef({ ...project, kind: "folder" })).toBe(false);
    expect(isProjectRef({ ...project, root: undefined })).toBe(false);
  });
  it("file changes", () => {
    expect(isFileChange({ kind: "create", path: "a" })).toBe(true);
    expect(isFileChange({ kind: "change", path: "a" })).toBe(true);
    expect(isFileChange({ kind: "delete", path: "a" })).toBe(true);
    expect(isFileChange({ kind: "rename", path: "b", oldPath: "a" })).toBe(true);
    expect(isFileChange({ kind: "rename", path: "b" })).toBe(false);
    expect(isFileChange({ kind: "create", path: "b", oldPath: "a" })).toBe(false);
    expect(isFileChange({ kind: "move", path: "a" })).toBe(false);
    expect(isFileChange({ kind: "create" })).toBe(false);
  });
});

describe("parseAppMessage", () => {
  it("hello", () => {
    expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: 0 })).toEqual({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(parseAppMessage({ channel: "pomade", type: "hello" })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: "0" })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: 0.5 })).toBeNull();
  });

  it("hello over the socket carries the client's identity; a malformed one is dropped", () => {
    const client = { appId: "pomade-agents", key: "k1", role: "backend" };
    expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: 0, client: { ...client, extra: 1 } })).toEqual({
      channel: "pomade",
      type: "hello",
      hostApi: 0,
      client,
    });
    expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: 0, client: { ...client, role: "command" } })).toEqual({
      channel: "pomade",
      type: "hello",
      hostApi: 0,
      client: { ...client, role: "command" },
    });
    for (const bad of [{ ...client, role: "tab" }, { ...client, key: 1 }, { appId: "a", role: "backend" }, "x", null]) {
      expect(parseAppMessage({ channel: "pomade", type: "hello", hostApi: 0, client: bad })).toEqual({ channel: "pomade", type: "hello", hostApi: 0 });
    }
  });

  it("call keeps any method name and unchecked params; drops extra fields", () => {
    expect(parseAppMessage({ channel: "pomade", type: "call", id: "1", method: "nope", params: 5, extra: true })).toEqual({
      channel: "pomade",
      type: "call",
      id: "1",
      method: "nope",
      params: 5,
    });
    expect(parseAppMessage({ channel: "pomade", type: "call", id: 1, method: "host.info" })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "call", id: "1" })).toBeNull();
  });

  it("key", () => {
    const key = { channel: "pomade", type: "key", key: "w", code: "KeyW", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(parseAppMessage(key)).toEqual(key);
    expect(parseAppMessage({ ...key, metaKey: "yes" })).toBeNull();
    expect(parseAppMessage({ ...key, code: undefined })).toBeNull();
  });

  it("response: ok with any value, or a well-formed error", () => {
    expect(parseAppMessage({ channel: "pomade", type: "response", id: "r1", ok: true, value: { n: 1 } })).toEqual({
      channel: "pomade",
      type: "response",
      id: "r1",
      ok: true,
      value: { n: 1 },
    });
    const error = { code: "app-error", message: "boom" };
    expect(parseAppMessage({ channel: "pomade", type: "response", id: "r1", ok: false, error, x: 1 })).toEqual({
      channel: "pomade",
      type: "response",
      id: "r1",
      ok: false,
      error,
    });
    expect(parseAppMessage({ channel: "pomade", type: "response", ok: true })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "response", id: "r1", ok: false, error: { code: "nope", message: "" } })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "response", id: "r1" })).toBeNull();
  });

  it("ignores host messages, unknown types and foreign channels", () => {
    expect(parseAppMessage({ channel: "pomade", type: "welcome" })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "bogus" })).toBeNull();
    expect(parseAppMessage({ channel: "x", type: "hello", hostApi: 0 })).toBeNull();
    expect(parseAppMessage(undefined)).toBeNull();
  });
});

describe("parseHostMessage", () => {
  const welcome = { channel: "pomade", type: "welcome", hostApi: 0, pomadeVersion: "0.3.0", appId: "a1", surface: "tab", route: "", project };

  it("welcome", () => {
    expect(parseHostMessage(welcome)).toEqual(welcome);
    const panel = { ...welcome, surface: "panel", icon: "board", route: "needs-you" };
    expect(parseHostMessage(panel)).toEqual(panel);
    expect(parseHostMessage({ ...welcome, icon: "board", route: "board" })).toEqual({ ...welcome, icon: "board", route: "board" });
    expect(parseHostMessage({ ...welcome, extra: 1 })).toEqual(welcome);
    expect(parseHostMessage({ ...welcome, surface: "backend" })).toEqual({ ...welcome, surface: "backend" });
    expect(parseHostMessage({ ...welcome, surface: "command" })).toEqual({ ...welcome, surface: "command" });
    expect(parseHostMessage({ ...welcome, surface: "popup" })).toBeNull();
    expect(parseHostMessage({ ...welcome, surface: undefined })).toBeNull();
    expect(parseHostMessage({ ...welcome, route: undefined })).toBeNull();
    expect(parseHostMessage({ ...welcome, route: 1 })).toBeNull();
    expect(parseHostMessage({ ...welcome, icon: 1 })).toBeNull();
    expect(parseHostMessage({ ...welcome, icon: null })).toBeNull();
    expect(parseHostMessage({ ...welcome, project: { id: "x" } })).toBeNull();
    expect(parseHostMessage({ ...welcome, pomadeVersion: undefined })).toBeNull();
    expect(parseHostMessage({ ...welcome, appId: 1 })).toBeNull();
    expect(parseHostMessage({ ...welcome, hostApi: "0" })).toBeNull();
  });

  it("reject, every reason", () => {
    for (const reason of ["needs-newer-pomade", "app-too-old", "unauthorized"]) {
      expect(parseHostMessage({ channel: "pomade", type: "reject", reason, hostApi: 1 })).toEqual({ channel: "pomade", type: "reject", reason, hostApi: 1 });
    }
    expect(parseHostMessage({ channel: "pomade", type: "reject", reason: "nope", hostApi: 1 })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "reject", reason: "app-too-old" })).toBeNull();
  });

  it("result ok and error", () => {
    expect(parseHostMessage({ channel: "pomade", type: "result", id: "1", ok: true, value: { a: 1 } })).toEqual({
      channel: "pomade",
      type: "result",
      id: "1",
      ok: true,
      value: { a: 1 },
    });
    for (const code of ERROR_CODES) {
      expect(parseHostMessage({ channel: "pomade", type: "result", id: "2", ok: false, error: { code, message: "m" } })).toEqual({
        channel: "pomade",
        type: "result",
        id: "2",
        ok: false,
        error: { code, message: "m" },
      });
    }
    expect(parseHostMessage({ channel: "pomade", type: "result", id: "2", ok: false, error: { code: "weird", message: "m" } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "result", id: "2", ok: false })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "result", id: 2, ok: true })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "result", id: "2" })).toBeNull();
  });

  it("events", () => {
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "project.changed", payload: project })).toEqual({
      channel: "pomade",
      type: "event",
      name: "project.changed",
      payload: project,
    });
    const files = { watchId: "w1", changes: [{ kind: "rename", path: "b", oldPath: "a" }] };
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "files.changed", payload: files })).toEqual({
      channel: "pomade",
      type: "event",
      name: "files.changed",
      payload: files,
    });
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "files.changed", payload: { watchId: "w1", changes: [{ kind: "x", path: "a" }] } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "project.changed", payload: {} })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "future.event", payload: {} })).toBeNull();
  });

  it("route.changed carries the new route", () => {
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "planner/today", x: 1 } })).toEqual({
      channel: "pomade",
      type: "event",
      name: "route.changed",
      payload: { route: "planner/today" },
    });
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "route.changed", payload: { route: 1 } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "route.changed", payload: {} })).toBeNull();
  });

  it("state.changed carries a key and a JSON value (null = removed)", () => {
    for (const value of [null, 1, "x", [1, { a: true }], { pins: ["a"] }]) {
      expect(parseHostMessage({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "k", value } })).toEqual({
        channel: "pomade",
        type: "event",
        name: "state.changed",
        payload: { key: "k", value },
      });
    }
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "state.changed", payload: { key: 1, value: 1 } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "k" } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "k", value: new Date(0) } })).toBeNull();
  });

  it("request carries the caller, the method and JSON params", () => {
    const req = { channel: "pomade", type: "request", id: "q1", from: "pomade-runner", method: "sessions.last", params: { cwd: "/x" } };
    expect(parseHostMessage({ ...req, extra: 1 })).toEqual(req);
    expect(parseHostMessage({ ...req, params: undefined })).toBeNull();
    expect(parseHostMessage({ ...req, from: 1 })).toBeNull();
    expect(parseHostMessage({ ...req, method: undefined })).toBeNull();
  });

  it("ignores app messages and foreign data", () => {
    expect(parseHostMessage({ channel: "pomade", type: "hello", hostApi: 0 })).toBeNull();
    expect(parseHostMessage({ channel: "vite", type: "welcome" })).toBeNull();
    expect(parseHostMessage("welcome")).toBeNull();
  });
});

describe("METHOD_CAPABILITY", () => {
  it("maps every v0 method to its group", () => {
    expect(METHOD_CAPABILITY).toEqual({
      "host.info": null,
      "project.getActive": "project.read",
      "files.readFolder": "files.read",
      "files.watch": "files.read",
      "files.unwatch": "files.read",
      "strip.setBadge": null,
      "files.readFile": "files.read",
      "files.create": "files.write",
      "files.write": "files.write",
      "files.setBody": "files.write",
      "files.setField": "files.write",
      "files.removeField": "files.write",
      "files.setKeyLines": "files.write",
      "files.move": "files.write",
      "files.delete": "files.write",
      "tabs.openFile": "tabs.open",
      "tabs.openTerminal": "tabs.open",
      "tabs.openAttached": "tabs.open",
      "project.list": "project.read",
      "project.getSettings": "project.read",
      "project.setSettings": "project.write",
      "project.getAgents": "project.read",
      "project.setAgents": "project.write",
      "files.symlink": "files.symlink",
      "files.removeSymlink": "files.symlink",
      "files.pickFolder": "files.read",
      "state.get": null,
      "state.set": null,
      "tabs.openApp": null,
      "overlay.open": null,
      "overlay.resize": null,
      "overlay.close": null,
      "git.getState": "git.read",
      "git.watch": "git.read",
      "git.unwatch": "git.read",
      "events.publish": null,
      "events.subscribe": null,
      "events.unsubscribe": null,
      "events.hasSubscribers": null,
      "notices.post": null,
      "apps.call": null,
      "api.serve": null,
      "agents.liveIn": "platform",
      "agentTabs.list": "agentTabs.read",
      "agentTabs.setTitle": "agentTabs.write",
      "agentTabs.focus": "tabs.open",
      "agentTabs.launch": "tabs.open",
      "agentTabs.resume": "tabs.open",
    });
    expect(METHOD_NAMES).toEqual(Object.keys(METHOD_CAPABILITY));
  });
});
