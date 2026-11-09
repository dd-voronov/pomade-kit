import { describe, expect, it, vi } from "vitest";
import type { CallMessage, FileChange } from "../protocol/index.js";
import { createClient, HostError } from "./client.js";
import { mockTransport, PROJECT, WELCOME } from "./test-helpers.js";

function setup() {
  const mock = mockTransport();
  const onClose = vi.fn();
  const { hostApi, pomadeVersion, appId, surface, project } = WELCOME;
  const host = createClient(mock.transport, { hostApi, pomadeVersion, appId, surface, project }, onClose);
  const calls = () => mock.sent.filter((m): m is CallMessage => m.type === "call");
  const lastCall = () => {
    const c = calls().at(-1);
    if (!c) throw new Error("no call sent");
    return c;
  };
  const ok = (id: string, value: unknown) => mock.deliver({ channel: "pomade", type: "result", id, ok: true, value });
  const fail = (id: string, code: string, message = "boom") =>
    mock.deliver({ channel: "pomade", type: "result", id, ok: false, error: { code, message } });
  const changed = (watchId: string, changes: FileChange[]) =>
    mock.deliver({ channel: "pomade", type: "event", name: "files.changed", payload: { watchId, changes } });
  return { mock, host, onClose, calls, lastCall, ok, fail, changed };
}

describe("client calls", () => {
  it("sends typed calls with {} params for parameterless methods", async () => {
    const t = setup();
    const info = t.host.info();
    expect(t.lastCall()).toEqual({ channel: "pomade", type: "call", id: "1", method: "host.info", params: {} });
    t.ok("1", { pomadeVersion: "0.3.0", hostApi: 0, appId: "hello", surface: "tab" });
    expect(await info).toEqual({ pomadeVersion: "0.3.0", hostApi: 0, appId: "hello", surface: "tab" });

    const active = t.host.project.getActive();
    expect(t.lastCall()).toMatchObject({ id: "2", method: "project.getActive", params: {} });
    t.ok("2", PROJECT);
    expect(await active).toEqual(PROJECT);

    const folder = t.host.files.readFolder({ path: "docs", recursive: true, frontmatter: true });
    expect(t.lastCall()).toMatchObject({ id: "3", method: "files.readFolder", params: { path: "docs", recursive: true, frontmatter: true } });
    t.ok("3", { entries: [] });
    expect(await folder).toEqual({ entries: [] });
  });

  it("matches concurrent calls by id, whatever order the results come in", async () => {
    const t = setup();
    const a = t.host.files.readFolder({ path: "a" });
    const b = t.host.files.readFolder({ path: "b" });
    const c = t.host.project.getActive();
    const ids = t.calls().map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
    t.ok(ids[2] ?? "", PROJECT);
    t.fail(ids[0] ?? "", "not-found");
    t.ok(ids[1] ?? "", { entries: [{ path: "b/x" }] });
    await expect(a).rejects.toMatchObject({ code: "not-found" });
    expect(await b).toEqual({ entries: [{ path: "b/x" }] });
    expect(await c).toEqual(PROJECT);
  });

  it.each(["not-ready", "unknown-method", "capability-denied", "invalid-params", "outside-workspace", "not-found", "io-error"])(
    "an error result rejects with a HostError carrying %s",
    async (code) => {
      const t = setup();
      const p = t.host.files.readFolder({ path: "x" });
      t.fail("1", code, "the reason");
      const err: unknown = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostError);
      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ name: "HostError", code, message: "the reason" });
    },
  );

  it("ignores results for unknown ids, duplicates and malformed results", async () => {
    const t = setup();
    const p = t.host.project.getActive();
    t.ok("99", "wrong");
    t.mock.deliver({ channel: "pomade", type: "result", id: "1", ok: false, error: { code: "bogus", message: "" } });
    t.mock.deliver({ channel: "other", type: "result", id: "1", ok: true, value: "wrong" });
    t.ok("1", PROJECT);
    t.ok("1", "duplicate");
    expect(await p).toEqual(PROJECT);
  });
});

