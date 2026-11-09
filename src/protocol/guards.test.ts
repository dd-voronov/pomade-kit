import { describe, expect, it } from "vitest";
import { isFileChange, isPomadeMessage, isProjectRef, parseAppMessage, parseHostMessage } from "./guards.js";
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

  it("ignores host messages, unknown types and foreign channels", () => {
    expect(parseAppMessage({ channel: "pomade", type: "welcome" })).toBeNull();
    expect(parseAppMessage({ channel: "pomade", type: "bogus" })).toBeNull();
    expect(parseAppMessage({ channel: "x", type: "hello", hostApi: 0 })).toBeNull();
    expect(parseAppMessage(undefined)).toBeNull();
  });
});

describe("parseHostMessage", () => {
  const welcome = { channel: "pomade", type: "welcome", hostApi: 0, pomadeVersion: "0.3.0", appId: "a1", surface: "tab", project };

  it("welcome", () => {
    expect(parseHostMessage(welcome)).toEqual(welcome);
    expect(parseHostMessage({ ...welcome, surface: "panel" })).toBeNull();
    expect(parseHostMessage({ ...welcome, project: { id: "x" } })).toBeNull();
    expect(parseHostMessage({ ...welcome, pomadeVersion: undefined })).toBeNull();
    expect(parseHostMessage({ ...welcome, appId: 1 })).toBeNull();
    expect(parseHostMessage({ ...welcome, hostApi: "0" })).toBeNull();
  });

  it("reject, both reasons", () => {
    for (const reason of ["needs-newer-pomade", "app-too-old"]) {
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
    });
    expect(METHOD_NAMES).toHaveLength(5);
  });
});
