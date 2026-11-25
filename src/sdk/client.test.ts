import { describe, expect, it, vi } from "vitest";
import type { CallMessage, FileChange } from "../protocol/index.js";
import { createClient, HostError } from "./client.js";
import { mockTransport, PROJECT, WELCOME } from "./test-helpers.js";

function setup() {
  const mock = mockTransport();
  const onClose = vi.fn();
  const { hostApi, pomadeVersion, appId, surface, route, project, theme } = WELCOME;
  const host = createClient(mock.transport, { hostApi, pomadeVersion, appId, surface, route, project, theme }, onClose);
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
    t.ok("1", { pomadeVersion: "0.3.0", hostApi: 0, appId: "hello", surface: "panel", icon: "board", route: "needs-you" });
    expect(await info).toEqual({ pomadeVersion: "0.3.0", hostApi: 0, appId: "hello", surface: "panel", icon: "board", route: "needs-you" });

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

describe("strip.setBadge", () => {
  it("sends the params as given and resolves with nothing", async () => {
    const t = setup();
    const done = t.host.strip.setBadge({ icon: "board", count: 3, urgent: true });
    expect(t.lastCall()).toEqual({
      channel: "pomade",
      type: "call",
      id: "1",
      method: "strip.setBadge",
      params: { icon: "board", count: 3, urgent: true },
    });
    t.ok("1", {});
    expect(await done).toBeUndefined();
  });

  it("a refused badge rejects with HostError", async () => {
    const t = setup();
    const done = t.host.strip.setBadge({ icon: "nope", count: 1 });
    t.fail("1", "invalid-params", 'No strip icon "nope" in the manifest');
    await expect(done).rejects.toMatchObject({ name: "HostError", code: "invalid-params" });
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

describe("state", () => {
  it("get sends the key and resolves the stored value; null when unset", async () => {
    const t = setup();
    const a = t.host.state.get<{ view: string }>("view.p1");
    expect(t.lastCall()).toMatchObject({ method: "state.get", params: { key: "view.p1" } });
    t.ok(t.lastCall().id, { value: { view: "board" } });
    expect(await a).toEqual({ view: "board" });
    const b = t.host.state.get("missing");
    t.ok(t.lastCall().id, { value: null });
    expect(await b).toBeNull();
  });

  it("set sends key and value and resolves void; a refusal rejects with HostError", async () => {
    const t = setup();
    const p = t.host.state.set("pins", ["a", "b"]);
    expect(t.lastCall()).toMatchObject({ method: "state.set", params: { key: "pins", value: ["a", "b"] } });
    t.ok(t.lastCall().id, {});
    expect(await p).toBeUndefined();
    const q = t.host.state.set("", 1);
    t.fail(t.lastCall().id, "invalid-params");
    await expect(q).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("onChange receives state.changed until unsubscribed", () => {
    const t = setup();
    const cb = vi.fn();
    const off = t.host.state.onChange(cb);
    t.mock.deliver({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "pins", value: ["a"] } });
    t.mock.deliver({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "pins", value: null } });
    off();
    t.mock.deliver({ channel: "pomade", type: "event", name: "state.changed", payload: { key: "pins", value: 1 } });
    expect(cb.mock.calls).toEqual([
      ["pins", ["a"]],
      ["pins", null],
    ]);
  });
});

describe("tabs.openApp and route changes", () => {
  it("openApp sends {} by default, or the route and project, and resolves void", async () => {
    const t = setup();
    const a = t.host.tabs.openApp();
    expect(t.lastCall()).toMatchObject({ method: "tabs.openApp", params: {} });
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
    const b = t.host.tabs.openApp({ route: "planner/today", projectId: "p1" });
    expect(t.lastCall()).toMatchObject({ method: "tabs.openApp", params: { route: "planner/today", projectId: "p1" } });
    t.fail(t.lastCall().id, "not-found");
    await expect(b).rejects.toMatchObject({ code: "not-found" });
  });

  it("openApp sends a keyed tab's key, title and kind as given", async () => {
    const t = setup();
    const a = t.host.tabs.openApp({ key: "output:r1", kind: "output", title: "Scraper · output", route: "output/r1", projectId: "p1" });
    expect(t.lastCall()).toMatchObject({
      method: "tabs.openApp",
      params: { key: "output:r1", kind: "output", title: "Scraper · output", route: "output/r1", projectId: "p1" },
    });
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
  });

  it("setRoute sends { route } and resolves void; a refusal rejects", async () => {
    const t = setup();
    const a = t.host.tabs.setRoute("");
    expect(t.lastCall()).toMatchObject({ method: "tabs.setRoute", params: { route: "" } });
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
    const b = t.host.tabs.setRoute("card/2");
    expect(t.lastCall()).toMatchObject({ method: "tabs.setRoute", params: { route: "card/2" } });
    t.fail(t.lastCall().id, "invalid-params");
    await expect(b).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("setTitle sends { title } and close sends {}; both resolve void, a refusal rejects", async () => {
    const t = setup();
    const a = t.host.tabs.setTitle("Deploy · output");
    expect(t.lastCall()).toMatchObject({ method: "tabs.setTitle", params: { title: "Deploy · output" } });
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
    const b = t.host.tabs.close();
    expect(t.lastCall()).toMatchObject({ method: "tabs.close", params: {} });
    t.fail(t.lastCall().id, "invalid-params");
    await expect(b).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("onRouteChange receives route.changed until unsubscribed; welcome keeps the first route", () => {
    const t = setup();
    const cb = vi.fn();
    const off = t.host.onRouteChange(cb);
    t.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "board" } });
    off();
    t.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "x" } });
    expect(cb.mock.calls).toEqual([["board"]]);
    expect(t.host.welcome.route).toBe("");
  });

  it("a route.changed that arrives before anyone listens reaches the first listener, the latest one only, once", () => {
    const t = setup();
    const route = (r: string) => t.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: r } });
    route("board");
    route("output/r42");
    const first = vi.fn();
    const off = t.host.onRouteChange(first);
    expect(first.mock.calls).toEqual([["output/r42"]]);
    const second = vi.fn();
    t.host.onRouteChange(second);
    expect(second).not.toHaveBeenCalled();
    route("x");
    expect(first.mock.calls).toEqual([["output/r42"], ["x"]]);
    expect(second.mock.calls).toEqual([["x"]]);
    off();
  });

  it("a route.changed heard while nobody listens after the last listener left is kept for the next one", () => {
    const t = setup();
    const off = t.host.onRouteChange(() => {});
    off();
    t.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "later" } });
    const next = vi.fn();
    t.host.onRouteChange(next);
    expect(next.mock.calls).toEqual([["later"]]);
  });

  it("the app's own tabs.setRoute drops an unheard route.changed; a closed client hands nothing", () => {
    const t = setup();
    t.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "board" } });
    void t.host.tabs.setRoute("card/7");
    const cb = vi.fn();
    t.host.onRouteChange(cb);
    expect(cb).not.toHaveBeenCalled();

    const u = setup();
    u.mock.deliver({ channel: "pomade", type: "event", name: "route.changed", payload: { route: "board" } });
    u.host.close();
    const late = vi.fn();
    u.host.onRouteChange(late);
    expect(late).not.toHaveBeenCalled();
  });
});