describe("project.onChange", () => {
  it("delivers project.changed to every listener until unsubscribed", () => {
    const t = setup();
    const a = vi.fn();
    const b = vi.fn();
    const offA = t.host.project.onChange(a);
    t.host.project.onChange(b);
    const next = { id: "p2", kind: "project", name: "Kit", root: "Projects/pomade-kit" };
    t.mock.deliver({ channel: "pomade", type: "event", name: "project.changed", payload: next });
    expect(a).toHaveBeenCalledWith(next);
    expect(b).toHaveBeenCalledWith(next);
    offA();
    t.mock.deliver({ channel: "pomade", type: "event", name: "project.changed", payload: PROJECT });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed project events", () => {
    const t = setup();
    const cb = vi.fn();
    t.host.project.onChange(cb);
    t.mock.deliver({ channel: "pomade", type: "event", name: "project.changed", payload: { id: 1 } });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("files.watch", () => {
  async function watching(t: ReturnType<typeof setup>, path: string) {
    const cb = vi.fn();
    const p = t.host.files.watch({ path, recursive: true }, cb);
    const call = t.lastCall();
    expect(call).toMatchObject({ method: "files.watch", params: { path, recursive: true } });
    t.ok(call.id, { watchId: `w-${path}` });
    return { cb, watch: await p };
  }

  it("routes files.changed by watchId", async () => {
    const t = setup();
    const a = await watching(t, "a");
    const b = await watching(t, "b");
    expect(a.watch.watchId).toBe("w-a");
    t.changed("w-a", [{ kind: "create", path: "a/1.md" }]);
    t.changed("w-b", [{ kind: "delete", path: "b/2.md" }, { kind: "rename", path: "b/3.md", oldPath: "b/2.md" }]);
    t.changed("w-unknown", [{ kind: "create", path: "z" }]);
    expect(a.cb.mock.calls).toEqual([[[{ kind: "create", path: "a/1.md" }]]]);
    expect(b.cb.mock.calls).toEqual([[[{ kind: "delete", path: "b/2.md" }, { kind: "rename", path: "b/3.md", oldPath: "b/2.md" }]]]);
  });

  it("routes a change that arrives right after the watch result, before the promise continuation", async () => {
    const t = setup();
    const cb = vi.fn();
    const p = t.host.files.watch({ path: "a" }, cb);
    t.ok(t.lastCall().id, { watchId: "w1" });
    t.changed("w1", [{ kind: "change", path: "a/x.md" }]);
    await p;
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("close stops delivery at once, unwatches on the host, and is idempotent", async () => {
    const t = setup();
    const a = await watching(t, "a");
    const closing = a.watch.close();
    t.changed("w-a", [{ kind: "create", path: "a/1.md" }]);
    expect(a.cb).not.toHaveBeenCalled();
    const unwatch = t.lastCall();
    expect(unwatch).toMatchObject({ method: "files.unwatch", params: { watchId: "w-a" } });
    t.ok(unwatch.id, {});
    await closing;
    await a.watch.close();
    expect(t.calls().filter((c) => c.method === "files.unwatch")).toHaveLength(1);
  });

  it("a refused watch rejects with HostError", async () => {
    const t = setup();
    const p = t.host.files.watch({ path: "../x" }, vi.fn());
    t.fail(t.lastCall().id, "outside-workspace");
    await expect(p).rejects.toMatchObject({ code: "outside-workspace" });
  });
});

describe("close", () => {
  it("rejects pending calls, stops events, detaches, runs onClose once", async () => {
    const t = setup();
    const cb = vi.fn();
    const proj = vi.fn();
    const w = t.host.files.watch({ path: "a" }, cb);
    t.ok("1", { watchId: "w1" });
    const watch = await w;
    t.host.project.onChange(proj);
    const pending = t.host.project.getActive();
    t.host.close();
    t.host.close();
    await expect(pending).rejects.toThrow("client is closed");
    t.changed("w1", [{ kind: "create", path: "a/x" }]);
    t.mock.deliver({ channel: "pomade", type: "event", name: "project.changed", payload: PROJECT });
    expect(cb).not.toHaveBeenCalled();
    expect(proj).not.toHaveBeenCalled();
    expect(t.mock.listenerCount()).toBe(0);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    await expect(t.host.info()).rejects.toThrow("client is closed");
    // A watch closed after the client sends nothing.
    const sent = t.mock.sent.length;
    await watch.close();
    expect(t.mock.sent).toHaveLength(sent);
  });
});