describe("overlay.close", () => {
  it("sends overlay.close with {} and resolves void; a refusal rejects", async () => {
    const t = setup();
    const p = t.host.overlay.close();
    expect(t.lastCall()).toMatchObject({ method: "overlay.close", params: {} });
    t.ok(t.lastCall().id, {});
    expect(await p).toBeUndefined();
    const q = t.host.overlay.close();
    t.fail(t.lastCall().id, "invalid-params");
    await expect(q).rejects.toMatchObject({ code: "invalid-params" });
  });
});

describe("overlay.resize", () => {
  it("sends { height } and resolves void; a refusal rejects", async () => {
    const t = setup();
    const p = t.host.overlay.resize({ height: 260 });
    expect(t.lastCall()).toMatchObject({ method: "overlay.resize", params: { height: 260 } });
    t.ok(t.lastCall().id, {});
    expect(await p).toBeUndefined();
    const q = t.host.overlay.resize({ height: 0 });
    t.fail(t.lastCall().id, "invalid-params");
    await expect(q).rejects.toMatchObject({ code: "invalid-params" });
  });
});

describe("overlay.open", () => {
  it("sends the route (default {}) and resolves void; a refusal rejects", async () => {
    const t = setup();
    const p = t.host.overlay.open({ route: "quick-add" });
    expect(t.lastCall()).toMatchObject({ method: "overlay.open", params: { route: "quick-add" } });
    t.ok(t.lastCall().id, {});
    expect(await p).toBeUndefined();
    const sized = t.host.overlay.open({ route: "quick-add", height: 260, anchor: "panel" });
    expect(t.lastCall()).toMatchObject({ method: "overlay.open", params: { route: "quick-add", height: 260, anchor: "panel" } });
    t.ok(t.lastCall().id, {});
    await sized;
    const q = t.host.overlay.open();
    expect(t.lastCall()).toMatchObject({ method: "overlay.open", params: {} });
    t.fail(t.lastCall().id, "invalid-params");
    await expect(q).rejects.toMatchObject({ code: "invalid-params" });
  });
});

describe("files.reveal", () => {
  it("reveal sends { path, projectId? } and resolves void; a refusal rejects", async () => {
    const t = setup();
    const a = t.host.files.reveal({ path: "Apps/runner/jobs" });
    expect(t.lastCall()).toMatchObject({ method: "files.reveal", params: { path: "Apps/runner/jobs" } });
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
    const b = t.host.files.reveal({ path: "x", projectId: "p1" });
    expect(t.lastCall()).toMatchObject({ method: "files.reveal", params: { path: "x", projectId: "p1" } });
    t.fail(t.lastCall().id, "not-found");
    await expect(b).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("git.reveal", () => {
  it("reveal sends { path, projectId? } and resolves void; a refusal rejects", async () => {
    const t = setup();
    const a = t.host.git.reveal("/ws/Projects/Pomade");
    expect(t.lastCall()).toMatchObject({ method: "git.reveal", params: { path: "/ws/Projects/Pomade" } });
    expect(t.lastCall().params).not.toHaveProperty("projectId");
    t.ok(t.lastCall().id, {});
    expect(await a).toBeUndefined();
    const b = t.host.git.reveal("/ws/x", "p1");
    expect(t.lastCall()).toMatchObject({ method: "git.reveal", params: { path: "/ws/x", projectId: "p1" } });
    t.fail(t.lastCall().id, "not-found");
    await expect(b).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("files.delete", () => {
  it("sends { paths } and resolves with the results list", async () => {
    const t = setup();
    const p = t.host.files.delete(["a.md", "b.md"]);
    expect(t.lastCall()).toMatchObject({ method: "files.delete", params: { paths: ["a.md", "b.md"] } });
    const results = [
      { path: "a.md", ok: true },
      { path: "b.md", ok: false, error: { code: "not-found", message: "gone" } },
    ];
    t.ok(t.lastCall().id, { results });
    expect(await p).toEqual(results);
  });
});

describe("git", () => {
  const repo = { name: "Pomade", root: "Projects/Pomade", absPath: "/ws/Projects/Pomade", remoteUrl: null, branch: "main", upstream: null, ahead: 0, behind: 0, hasCommits: true, changes: [] };
  const gitChanged = (t: ReturnType<typeof setup>, watchId: string) =>
    t.mock.deliver({ channel: "pomade", type: "event", name: "git.changed", payload: { watchId, repos: [repo] } });

  it("getState sends {} without params and the project scope with one", async () => {
    const t = setup();
    const all = t.host.git.getState();
    expect(t.lastCall()).toMatchObject({ method: "git.getState", params: {} });
    t.ok(t.lastCall().id, { repos: [repo] });
    expect(await all).toEqual({ repos: [repo] });
    void t.host.git.getState({ projectId: "p1" });
    expect(t.lastCall()).toMatchObject({ method: "git.getState", params: { projectId: "p1" } });
  });

  it("routes git.changed by watchId, apart from files.changed; close unwatches once", async () => {
    const t = setup();
    const cb = vi.fn();
    const files = vi.fn();
    const p = t.host.git.watch({ projectId: "p1" }, cb);
    expect(t.lastCall()).toMatchObject({ method: "git.watch", params: { projectId: "p1" } });
    t.ok(t.lastCall().id, { watchId: "g1" });
    // Delivered before the promise continuation, like files.watch.
    gitChanged(t, "g1");
    const watch = await p;
    const fp = t.host.files.watch({ path: "a" }, files);
    t.ok(t.lastCall().id, { watchId: "w1" });
    await fp;
    gitChanged(t, "w1");
    gitChanged(t, "nope");
    t.changed("g1", [{ kind: "create", path: "a" }]);
    expect(cb.mock.calls).toEqual([[[repo]]]);
    expect(files).not.toHaveBeenCalled();
    const closing = watch.close();
    gitChanged(t, "g1");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.lastCall()).toMatchObject({ method: "git.unwatch", params: { watchId: "g1" } });
    t.ok(t.lastCall().id, {});
    await closing;
    await watch.close();
    expect(t.calls().filter((c) => c.method === "git.unwatch")).toHaveLength(1);
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

describe("onClose", () => {
  it("runs once on close(); a listener added after close runs at once", () => {
    const t = setup();
    const a = vi.fn();
    const b = vi.fn();
    const off = t.host.onClose(b);
    t.host.onClose(a);
    off();
    t.host.close();
    t.host.close();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    const late = vi.fn();
    t.host.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("a channel that ends closes the client: pending calls reject, listeners run", async () => {
    const mock = mockTransport();
    let end: (() => void) | null = null;
    const transport = { ...mock.transport, onEnd: (cb: () => void) => ((end = cb), () => (end = null)) };
    const { hostApi, pomadeVersion, appId, route, project, theme } = WELCOME;
    const host = createClient(transport, { hostApi, pomadeVersion, appId, surface: "backend", route, project, theme });
    const closed = vi.fn();
    host.onClose(closed);
    const pending = host.info();
    end!();
    await expect(pending).rejects.toThrow(/client is closed/);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(end).toBeNull();
  });
});

describe("apps.call and api.serve", () => {
  it("apps.call sends app, method, params and timeout; resolves the value", async () => {
    const t = setup();
    const p = t.host.apps.call("pomade-agents", "sessions.last", { cwd: "/x" }, { timeoutMs: 1000 });
    expect(t.lastCall()).toMatchObject({ method: "apps.call", params: { app: "pomade-agents", method: "sessions.last", params: { cwd: "/x" }, timeoutMs: 1000 } });
    t.ok(t.lastCall().id, { id: "s1" });
    await expect(p).resolves.toEqual({ id: "s1" });
    const bare = t.host.apps.call("a1", "m");
    expect(t.lastCall().params).toEqual({ app: "a1", method: "m" });
    t.fail(t.lastCall().id, "app-absent", "not running");
    await expect(bare).rejects.toMatchObject({ code: "app-absent" });
  });

  it("serves requests with the registered handlers and answers by id", async () => {
    const t = setup();
    const served = t.host.api.serve({
      today: (params, ctx) => ({ params, from: ctx.from }),
      later: async () => {
        await Promise.resolve();
        return 7;
      },
      denied: () => {
        throw new HostError("not-found", "nothing");
      },
      broken: () => {
        throw new Error("kaput");
      },
    });
    expect(t.lastCall()).toMatchObject({ method: "api.serve", params: {} });
    t.ok(t.lastCall().id, { methods: ["today"] });
    await expect(served).resolves.toEqual({ methods: ["today"] });
    const req = (id: string, method: string) =>
      t.mock.deliver({ channel: "pomade", type: "request", id, from: "pomade-runner", method, params: { a: 1 } });
    req("q1", "today");
    req("q2", "later");
    req("q3", "denied");
    req("q4", "broken");
    req("q5", "missing");
    await new Promise((r) => setTimeout(r, 0));
    const responses = t.mock.sent.filter((m) => m.type === "response").sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(responses).toEqual([
      { channel: "pomade", type: "response", id: "q1", ok: true, value: { params: { a: 1 }, from: "pomade-runner" } },
      { channel: "pomade", type: "response", id: "q2", ok: true, value: 7 },
      { channel: "pomade", type: "response", id: "q3", ok: false, error: { code: "not-found", message: "nothing" } },
      { channel: "pomade", type: "response", id: "q4", ok: false, error: { code: "app-error", message: "kaput" } },
      { channel: "pomade", type: "response", id: "q5", ok: false, error: { code: "unknown-method", message: 'No handler for "missing"' } },
    ]);
  });

  it("a request before serve answers unknown-method", async () => {
    const t = setup();
    t.mock.deliver({ channel: "pomade", type: "request", id: "q1", from: "x1", method: "today", params: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.mock.sent.filter((m) => m.type === "response")).toEqual([
      { channel: "pomade", type: "response", id: "q1", ok: false, error: { code: "unknown-method", message: 'No handler for "today"' } },
    ]);
  });
});
