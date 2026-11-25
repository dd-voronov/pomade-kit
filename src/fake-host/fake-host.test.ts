import { describe, expect, it, vi } from "vitest";
import type { FileChange, HostToAppMessage, ProjectRef } from "../protocol/index.js";
import { connect, type HostClient } from "../sdk/index.js";
import { createFakeHost, FakeHost, WORKSPACE_SCOPE, type FakeHostOptions } from "./fake-host.js";

const PROJECTS = [
  { id: "pomade", name: "Pomade", root: "Projects/Pomade" },
  { id: "kit", name: "pomade-kit", root: "Projects/pomade-kit/" },
];

const FILES = {
  "Projects/Pomade/docs/roadmap/E-001-a.md": "---\nid: E-001\nstatus: done\ncreated: 2026-11-09\n---\n\n# A\n",
  "Projects/Pomade/docs/roadmap/T-002-b.md": "---\nid: [broken\n---\n",
  "Projects/Pomade/docs/roadmap/notes.md": "no frontmatter\n",
  "Projects/Pomade/docs/roadmap/data.json": "---\na: 1\n---\n",
  "Projects/Pomade/docs/roadmap/done/E-000-old.markdown": "---\nid: E-000\n---\n",
  "Projects/Pomade/docs/roadmap/.git/HEAD": "ref",
  "Projects/Pomade/docs/roadmap/node_modules/x/index.md": "---\na: 1\n---\n",
  "Projects/Pomade/README.md": "é",
};

let clock = 1000;
function fake(options: FakeHostOptions = {}): FakeHost {
  clock = 1000;
  return createFakeHost({ files: FILES, projects: PROJECTS, now: () => clock, ...options });
}

/** A frame driven with raw protocol messages; host replies land in `got` synchronously. */
function raw(host: FakeHost) {
  const got: HostToAppMessage[] = [];
  const frame = host.attach((m) => got.push(m));
  let id = 0;
  const send = (m: unknown) => frame.receive(m);
  const hello = (hostApi = 0) => send({ channel: "pomade", type: "hello", hostApi });
  const call = (method: string, params?: unknown) => {
    const callId = String(++id);
    send({ channel: "pomade", type: "call", id: callId, method, params });
    const reply = [...got].reverse().find((m) => m.type === "result" && m.id === callId);
    if (!reply || reply.type !== "result") throw new Error(`no result for ${method}`);
    return reply;
  };
  const errorOf = (method: string, params?: unknown) => {
    const r = call(method, params);
    return r.ok ? null : r.error.code;
  };
  const events = () => got.filter((m) => m.type === "event");
  return { got, frame, send, hello, call, errorOf, events };
}

async function client(host: FakeHost): Promise<HostClient> {
  const r = await connect({ transport: host.createTransport(), keySource: null });
  if (r.status !== "connected") throw new Error(`not connected: ${r.status}`);
  return r.host;
}

/** Wait until the in-memory transport has delivered everything queued. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("handshake", () => {
  it("welcome carries version, app id (from the manifest), surface and the active project", () => {
    const host = fake({ activeProject: "pomade", pomadeVersion: "0.3.0", manifest: { id: "pomade-planner", name: "P", version: "0.1.0", hostApi: 0, capabilities: [] } });
    const f = raw(host);
    f.hello();
    expect(f.got).toEqual([
      {
        channel: "pomade",
        type: "welcome",
        hostApi: 0,
        pomadeVersion: "0.3.0",
        appId: "pomade-planner",
        surface: "tab",
        route: "",
        project: { id: "pomade", kind: "project", name: "Pomade", root: "Projects/Pomade" },
        theme: "light",
      },
    ]);
  });

  it("welcome carries the theme (default light); setTheme reaches every frame unsubscribed, once per change", () => {
    const host = fake({ theme: "dark" });
    const a = raw(host);
    const b = raw(host);
    a.hello();
    b.hello();
    expect(a.got[0]).toMatchObject({ type: "welcome", theme: "dark" });
    expect(host.theme).toBe("dark");
    host.setTheme("dark");
    host.setTheme("light");
    for (const f of [a, b]) expect(f.events()).toEqual([{ channel: "pomade", type: "event", name: "theme.changed", payload: { theme: "light" } }]);
    expect(host.theme).toBe("light");
    const later = raw(host);
    later.hello();
    expect(later.got[0]).toMatchObject({ type: "welcome", theme: "light" });
    const plain = raw(fake());
    plain.hello();
    expect(plain.got[0]).toMatchObject({ type: "welcome", theme: "light" });
  });

  it("an app speaking a newer Host API → reject needs-newer-pomade", () => {
    const f = raw(fake());
    f.hello(1);
    expect(f.got).toEqual([{ channel: "pomade", type: "reject", reason: "needs-newer-pomade", hostApi: 0 }]);
  });

  it("an app speaking an older Host API → reject app-too-old", () => {
    const f = raw(fake({ hostApi: 1 }));
    f.hello(0);
    expect(f.got).toEqual([{ channel: "pomade", type: "reject", reason: "app-too-old", hostApi: 1 }]);
  });

  it("the SDK sees each outcome as its typed result", async () => {
    expect((await connect({ transport: fake().transport, keySource: null })).status).toBe("connected");
    expect(await connect({ transport: fake({ hostApi: 1 }).transport, keySource: null })).toEqual({
      status: "rejected",
      reason: "app-too-old",
      hostApi: 1,
    });
  });

  it("calls before welcome, or after a reject, are not-ready", () => {
    const f = raw(fake());
    expect(f.errorOf("host.info")).toBe("not-ready");
    f.hello(7);
    expect(f.errorOf("host.info")).toBe("not-ready");
    f.hello(0);
    expect(f.errorOf("host.info")).toBeNull();
  });

  it("a new hello (frame reload) drops the frame's watches", () => {
    const host = fake();
    const f = raw(host);
    f.hello();
    f.call("files.watch", { path: "", recursive: true });
    f.hello();
    host.writeFile("x.md", "");
    expect(f.events()).toEqual([]);
  });

  it("ignores foreign and malformed messages", () => {
    const f = raw(fake());
    f.send({ channel: "other", type: "hello", hostApi: 0 });
    f.send({ channel: "pomade", type: "hello", hostApi: "0" });
    f.send({ channel: "pomade", type: "call", id: 1, method: "host.info" });
    f.send({ channel: "pomade", type: "welcome" });
    f.send("hello");
    f.send(null);
    expect(f.got).toEqual([]);
  });

  it("records forwarded keys", () => {
    const host = fake();
    const f = raw(host);
    const key = { channel: "pomade", type: "key", key: "w", code: "KeyW", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    f.send(key);
    expect(host.keys).toEqual([key]);
    expect(f.got).toEqual([]);
  });

  it("a detached frame gets nothing and is no longer answered", () => {
    const host = fake();
    const f = raw(host);
    f.hello();
    f.call("files.watch", { path: "" , recursive: true });
    f.frame.detach();
    const before = f.got.length;
    host.writeFile("x.md", "");
    host.setActiveProject("kit");
    f.hello();
    expect(f.got).toHaveLength(before);
  });
});

describe("calls — errors", () => {
  function welcomed(options?: FakeHostOptions) {
    const f = raw(fake(options));
    f.hello();
    return f;
  }

  it("unknown-method", () => {
    const f = welcomed();
    expect(f.errorOf("files.erase", { path: "x" })).toBe("unknown-method");
    expect(f.errorOf("toString")).toBe("unknown-method");
    expect(f.errorOf("constructor")).toBe("unknown-method");
  });

  it("capability-denied for methods outside the manifest; host.info needs none", () => {
    const projectOnly = welcomed({ manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: ["project.read"] } });
    expect(projectOnly.errorOf("host.info")).toBeNull();
    expect(projectOnly.errorOf("project.getActive")).toBeNull();
    for (const m of ["files.readFolder", "files.watch", "files.unwatch"]) {
      expect(projectOnly.errorOf(m, { path: "", watchId: "w1" })).toBe("capability-denied");
    }
    const none = welcomed({ manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [] } });
    expect(none.errorOf("project.getActive")).toBe("capability-denied");
    const filesOnly = welcomed({ manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: ["files.read"] } });
    expect(filesOnly.errorOf("project.getActive")).toBe("capability-denied");
    expect(filesOnly.errorOf("files.readFolder", { path: "" })).toBeNull();
  });

  it("capability is checked before params", () => {
    const f = welcomed({ manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [] } });
    expect(f.errorOf("files.readFolder", 5)).toBe("capability-denied");
  });

  it.each<[string, unknown]>([
    ["files.readFolder", undefined],
    ["files.readFolder", 5],
    ["files.readFolder", null],
    ["files.readFolder", ["docs"]],
    ["files.readFolder", {}],
    ["files.readFolder", { path: 1 }],
    ["files.readFolder", { path: "", recursive: "yes" }],
    ["files.readFolder", { path: "", frontmatter: 1 }],
    ["files.watch", {}],
    ["files.watch", { path: "", recursive: null }],
    ["files.unwatch", {}],
    ["files.unwatch", { watchId: 3 }],
    ["host.info", "x"],
    ["project.getActive", []],
  ])("invalid-params: %s %j", (method, params) => {
    expect(welcomed().errorOf(method, params)).toBe("invalid-params");
  });

  it("parameterless methods accept {} or no params", () => {
    const f = welcomed();
    expect(f.errorOf("host.info")).toBeNull();
    expect(f.errorOf("host.info", {})).toBeNull();
    expect(f.errorOf("project.getActive", { extra: 1 })).toBeNull();
  });

  it.each(["/", "/etc", "..", "../x", "Projects/../../x"])("outside-workspace: %j", (path) => {
    const f = welcomed();
    expect(f.errorOf("files.readFolder", { path })).toBe("outside-workspace");
    expect(f.errorOf("files.watch", { path })).toBe("outside-workspace");
  });

  it("not-found for a missing path", () => {
    const f = welcomed();
    expect(f.errorOf("files.readFolder", { path: "nope" })).toBe("not-found");
    expect(f.errorOf("files.watch", { path: "Projects/nope" })).toBe("not-found");
  });

  it("io-error when reading a file as a folder", () => {
    const f = welcomed();
    const r = f.call("files.readFolder", { path: "Projects/Pomade/README.md" });
    expect(r).toMatchObject({ ok: false, error: { code: "io-error" } });
    expect(!r.ok && r.error.message).toMatch(/ENOTDIR/);
  });

  it("unwatch of an unknown id succeeds", () => {
    expect(welcomed().call("files.unwatch", { watchId: "nope" })).toMatchObject({ ok: true, value: {} });
  });

  it("every error carries a message", () => {
    const r = welcomed().call("files.readFolder", { path: "nope" });
    expect(!r.ok && r.error.message.length).toBeGreaterThan(0);
  });
});

describe("host.info and project.getActive", () => {
  it("host.info", async () => {
    const host = await client(fake({ pomadeVersion: "0.3.0" }));
    expect(await host.info()).toEqual({ pomadeVersion: "0.3.0", hostApi: 0, appId: "fake-app", surface: "tab", route: "", skills: [] });
  });

  it("host.info says where each shipped skill is", async () => {
    const manifest = { id: "pomade-runner", name: "Runner", version: "0.1.0", hostApi: 0, capabilities: [], skills: ["skills/pomade-runner-jobs"] };
    const byDefault = await client(fake({ manifest }));
    expect((await byDefault.info()).skills).toEqual([{ name: "pomade-runner-jobs", path: "/fake/apps/pomade-runner/skills/pomade-runner-jobs" }]);
    const placed = await client(fake({ manifest, appFolder: "/Users/me/apps/runner/" }));
    expect((await placed.info()).skills).toEqual([{ name: "pomade-runner-jobs", path: "/Users/me/apps/runner/skills/pomade-runner-jobs" }]);
  });

  it("the Workspace scope when no project is active", async () => {
    const host = await client(fake());
    expect(await host.project.getActive()).toEqual({ id: "__workspace__", kind: "workspace", name: "Workspace", root: "" });
    expect(host.welcome.project).toEqual(WORKSPACE_SCOPE);
  });

  it("the active project, with its root normalized", async () => {
    const host = await client(fake({ activeProject: "kit" }));
    expect(await host.project.getActive()).toEqual({ id: "kit", kind: "project", name: "pomade-kit", root: "Projects/pomade-kit" });
  });
});

const STRIP_MANIFEST = {
  id: "pomade-planner",
  name: "Planner",
  version: "0.1.0",
  hostApi: 0,
  capabilities: [],
  strip: [
    { id: "planner", title: "Planner", action: "panel" },
    { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" },
    { id: "log", title: "Log", action: "tab", route: "log" },
  ],
};

describe("surfaces, strip icons and routes", () => {
  async function opened(open?: Parameters<FakeHost["createTransport"]>[0]) {
    const host = fake({ manifest: STRIP_MANIFEST });
    const r = await connect({ transport: host.createTransport(open), keySource: null });
    if (r.status !== "connected") throw new Error(r.status);
    const { surface, icon, route } = r.host.welcome;
    return { welcome: { surface, icon, route }, info: await r.host.info() };
  }

  it.each<[string, Parameters<FakeHost["createTransport"]>[0], object]>([
    ["default: a tab from the new-tab menu", undefined, { surface: "tab", icon: undefined, route: "" }],
    ["a tab for an icon takes its route", { icon: "board" }, { surface: "tab", icon: "board", route: "board" }],
    ["a panel takes panelRoute", { surface: "panel", icon: "board" }, { surface: "panel", icon: "board", route: "needs-you" }],
    ["a panel falls back to route", { surface: "panel", icon: "log" }, { surface: "panel", icon: "log", route: "log" }],
    ["a default route is \"\"", { surface: "panel", icon: "planner" }, { surface: "panel", icon: "planner", route: "" }],
    ["an unknown icon opens the default view", { surface: "panel", icon: "ghost" }, { surface: "panel", icon: undefined, route: "" }],
    ["a panel without an icon", { surface: "panel" }, { surface: "panel", icon: undefined, route: "" }],
  ])("%s — in welcome and host.info", async (_label, open, expected) => {
    const { welcome, info } = await opened(open);
    expect(welcome).toEqual(expected);
    expect({ surface: info.surface, icon: info.icon, route: info.route }).toEqual(expected);
    expect("icon" in info).toBe((expected as { icon?: string }).icon !== undefined);
  });

  it("raw frames: attach takes the same options; a reload keeps the target", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { surface: "panel", icon: "board" });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got.map((m) => (m.type === "welcome" ? [m.surface, m.icon, m.route] : null))).toEqual([
      ["panel", "board", "needs-you"],
      ["panel", "board", "needs-you"],
    ]);
  });

  it("a backend or command client: its role is the surface; frame-only methods are refused", async () => {
    const host = fake();
    for (const surface of ["backend", "command"] as const) {
      const r = await connect({ transport: host.createTransport({ surface }), keySource: null });
      if (r.status !== "connected") throw new Error(r.status);
      expect(r.host.welcome).toMatchObject({ surface, route: "" });
      await expect(r.host.info()).resolves.toMatchObject({ surface, route: "" });
      for (const call of [() => r.host.files.pickFolder(), () => r.host.files.pickFile(), () => r.host.git.watch({}, () => undefined), () => r.host.overlay.open(), () => r.host.overlay.resize({ height: 300 }), () => r.host.overlay.close()]) {
        await expect(call()).rejects.toMatchObject({ code: "capability-denied", message: expect.stringMatching(/needs an app frame/) });
      }
      await expect(r.host.files.readFolder({ path: "Projects/Pomade" })).resolves.toMatchObject({ entries: expect.any(Array) });
    }
  });

  it("a manifest without strip: every icon opens the default view", async () => {
    const host = fake();
    const r = await connect({ transport: host.createTransport({ surface: "panel", icon: "board" }), keySource: null });
    if (r.status !== "connected") throw new Error(r.status);
    expect(r.host.welcome).toMatchObject({ surface: "panel", route: "" });
    expect(r.host.welcome).not.toHaveProperty("icon");
  });
});

describe("strip.setBadge", () => {
  function welcomed(manifest: unknown = STRIP_MANIFEST) {
    const host = fake({ manifest });
    const f = raw(host);
    f.hello();
    return { host, ...f };
  }

  it("needs no capability; sets, replaces and clears badges by icon", async () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const app = await client(host);
    expect(host.badges).toEqual({});
    await app.strip.setBadge({ icon: "board", count: 3 });
    await app.strip.setBadge({ icon: "planner", count: 1, urgent: true });
    expect(host.badges).toEqual({ board: { count: 3, urgent: false }, planner: { count: 1, urgent: true } });
    await app.strip.setBadge({ icon: "board", count: 5, urgent: true });
    await app.strip.setBadge({ icon: "planner", count: 2, urgent: false });
    expect(host.badges).toEqual({ board: { count: 5, urgent: true }, planner: { count: 2, urgent: false } });
    await app.strip.setBadge({ icon: "board", count: 0 });
    await app.strip.setBadge({ icon: "log", count: 0 });
    expect(host.badges).toEqual({ planner: { count: 2, urgent: false } });
  });

  it("any frame of the app badges any of its icons", async () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const panel = await connect({ transport: host.createTransport({ surface: "panel", icon: "planner" }), keySource: null });
    if (panel.status !== "connected") throw new Error(panel.status);
    await panel.host.strip.setBadge({ icon: "log", count: 7 });
    expect(host.badges).toEqual({ log: { count: 7, urgent: false } });
  });

  it("badges is a snapshot", async () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    await (await client(host)).strip.setBadge({ icon: "board", count: 1 });
    const snapshot = host.badges;
    (snapshot.board as { count: number }).count = 99;
    expect(host.badges).toEqual({ board: { count: 1, urgent: false } });
  });

  it.each<[string, unknown]>([
    ["no params", undefined],
    ["params not an object", 5],
    ["icon missing", { count: 1 }],
    ["icon not a string", { icon: 1, count: 1 }],
    ["icon not declared", { icon: "ghost", count: 1 }],
    ["icon of another shape", { icon: "Board", count: 1 }],
    ["count missing", { icon: "board" }],
    ["count a string", { icon: "board", count: "1" }],
    ["count negative", { icon: "board", count: -1 }],
    ["count fractional", { icon: "board", count: 1.5 }],
    ["count NaN", { icon: "board", count: Number.NaN }],
    ["count infinite", { icon: "board", count: Number.POSITIVE_INFINITY }],
    ["urgent not a boolean", { icon: "board", count: 1, urgent: "yes" }],
    ["urgent null", { icon: "board", count: 1, urgent: null }],
  ])("invalid-params: %s", (_label, params) => {
    const f = welcomed();
    expect(f.errorOf("strip.setBadge", params)).toBe("invalid-params");
    expect(f.host.badges).toEqual({});
  });

  it("an app without strip icons has nothing to badge", () => {
    const f = welcomed({ id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [] });
    const r = f.call("strip.setBadge", { icon: "board", count: 1 });
    expect(!r.ok && r.error).toEqual({ code: "invalid-params", message: 'No strip icon "board" in the manifest' });
  });

  it("names the rule in the message", () => {
    const f = welcomed();
    const message = (params: unknown) => {
      const r = f.call("strip.setBadge", params);
      return r.ok ? null : r.error.message;
    };
    expect(message({ count: 1 })).toBe('"icon" must be a strip icon id');
    expect(message({ icon: "board", count: -1 })).toBe('"count" must be a non-negative integer');
    expect(message({ icon: "board", count: 1, urgent: 1 })).toBe('"urgent" must be a boolean');
  });

  it("is not-ready before welcome", () => {
    const f = raw(fake({ manifest: STRIP_MANIFEST }));
    expect(f.errorOf("strip.setBadge", { icon: "board", count: 1 })).toBe("not-ready");
  });
});

describe("state.get / state.set", () => {
  it("needs no capability; set, get, overwrite, null removes", async () => {
    const host = fake({ manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [] } });
    const app = await client(host);
    expect(await app.state.get("pins")).toBeNull();
    await app.state.set("pins", ["a"]);
    expect(await app.state.get("pins")).toEqual(["a"]);
    await app.state.set("pins", { b: 1 });
    expect(await app.state.get("pins")).toEqual({ b: 1 });
    expect(host.state).toEqual({ pins: { b: 1 } });
    await app.state.set("pins", null);
    expect(await app.state.get("pins")).toBeNull();
    expect(host.state).toEqual({});
  });

  it("stores a copy: mutating the value after set or after get changes nothing", async () => {
    const host = fake();
    const app = await client(host);
    const value = { list: [1] };
    await app.state.set("k", value);
    value.list.push(2);
    const got = await app.state.get<{ list: number[] }>("k");
    got?.list.push(3);
    expect(await app.state.get("k")).toEqual({ list: [1] });
    const snapshot = host.state;
    (snapshot.k as { list: number[] }).list.push(4);
    expect(host.state).toEqual({ k: { list: [1] } });
  });

  it("is shared by every frame of the app; the other welcomed frames get state.changed, the setter does not", async () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const tab = await client(host);
    const panel = await connect({ transport: host.createTransport({ surface: "panel", icon: "planner" }), keySource: null });
    if (panel.status !== "connected") throw new Error(panel.status);
    const unwelcomed = raw(host);
    const onTab = vi.fn();
    const onPanel = vi.fn();
    tab.state.onChange(onTab);
    panel.host.state.onChange(onPanel);
    await tab.state.set("view", "board");
    await flush();
    expect(await panel.host.state.get("view")).toBe("board");
    expect(onPanel.mock.calls).toEqual([["view", "board"]]);
    expect(onTab).not.toHaveBeenCalled();
    await panel.host.state.set("view", null);
    await flush();
    expect(onTab.mock.calls).toEqual([["view", null]]);
    expect(unwelcomed.events()).toEqual([]);
  });

  it("starts from the state option and validates it", async () => {
    const app = await client(fake({ state: { "last-summary": "2026-11-10", n: null } }));
    expect(await app.state.get("last-summary")).toBe("2026-11-10");
    expect(await app.state.get("n")).toBeNull();
    expect(() => fake({ state: { "": 1 } })).toThrow(/invalid state "": "key" must be a non-empty string/);
  });

  it.each<[string, string, unknown]>([
    ["get: no params", "state.get", undefined],
    ["get: key missing", "state.get", {}],
    ["get: key empty", "state.get", { key: "" }],
    ["get: key not a string", "state.get", { key: 1 }],
    ["set: key missing", "state.set", { value: 1 }],
    ["set: value missing", "state.set", { key: "k" }],
    ["set: value NaN", "state.set", { key: "k", value: Number.NaN }],
    ["set: value a Date", "state.set", { key: "k", value: new Date(0) }],
    ["set: key too long", "state.set", { key: "k".repeat(201), value: 1 }],
  ])("invalid-params: %s", (_label, method, params) => {
    const host = fake();
    const f = raw(host);
    f.hello();
    expect(f.errorOf(method, params)).toBe("invalid-params");
    expect(host.state).toEqual({});
  });

  it("is not-ready before welcome", () => {
    const f = raw(fake());
    expect(f.errorOf("state.get", { key: "k" })).toBe("not-ready");
  });
});

describe("tabs.openApp and navigate", () => {
  it("needs no capability; records the route and the target project (default the active one), and switches to it", async () => {
    const host = fake({ activeProject: "pomade", manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [] } });
    const app = await client(host);
    await app.tabs.openApp();
    await app.tabs.openApp({ route: "planner/today" });
    await app.tabs.openApp({ route: "board", projectId: "kit" });
    expect(host.activeProject.id).toBe("kit");
    await app.tabs.openApp({ projectId: WORKSPACE_SCOPE.id });
    expect(host.activeProject.id).toBe(WORKSPACE_SCOPE.id);
    expect(host.openedTabs).toEqual([
      { kind: "app", route: "", projectId: "pomade" },
      { kind: "app", route: "planner/today", projectId: "pomade" },
      { kind: "app", route: "board", projectId: "kit" },
      { kind: "app", route: "", projectId: "__workspace__" },
    ]);
  });

  it.each<[string, unknown, string]>([
    ["route not a string", { route: 1 }, "invalid-params"],
    ["projectId not a string", { projectId: 1 }, "invalid-params"],
    ["params not an object", "x", "invalid-params"],
    ["unknown project", { projectId: "nope" }, "not-found"],
  ])("%s → %s", (_label, params, code) => {
    const host = fake();
    const f = raw(host);
    f.hello();
    expect(f.errorOf("tabs.openApp", params)).toBe(code);
    expect(host.openedTabs).toEqual([]);
  });

  it("a frame opened at a route welcomes with it, over the icon's route", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const got: HostToAppMessage[] = [];
    host.attach((m) => got.push(m), { icon: "board", route: "board/T-1" }).receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "tab", icon: "board", route: "board/T-1" });
  });

  it("navigate posts route.changed when the route differs, and host.info and a reload follow it", async () => {
    const host = fake();
    const f = raw(host);
    f.frame.navigate("before-welcome");
    f.hello();
    expect(f.got[0]).toMatchObject({ type: "welcome", route: "before-welcome" });
    f.frame.navigate("planner/today");
    f.frame.navigate("planner/today");
    expect(f.events()).toEqual([{ channel: "pomade", type: "event", name: "route.changed", payload: { route: "planner/today" } }]);
    const info = f.call("host.info");
    expect(info.ok && info.value).toMatchObject({ route: "planner/today" });
    f.hello();
    expect(f.got.at(-1)).toMatchObject({ type: "welcome", route: "planner/today" });
  });
});

describe("the app's own tabs (tabs.openApp)", () => {
  it("opens one icon-less tab per project, focuses it again, and navigates it to a new route", async () => {
    const host = fake({ activeProject: "pomade", manifest: STRIP_MANIFEST });
    const changes: string[] = [];
    host.onAppTab(({ change, tab }) => changes.push(`${change} ${tab.tabId} ${tab.route}`));
    const app = await client(host);
    await app.tabs.openApp({ route: "today" });
    await app.tabs.openApp({ route: "today" });
    await app.tabs.openApp({ route: "week" });
    await app.tabs.openApp({ route: "today", projectId: "kit" });
    expect(host.appTabs).toEqual([
      { tabId: "app-tab-1", projectId: "pomade", route: "week" },
      { tabId: "app-tab-2", projectId: "kit", route: "today" },
    ]);
    expect(changes).toEqual(["open app-tab-1 today", "focus app-tab-1 today", "route app-tab-1 week", "focus app-tab-1 week", "open app-tab-2 today"]);
    expect(host.appTabChanges.map((c) => c.change)).toEqual(["open", "focus", "route", "focus", "open"]);
    expect(host.activeProject.id).toBe("kit");
  });

  it("a route a strip icon's tab renders is that icon's tab, never navigated; a panel-only icon's route is not", async () => {
    const host = fake({ activeProject: "pomade", manifest: STRIP_MANIFEST });
    const app = await client(host);
    await app.tabs.openApp({ route: "board" });
    await app.tabs.openApp({ route: "log" });
    await app.tabs.openApp({ route: "board" });
    await app.tabs.openApp({ route: "needs-you" });
    expect(host.appTabs).toEqual([
      { tabId: "app-tab-1", projectId: "pomade", icon: "board", route: "board" },
      { tabId: "app-tab-2", projectId: "pomade", icon: "log", route: "log" },
      { tabId: "app-tab-3", projectId: "pomade", route: "needs-you" },
    ]);
    expect(host.appTabChanges.map((c) => `${c.change} ${c.tab.tabId}`)).toEqual(["open app-tab-1", "open app-tab-2", "focus app-tab-1", "open app-tab-3"]);
  });

  it("a frame of a tab opens at its icon and route and follows its route changes; detached, it stops hearing them", () => {
    const host = fake({ activeProject: "pomade", manifest: STRIP_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { route: "today" });
    const [tab] = host.appTabs;
    if (!tab) throw new Error("no tab");
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { tabId: tab.tabId, surface: "panel", route: "ignored" });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "tab", route: "today" });
    expect(got[0]).not.toHaveProperty("icon");
    opener.call("tabs.openApp", { route: "week" });
    expect(got.filter((m) => m.type === "event")).toEqual([{ channel: "pomade", type: "event", name: "route.changed", payload: { route: "week" } }]);
    // The frame's own navigate is the tab's.
    frame.navigate("month");
    expect(host.appTabs[0]?.route).toBe("month");
    expect(host.appTabChanges.at(-1)).toEqual({ change: "route", tab: { tabId: tab.tabId, projectId: "pomade", route: "month" } });
    frame.detach();
    opener.call("tabs.openApp", { route: "year" });
    expect(got.filter((m) => m.type === "event")).toHaveLength(2);
    expect(() => host.attach(() => undefined, { tabId: "nope" })).toThrow(/no app tab/);
  });

  it("an icon tab's frame welcomes with the icon and its tab route", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const tab = host.openAppTab({ icon: "board", projectId: "kit" });
    const got: HostToAppMessage[] = [];
    host.attach((m) => got.push(m), { tabId: tab.tabId }).receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "tab", icon: "board", route: "board" });
  });

  it("openAppTab: the user opens the app's tab from the new-tab menu or a strip icon, as tabs.openApp does", () => {
    const host = fake({ activeProject: "pomade", manifest: STRIP_MANIFEST });
    expect(host.openAppTab()).toEqual({ tabId: "app-tab-1", projectId: "pomade", route: "" });
    expect(host.openAppTab({ route: "today" })).toEqual({ tabId: "app-tab-1", projectId: "pomade", route: "today" });
    expect(host.openAppTab({ icon: "log", projectId: "kit" })).toEqual({ tabId: "app-tab-2", projectId: "kit", icon: "log", route: "log" });
    expect(host.activeProject.id).toBe("kit");
    expect(host.appTabChanges.map((c) => c.change)).toEqual(["open", "route", "focus", "open"]);
    expect(() => host.openAppTab({ icon: "planner" })).toThrow(/no strip icon "planner" that opens a tab/);
    expect(() => host.openAppTab({ projectId: "nope" })).toThrow(/No project/);
    // The user's opening is not the app's call.
    expect(host.openedTabs).toEqual([]);
  });

  it("a notice's openApp action opens the tab in the project the notice belongs to", () => {
    const host = fake({ activeProject: "pomade", manifest: { ...STRIP_MANIFEST, capabilities: [] } });
    const r = raw(host);
    r.hello();
    r.call("notices.post", { title: "Today", action: { kind: "openApp", route: "today" } });
    host.setActiveProject("kit");
    host.clickNotice();
    expect(host.appTabs).toEqual([{ tabId: "app-tab-1", projectId: "pomade", route: "today" }]);
    expect(host.activeProject.id).toBe("pomade");
  });
});

describe("keyed tabs (tabs.openApp key, tabs.setTitle, tabs.close)", () => {
  const KEYED_MANIFEST = { ...STRIP_MANIFEST, tabKinds: { output: { title: "Output", icon: "output.svg" } } };

  it("one tab per (key, project): opened at its route with its title, focused, navigated and retitled again", async () => {
    const host = fake({ activeProject: "pomade", manifest: KEYED_MANIFEST });
    const app = await client(host);
    await app.tabs.openApp({ key: "a", kind: "output", title: "Scraper · output", route: "output/a" });
    await app.tabs.openApp({ key: "b", kind: "output", route: "output/b" });
    await app.tabs.openApp({ key: "c", route: "today" });
    await app.tabs.openApp({ key: "a", route: "output/a2", title: "Scraper · done" });
    await app.tabs.openApp({ key: "a", route: "output/a", projectId: "kit" });
    // The icon-less tab is not a keyed tab.
    await app.tabs.openApp({ route: "today" });
    expect(host.appTabs).toEqual([
      { tabId: "app-tab-1", projectId: "pomade", route: "output/a2", key: "a", kind: "output", title: "Scraper · done" },
      { tabId: "app-tab-2", projectId: "pomade", route: "output/b", key: "b", kind: "output", title: "Output" },
      { tabId: "app-tab-3", projectId: "pomade", route: "today", key: "c", title: "Planner" },
      { tabId: "app-tab-4", projectId: "kit", route: "output/a", key: "a", title: "Planner" },
      { tabId: "app-tab-5", projectId: "kit", route: "today" },
    ]);
    expect(host.appTabChanges.map((c) => `${c.change} ${c.tab.tabId}`)).toEqual([
      "open app-tab-1",
      "open app-tab-2",
      "open app-tab-3",
      "route app-tab-1",
      "title app-tab-1",
      "focus app-tab-1",
      "open app-tab-4",
      "open app-tab-5",
    ]);
    expect(host.openedTabs[0]).toEqual({ kind: "app", projectId: "pomade", route: "output/a", key: "a", title: "Scraper · output", tabKind: "output" });
  });

  it.each<[string, unknown]>([
    ["a bad key", { key: "a/b" }],
    ["kind without key", { kind: "output" }],
    ["title without key", { title: "A" }],
    ["an unknown kind", { key: "a", kind: "log" }],
    ["a blank title", { key: "a", title: " " }],
  ])("%s → invalid-params, nothing opens", (_label, params) => {
    const host = fake({ manifest: KEYED_MANIFEST });
    const f = raw(host);
    f.hello();
    expect(f.errorOf("tabs.openApp", params)).toBe("invalid-params");
    expect(host.appTabs).toEqual([]);
  });

  it("a keyed tab's frame welcomes with its key and kind, host.info too, and follows its route", () => {
    const host = fake({ manifest: KEYED_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { key: "a", kind: "output", route: "output/a" });
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { tabId: host.appTabs[0]!.tabId });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "tab", route: "output/a", key: "a", kind: "output" });
    expect(got[0]).not.toHaveProperty("icon");
    opener.call("tabs.openApp", { key: "a", route: "output/a2" });
    expect(got.filter((m) => m.type === "event")).toEqual([{ channel: "pomade", type: "event", name: "route.changed", payload: { route: "output/a2" } }]);
    frame.receive({ channel: "pomade", type: "call", id: "1", method: "host.info" });
    expect(got.at(-1)).toMatchObject({ type: "result", ok: true, value: { surface: "tab", route: "output/a2", key: "a", kind: "output" } });
    // Other frames carry neither.
    expect(opener.got[0]).not.toHaveProperty("key");
    expect(opener.got[0]).not.toHaveProperty("kind");
  });

  it("setTitle retitles the frame's own tab unless the user renamed it; openApp's title then leaves it too", () => {
    const host = fake({ manifest: KEYED_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { key: "a", kind: "output" });
    const tabId = host.appTabs[0]!.tabId;
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { tabId });
    let id = 0;
    const call = (method: string, params?: unknown) => {
      frame.receive({ channel: "pomade", type: "call", id: String(++id), method, params });
      return got.at(-1);
    };
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(call("tabs.setTitle", { title: " Deploy · output " })).toMatchObject({ ok: true, value: {} });
    expect(host.appTabs[0]?.title).toBe("Deploy · output");
    expect(call("tabs.setTitle", { title: "" })).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    host.renameAppTab(tabId, "Mine");
    expect(call("tabs.setTitle", { title: "Other" })).toMatchObject({ ok: true });
    opener.call("tabs.openApp", { key: "a", title: "Other" });
    expect(host.appTabs[0]).toMatchObject({ title: "Mine", renamed: true });
  });

  it("close closes the frame's own tab after its answer; the user's close does the same", async () => {
    const host = fake({ manifest: KEYED_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { key: "a" });
    opener.call("tabs.openApp", { key: "b" });
    const [a, b] = host.appTabs;
    const onClose = vi.fn();
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { tabId: b!.tabId, onClose });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    frame.receive({ channel: "pomade", type: "call", id: "1", method: "tabs.close" });
    expect(got.at(-1)).toMatchObject({ type: "result", ok: true });
    expect(onClose).not.toHaveBeenCalled();
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.appTabs.map((t) => t.key)).toEqual(["a"]);
    expect(host.appTabChanges.at(-1)).toMatchObject({ change: "close", tab: { key: "b" } });
    host.closeAppTab(a!.tabId);
    expect(host.appTabs).toEqual([]);
    // Opened again: a new tab.
    opener.call("tabs.openApp", { key: "a" });
    expect(host.appTabs.map((t) => t.tabId)).toEqual(["app-tab-3"]);
  });

  it("setTitle and close are for a tab frame: a panel's or an overlay's is invalid-params, a socket client's capability-denied", () => {
    const host = fake({ manifest: { ...KEYED_MANIFEST, backend: { entry: "b.mjs", mode: "with-pomade" } } });
    for (const surface of ["panel", "overlay"] as const) {
      const got: HostToAppMessage[] = [];
      const frame = host.attach((m) => got.push(m), { surface, icon: "planner" });
      frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
      frame.receive({ channel: "pomade", type: "call", id: "1", method: "tabs.setTitle", params: { title: "A" } });
      expect(got.at(-1)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
      frame.receive({ channel: "pomade", type: "call", id: "2", method: "tabs.close" });
      expect(got.at(-1)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    }
    const got: HostToAppMessage[] = [];
    const backend = host.attach((m) => got.push(m), { surface: "backend" });
    backend.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    backend.receive({ channel: "pomade", type: "call", id: "1", method: "tabs.close" });
    expect(got.at(-1)).toMatchObject({ ok: false, error: { code: "capability-denied" } });
  });
});

describe("tabs.setRoute", () => {
  function tabFrame(host: FakeHost, tabId: string) {
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { tabId });
    let id = 0;
    const call = (method: string, params?: unknown) => {
      frame.receive({ channel: "pomade", type: "call", id: String(++id), method, params });
      return got.at(-1);
    };
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    const routes = () => got.flatMap((m) => (m.type === "event" && m.name === "route.changed" ? [m.payload.route] : []));
    return { call, routes };
  }

  it("records the icon-less tab's route with no route.changed back; openApp to the old route navigates again; host.info answers it", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { route: "card/1" });
    const f = tabFrame(host, host.appTabs[0]!.tabId);
    expect(f.call("tabs.setRoute", { route: "" })).toMatchObject({ ok: true, value: {} });
    expect(f.routes()).toEqual([]);
    expect(host.appTabs[0]?.route).toBe("");
    expect(f.call("host.info")).toMatchObject({ ok: true, value: { route: "" } });
    opener.call("tabs.openApp", { route: "card/1" });
    expect(f.routes()).toEqual(["card/1"]);
    expect(host.appTabChanges.map((c) => `${c.change} ${c.tab.route}`)).toEqual(["open card/1", "route ", "route card/1", "focus card/1"]);
  });

  it("records a keyed tab's route", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { key: "a", route: "output/a" });
    const f = tabFrame(host, host.appTabs[0]!.tabId);
    f.call("tabs.setRoute", { route: "output/a/log" });
    opener.call("tabs.openApp", { key: "a", route: "output/a" });
    expect(f.routes()).toEqual(["output/a"]);
  });

  it("an icon's tab: openApp to the icon's route navigates back; a strip icon click is a plain focus", () => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const tab = host.openAppTab({ icon: "board" });
    const f = tabFrame(host, tab.tabId);
    f.call("tabs.setRoute", { route: "board/card/3" });
    host.openAppTab({ icon: "board" });
    expect(host.appTabs[0]).toMatchObject({ icon: "board", route: "board/card/3" });
    expect(f.routes()).toEqual([]);
    const opener = raw(host);
    opener.hello();
    opener.call("tabs.openApp", { route: "board" });
    expect(f.routes()).toEqual(["board"]);
    expect(host.appTabs).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ["no route", {}],
    ["a number", { route: 1 }],
  ])("%s → invalid-params", (_label, params) => {
    const host = fake({ manifest: STRIP_MANIFEST });
    const tab = host.openAppTab();
    expect(tabFrame(host, tab.tabId).call("tabs.setRoute", params)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
  });

  it("is for a tab frame: a panel's or an overlay's is invalid-params, a socket client's capability-denied", () => {
    const host = fake({ manifest: { ...STRIP_MANIFEST, backend: { entry: "b.mjs", mode: "with-pomade" } } });
    for (const surface of ["panel", "overlay"] as const) {
      const got: HostToAppMessage[] = [];
      const frame = host.attach((m) => got.push(m), { surface, icon: "planner" });
      frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
      frame.receive({ channel: "pomade", type: "call", id: "1", method: "tabs.setRoute", params: { route: "a" } });
      expect(got.at(-1)).toMatchObject({ ok: false, error: { code: "invalid-params" } });
    }
    const got: HostToAppMessage[] = [];
    const backend = host.attach((m) => got.push(m), { surface: "backend" });
    backend.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    backend.receive({ channel: "pomade", type: "call", id: "1", method: "tabs.setRoute", params: { route: "a" } });
    expect(got.at(-1)).toMatchObject({ ok: false, error: { code: "capability-denied" } });
  });
});

describe("socket surfaces in memory (backend, command)", () => {
  it("hear no project.changed unless subscribed, and their keys are ignored", () => {
    const host = fake({ activeProject: "pomade", manifest: { id: "a1", name: "A", version: "1.0.0", hostApi: 0, capabilities: [], backend: { entry: "b.mjs", mode: "with-pomade" }, events: { subscribe: ["project.changed"] } } });
    const got: HostToAppMessage[] = [];
    const backend = host.attach((m) => got.push(m), { surface: "backend" });
    backend.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "backend", route: "" });
    host.setActiveProject("kit");
    expect(got).toHaveLength(1);
    backend.receive({ channel: "pomade", type: "key", key: "w", code: "KeyW", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    expect(host.keys).toEqual([]);
    backend.receive({ channel: "pomade", type: "call", id: "1", method: "events.subscribe", params: { name: "project.changed" } });
    host.setActiveProject("pomade");
    expect(got.at(-1)).toMatchObject({ type: "event", name: "project.changed", payload: { id: "pomade" } });
  });
});

describe("overlay frames", () => {
  const OVERLAY_MANIFEST = {
    id: "planner",
    name: "Planner",
    version: "0.1.0",
    hostApi: 0,
    capabilities: [],
    shortcuts: [{ id: "quick-add", title: "Quick add", key: "Cmd+Shift+J", action: "overlay", route: "quick-add" }],
  };

  it("opens on the overlay surface at the shortcut's route; welcome and host.info say so", () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { surface: "overlay", shortcut: "quick-add" });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(got[0]).toMatchObject({ type: "welcome", surface: "overlay", route: "quick-add" });
    expect(got[0]).not.toHaveProperty("icon");
    frame.receive({ channel: "pomade", type: "call", id: "1", method: "host.info" });
    expect(got[1]).toMatchObject({ ok: true, value: { surface: "overlay", route: "quick-add" } });
  });

  it("overlay.close answers {} and then calls onClose; any other surface is invalid-params", async () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const onClose = vi.fn();
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { surface: "overlay", shortcut: "quick-add", onClose });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    frame.receive({ channel: "pomade", type: "call", id: "1", method: "overlay.close" });
    expect(got[1]).toEqual({ channel: "pomade", type: "result", id: "1", ok: true, value: {} });
    expect(onClose).not.toHaveBeenCalled();
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);

    const tab = raw(host);
    tab.hello();
    const r = tab.call("overlay.close");
    expect(!r.ok && r.error).toEqual({ code: "invalid-params", message: "overlay.close is only for an overlay frame" });
  });

  it("a forwarded plain Escape closes an overlay frame, never a tab frame", () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const onOverlayClose = vi.fn();
    const onTabClose = vi.fn();
    const overlay = host.attach(() => undefined, { surface: "overlay", onClose: onOverlayClose });
    const tab = host.attach(() => undefined, { onClose: onTabClose });
    const esc = { channel: "pomade", type: "key", key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    overlay.receive({ ...esc, shiftKey: true });
    expect(onOverlayClose).not.toHaveBeenCalled();
    overlay.receive(esc);
    tab.receive(esc);
    expect(onOverlayClose).toHaveBeenCalledTimes(1);
    expect(onTabClose).not.toHaveBeenCalled();
    expect(host.keys).toHaveLength(3);
  });

  it("overlay.open from a visible tab or panel records the route (default \"\"); from an overlay or a hidden frame it is invalid-params", async () => {
    const host = fake({ manifest: { ...OVERLAY_MANIFEST, strip: [{ id: "tasks", title: "Tasks", action: "panel" }] } });
    const tab = await connect({ transport: host.createTransport(), keySource: null });
    const panel = await connect({ transport: host.createTransport({ surface: "panel", icon: "tasks" }), keySource: null });
    const overlay = await connect({ transport: host.createTransport({ surface: "overlay", shortcut: "quick-add" }), keySource: null });
    const hidden = await connect({ transport: host.createTransport({ hidden: true }), keySource: null });
    if (tab.status !== "connected" || panel.status !== "connected" || overlay.status !== "connected" || hidden.status !== "connected") {
      throw new Error("not connected");
    }
    await panel.host.overlay.open({ route: "quick-add" });
    await tab.host.overlay.open();
    await expect(overlay.host.overlay.open({ route: "x" })).rejects.toMatchObject({ code: "invalid-params" });
    await expect(hidden.host.overlay.open({ route: "x" })).rejects.toMatchObject({ code: "invalid-params", message: expect.stringMatching(/visible/) });
    await expect(tab.host.overlay.open({ route: 7 as unknown as string })).rejects.toMatchObject({ code: "invalid-params" });
    expect(host.overlays).toEqual([
      { route: "quick-add", anchor: "center" },
      { route: "", anchor: "center" },
    ]);
  });

  it("overlay.open records height and anchor as given; a bad height or anchor is invalid-params", async () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const panel = await connect({ transport: host.createTransport({ surface: "panel" }), keySource: null });
    if (panel.status !== "connected") throw new Error("not connected");
    await panel.host.overlay.open({ route: "quick-add", height: 260.5, anchor: "panel" });
    await panel.host.overlay.open({ height: 300 });
    for (const bad of [{ height: 0 }, { height: -5 }, { height: "tall" }, { height: Number.NaN }, { anchor: "left" }, { anchor: 3 }]) {
      await expect(panel.host.overlay.open(bad as never)).rejects.toMatchObject({ code: "invalid-params" });
    }
    expect(host.overlays).toEqual([
      { route: "quick-add", height: 260.5, anchor: "panel" },
      { route: "", height: 300, anchor: "center" },
    ]);
  });

  it("overlay.resize from an overlay frame records the height; from a tab or panel frame, or with a bad height, it is invalid-params", async () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const overlay = await connect({ transport: host.createTransport({ surface: "overlay", shortcut: "quick-add" }), keySource: null });
    const tab = await connect({ transport: host.createTransport(), keySource: null });
    if (overlay.status !== "connected" || tab.status !== "connected") throw new Error("not connected");
    await overlay.host.overlay.resize({ height: 240 });
    await overlay.host.overlay.resize({ height: 255.5 });
    await expect(overlay.host.overlay.resize({ height: 0 })).rejects.toMatchObject({ code: "invalid-params" });
    await expect(overlay.host.overlay.resize({} as never)).rejects.toMatchObject({ code: "invalid-params" });
    await expect(tab.host.overlay.resize({ height: 240 })).rejects.toMatchObject({
      code: "invalid-params",
      message: "overlay.resize is only for an overlay frame",
    });
    expect(host.overlayResizes).toEqual([240, 255.5]);
  });

  it("onOverlayOpen hears overlay.open after its result; onOverlayResize hears overlay.resize as given", async () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const got: HostToAppMessage[] = [];
    const opened = vi.fn();
    const resized = vi.fn();
    const tab = host.attach((m) => got.push(m), { onOverlayOpen: opened });
    tab.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    tab.receive({ channel: "pomade", type: "call", id: "1", method: "overlay.open", params: { route: "quick-add", height: 300, anchor: "panel" } });
    tab.receive({ channel: "pomade", type: "call", id: "2", method: "overlay.open", params: { route: 7 } });
    expect(got[1]).toMatchObject({ type: "result", ok: true });
    expect(opened).not.toHaveBeenCalled();
    await flush();
    expect(opened.mock.calls).toEqual([[{ route: "quick-add", height: 300, anchor: "panel" }]]);

    const overlay = host.attach(() => undefined, { surface: "overlay", onOverlayResize: resized });
    overlay.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    overlay.receive({ channel: "pomade", type: "call", id: "1", method: "overlay.resize", params: { height: 255.5 } });
    overlay.receive({ channel: "pomade", type: "call", id: "2", method: "overlay.resize", params: { height: 0 } });
    expect(resized.mock.calls).toEqual([[255.5]]);
  });

  it("a frame shown again may open the overlay (setHidden)", () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const got: HostToAppMessage[] = [];
    const frame = host.attach((m) => got.push(m), { hidden: true });
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    frame.receive({ channel: "pomade", type: "call", id: "1", method: "overlay.open", params: { route: "a" } });
    frame.setHidden(false);
    frame.receive({ channel: "pomade", type: "call", id: "2", method: "overlay.open", params: { route: "b" } });
    frame.setHidden(true);
    frame.receive({ channel: "pomade", type: "call", id: "3", method: "overlay.open", params: { route: "c" } });
    expect(got.slice(1).map((m) => m.type === "result" && m.ok)).toEqual([false, true, false]);
    expect(host.overlays).toEqual([{ route: "b", anchor: "center" }]);
  });

  it("the SDK closes its overlay", async () => {
    const host = fake({ manifest: OVERLAY_MANIFEST });
    const onClose = vi.fn();
    const r = await connect({ transport: host.createTransport({ surface: "overlay", shortcut: "quick-add", onClose }), keySource: null });
    if (r.status !== "connected") throw new Error(r.status);
    expect(r.host.welcome).toMatchObject({ surface: "overlay", route: "quick-add" });
    await r.host.overlay.close();
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("panel.show", () => {
  const PANEL_MANIFEST = {
    id: "planner",
    name: "Planner",
    version: "0.1.0",
    hostApi: 0,
    capabilities: [],
    strip: [
      { id: "today", title: "Today", action: "tab", route: "today" },
      { id: "notes", title: "Notes", action: "panel" },
      { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" },
    ],
    shortcuts: [{ id: "quick-add", title: "Quick add", key: "Cmd+Shift+J", action: "overlay", route: "quick-add" }],
  };

  it("records the icon shown (default the first panel icon) and the route, from a tab, an overlay or a hidden frame", async () => {
    const host = fake({ manifest: PANEL_MANIFEST });
    const tab = await connect({ transport: host.createTransport(), keySource: null });
    const overlay = await connect({ transport: host.createTransport({ surface: "overlay", shortcut: "quick-add" }), keySource: null });
    const hidden = await connect({ transport: host.createTransport({ surface: "panel", icon: "board", hidden: true }), keySource: null });
    if (tab.status !== "connected" || overlay.status !== "connected" || hidden.status !== "connected") throw new Error("not connected");
    await overlay.host.panel.show({ route: "note/7" });
    await tab.host.panel.show({ icon: "board" });
    await hidden.host.panel.show({ icon: "notes", route: "" });
    expect(host.panelShows).toEqual([{ icon: "notes", route: "note/7" }, { icon: "board" }, { icon: "notes", route: "" }]);
  });

  it("a mounted panel frame of that icon gets route.changed and is shown; the app's other panel frames are hidden", async () => {
    const host = fake({ manifest: PANEL_MANIFEST });
    const notes = await connect({ transport: host.createTransport({ surface: "panel", icon: "notes", hidden: true }), keySource: null });
    const board = await connect({ transport: host.createTransport({ surface: "panel", icon: "board" }), keySource: null });
    if (notes.status !== "connected" || board.status !== "connected") throw new Error("not connected");
    const notesRoutes: string[] = [];
    const boardRoutes: string[] = [];
    notes.host.onRouteChange((r) => notesRoutes.push(r));
    board.host.onRouteChange((r) => boardRoutes.push(r));
    await board.host.panel.show({ icon: "notes", route: "note/7" });
    await flush();
    expect(notesRoutes).toEqual(["note/7"]);
    expect(boardRoutes).toEqual([]);
    expect(await notes.host.info()).toMatchObject({ route: "note/7" });
    // Shown now: it may open the overlay; the board panel, hidden by the switch, may not.
    await notes.host.overlay.open();
    await expect(board.host.overlay.open()).rejects.toMatchObject({ code: "invalid-params" });
    // The same route again: no route.changed; no route: the panel stays where it is.
    await board.host.panel.show({ icon: "notes", route: "note/7" });
    await board.host.panel.show({ icon: "notes" });
    await flush();
    expect(notesRoutes).toEqual(["note/7"]);
  });

  it("a panel frame opened after the call is welcomed at the route it gave", async () => {
    const host = fake({ manifest: PANEL_MANIFEST });
    const tab = await connect({ transport: host.createTransport(), keySource: null });
    if (tab.status !== "connected") throw new Error("not connected");
    await tab.host.panel.show({ icon: "board", route: "card/3" });
    const board = await connect({ transport: host.createTransport({ surface: "panel", icon: "board" }), keySource: null });
    const notes = await connect({ transport: host.createTransport({ surface: "panel", icon: "notes" }), keySource: null });
    if (board.status !== "connected" || notes.status !== "connected") throw new Error("not connected");
    expect(board.host.welcome).toMatchObject({ surface: "panel", icon: "board", route: "card/3" });
    expect(notes.host.welcome).toMatchObject({ surface: "panel", icon: "notes", route: "" });
  });

  it("an icon with no panel, an unknown icon and an app without a panel icon are not-found; a bad type is invalid-params", async () => {
    const host = fake({ manifest: PANEL_MANIFEST });
    const tab = await connect({ transport: host.createTransport(), keySource: null });
    if (tab.status !== "connected") throw new Error("not connected");
    await expect(tab.host.panel.show({ icon: "today" })).rejects.toMatchObject({ code: "not-found" });
    await expect(tab.host.panel.show({ icon: "nope" })).rejects.toMatchObject({ code: "not-found" });
    await expect(tab.host.panel.show({ icon: 1 as unknown as string })).rejects.toMatchObject({ code: "invalid-params" });
    await expect(tab.host.panel.show({ route: 7 as unknown as string })).rejects.toMatchObject({ code: "invalid-params" });
    const bare = fake({ manifest: { ...PANEL_MANIFEST, strip: [PANEL_MANIFEST.strip[0]] } });
    const bareTab = await connect({ transport: bare.createTransport(), keySource: null });
    if (bareTab.status !== "connected") throw new Error("not connected");
    await expect(bareTab.host.panel.show()).rejects.toMatchObject({ code: "not-found" });
    expect([...host.panelShows, ...bare.panelShows]).toEqual([]);
  });
});

describe("files.readFolder", () => {
  it("lists direct children, sorted by path, with kind, size (UTF-8 bytes) and mtime", async () => {
    const host = await client(fake());
    const { entries } = await host.files.readFolder({ path: "Projects/Pomade" });
    expect(entries).toEqual([
      { path: "Projects/Pomade/README.md", name: "README.md", kind: "file", size: 2, mtimeMs: 1000 },
      { path: "Projects/Pomade/docs", name: "docs", kind: "dir", size: 0, mtimeMs: 1000 },
    ]);
  });

  it("lists the workspace root for path ''", async () => {
    const host = await client(fake());
    expect((await host.files.readFolder({ path: "" })).entries.map((e) => e.path)).toEqual(["Projects"]);
  });

  it("normalizes the requested path", async () => {
    const host = await client(fake());
    const a = await host.files.readFolder({ path: "./Projects//Pomade/docs/../" });
    const b = await host.files.readFolder({ path: "Projects/Pomade" });
    expect(a).toEqual(b);
  });

  it("recursive includes sub-folders and honors the ignore list", async () => {
    const host = await client(fake());
    const { entries } = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", recursive: true });
    expect(entries.map((e) => e.path)).toEqual([
      "Projects/Pomade/docs/roadmap/E-001-a.md",
      "Projects/Pomade/docs/roadmap/T-002-b.md",
      "Projects/Pomade/docs/roadmap/data.json",
      "Projects/Pomade/docs/roadmap/done",
      "Projects/Pomade/docs/roadmap/done/E-000-old.markdown",
      "Projects/Pomade/docs/roadmap/notes.md",
    ]);
  });

  it("non-recursive also hides ignored names", async () => {
    const host = await client(fake());
    const { entries } = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap" });
    expect(entries.map((e) => e.name)).toEqual(["E-001-a.md", "T-002-b.md", "data.json", "done", "notes.md"]);
  });

  it("a custom ignore list replaces the default", async () => {
    const host = await client(fake({ ignore: ["done"] }));
    const { entries } = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", recursive: true });
    const names = entries.map((e) => e.name);
    expect(names).toContain(".git");
    expect(names).toContain("index.md");
    expect(names).not.toContain("done");
    expect(names).not.toContain("E-000-old.markdown");
  });

  it("reading inside an ignored folder lists it", async () => {
    const host = await client(fake());
    const { entries } = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap/.git" });
    expect(entries.map((e) => e.name)).toEqual(["HEAD"]);
  });

  it("frontmatter: only when asked, only for Markdown files", async () => {
    const host = await client(fake());
    const plain = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", recursive: true });
    expect(plain.entries.every((e) => !("frontmatter" in e) && !("frontmatterError" in e))).toBe(true);

    const { entries } = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", recursive: true, frontmatter: true });
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(by["E-001-a.md"]?.frontmatter).toEqual({ id: "E-001", status: "done", created: "2026-11-09" });
    expect(by["T-002-b.md"]?.frontmatter).toBeUndefined();
    expect(by["T-002-b.md"]?.frontmatterError).toEqual(expect.any(String));
    expect(by["notes.md"]).toMatchObject({ frontmatter: null });
    expect(by["E-000-old.markdown"]?.frontmatter).toEqual({ id: "E-000" });
    expect(by["data.json"]).not.toHaveProperty("frontmatter");
    expect(by["done"]).not.toHaveProperty("frontmatter");
  });

  it("results are copies: mutating them does not change the workspace", async () => {
    const host = await client(fake());
    const a = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", frontmatter: true });
    const entry = a.entries[0];
    if (entry?.frontmatter) entry.frontmatter.id = "mutated";
    const b = await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", frontmatter: true });
    expect(b.entries[0]?.frontmatter).toMatchObject({ id: "E-001" });
  });
});

describe("files.watch and test controls", () => {
  async function watched(host: FakeHost, path: string, recursive: boolean) {
    const client_ = await client(host);
    const batches: FileChange[][] = [];
    const watch = await client_.files.watch({ path, recursive }, (c) => batches.push(c));
    return { client: client_, batches, watch };
  }

  it("writeFile: create (with new parent folders), then change", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs", true);
    host.writeFile("Projects/Pomade/docs/new/x.md", "a");
    host.writeFile("Projects/Pomade/docs/new/x.md", "ab");
    await flush();
    expect(w.batches).toEqual([
      [
        { kind: "create", path: "Projects/Pomade/docs/new" },
        { kind: "create", path: "Projects/Pomade/docs/new/x.md" },
      ],
      [{ kind: "change", path: "Projects/Pomade/docs/new/x.md" }],
    ]);
  });

  it("deleteFile and rename", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs/roadmap", true);
    host.deleteFile("Projects/Pomade/docs/roadmap/notes.md");
    host.rename("Projects/Pomade/docs/roadmap/E-001-a.md", "Projects/Pomade/docs/roadmap/done/E-001-a.md");
    await flush();
    expect(w.batches).toEqual([
      [{ kind: "delete", path: "Projects/Pomade/docs/roadmap/notes.md" }],
      [{ kind: "rename", path: "Projects/Pomade/docs/roadmap/done/E-001-a.md", oldPath: "Projects/Pomade/docs/roadmap/E-001-a.md" }],
    ]);
    const { entries } = await w.client.files.readFolder({ path: "Projects/Pomade/docs/roadmap/done", frontmatter: true });
    expect(entries.map((e) => e.name)).toEqual(["E-000-old.markdown", "E-001-a.md"]);
    expect(entries[1]?.frontmatter).toMatchObject({ id: "E-001" });
  });

  it("renaming a folder moves everything under it", async () => {
    const host = fake();
    const c = await client(host);
    host.rename("Projects/Pomade/docs/roadmap/done", "Projects/Pomade/archive/done");
    const { entries } = await c.files.readFolder({ path: "Projects/Pomade/archive", recursive: true });
    expect(entries.map((e) => e.path)).toEqual(["Projects/Pomade/archive/done", "Projects/Pomade/archive/done/E-000-old.markdown"]);
    await expect(c.files.readFolder({ path: "Projects/Pomade/docs/roadmap/done" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("a non-recursive watch sees direct children only", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs/roadmap", false);
    host.writeFile("Projects/Pomade/docs/roadmap/done/E-009.md", "");
    host.writeFile("Projects/Pomade/docs/roadmap/E-009.md", "");
    await flush();
    expect(w.batches).toEqual([[{ kind: "create", path: "Projects/Pomade/docs/roadmap/E-009.md" }]]);
  });

  it("changes under ignored folders are not reported", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade", true);
    host.writeFile("Projects/Pomade/docs/roadmap/.git/index", "");
    host.writeFile("Projects/Pomade/node_modules/y/z.js", "");
    await flush();
    expect(w.batches).toEqual([]);
  });

  it("changes outside the watched path are not reported", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs", true);
    host.writeFile("Projects/Pomade/docs2/a.md", "");
    host.writeFile("Projects/Pomade/README.md", "x");
    await flush();
    expect(w.batches).toEqual([]);
  });

  it("a rename across the watch boundary is reported both ways", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs/roadmap/done", false);
    host.rename("Projects/Pomade/docs/roadmap/notes.md", "Projects/Pomade/docs/roadmap/done/notes.md");
    host.rename("Projects/Pomade/docs/roadmap/done/E-000-old.markdown", "Projects/Pomade/E-000-old.markdown");
    await flush();
    expect(w.batches.map((b) => b.map((c) => c.kind))).toEqual([["rename"], ["rename"]]);
  });

  it("a watch on a file sees that file", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/README.md", false);
    host.writeFile("Projects/Pomade/README.md", "new");
    host.writeFile("Projects/Pomade/README2.md", "new");
    await flush();
    expect(w.batches).toEqual([[{ kind: "change", path: "Projects/Pomade/README.md" }]]);
  });

  it("a watch on the root sees everything not ignored", async () => {
    const host = fake();
    const w = await watched(host, "", true);
    host.writeFile("top.md", "");
    host.writeFile("Projects/Pomade/deep/er/x.md", "");
    await flush();
    expect(w.batches.flat().map((c) => c.path)).toEqual(["top.md", "Projects/Pomade/deep", "Projects/Pomade/deep/er", "Projects/Pomade/deep/er/x.md"]);
  });

  it("close() stops events; other watches on the same path keep theirs", async () => {
    const host = fake();
    const closed = await watched(host, "Projects", true);
    const kept: FileChange[][] = [];
    await closed.client.files.watch({ path: "Projects", recursive: true }, (x) => kept.push(x));
    await closed.watch.close();
    host.writeFile("Projects/x.md", "");
    await flush();
    expect(closed.batches).toEqual([]);
    expect(kept).toEqual([[{ kind: "create", path: "Projects/x.md" }]]);
  });

  it("batch() delivers one files.changed per watch", async () => {
    const host = fake();
    const w = await watched(host, "Projects/Pomade/docs/roadmap", true);
    host.batch(() => {
      host.writeFile("Projects/Pomade/docs/roadmap/a.md", "");
      host.batch(() => host.deleteFile("Projects/Pomade/docs/roadmap/notes.md"));
      host.writeFile("Elsewhere/b.md", "");
    });
    await flush();
    expect(w.batches).toEqual([
      [
        { kind: "create", path: "Projects/Pomade/docs/roadmap/a.md" },
        { kind: "delete", path: "Projects/Pomade/docs/roadmap/notes.md" },
      ],
    ]);
  });

  it("frames do not share watches", async () => {
    const host = fake();
    const a = await watched(host, "Projects", true);
    const b = await client(host);
    const bGot = vi.fn();
    await b.files.watch({ path: "Projects/Pomade/docs", recursive: true }, bGot);
    host.writeFile("Projects/x.md", "");
    await flush();
    expect(a.batches).toHaveLength(1);
    expect(bGot).not.toHaveBeenCalled();
  });

  it("watch ids are unique across frames", async () => {
    const host = fake();
    const a = await client(host);
    const b = await client(host);
    const ids = [(await a.files.watch({ path: "" }, vi.fn())).watchId, (await b.files.watch({ path: "" }, vi.fn())).watchId];
    expect(new Set(ids).size).toBe(2);
  });

  it("mtime follows the clock; a folder's mtime moves when its entries change", async () => {
    const host = fake();
    const c = await client(host);
    clock = 5000;
    host.writeFile("Projects/Pomade/new.md", "x");
    const { entries } = await c.files.readFolder({ path: "Projects/Pomade" });
    expect(entries.find((e) => e.name === "new.md")?.mtimeMs).toBe(5000);
    const parent = await c.files.readFolder({ path: "Projects" });
    expect(parent.entries[0]).toMatchObject({ name: "Pomade", mtimeMs: 5000 });
  });
});

describe("setActiveProject", () => {
  it("emits project.changed to every welcomed frame and updates getActive", async () => {
    const host = fake();
    const a = await client(host);
    const b = await client(host);
    const unwelcomed = raw(host);
    const seenA: ProjectRef[] = [];
    const seenB: ProjectRef[] = [];
    a.project.onChange((p) => seenA.push(p));
    b.project.onChange((p) => seenB.push(p));
    host.setActiveProject("pomade");
    host.setActiveProject("pomade");
    host.setActiveProject(null);
    await flush();
    const pomade = { id: "pomade", kind: "project", name: "Pomade", root: "Projects/Pomade" };
    expect(seenA).toEqual([pomade, WORKSPACE_SCOPE]);
    expect(seenB).toEqual(seenA);
    expect(unwelcomed.got).toEqual([]);
    expect(host.activeProject).toEqual(WORKSPACE_SCOPE);
    host.setActiveProject("kit");
    expect(await a.project.getActive()).toMatchObject({ id: "kit" });
  });

  it("an unknown project id throws", () => {
    expect(() => fake().setActiveProject("nope")).toThrow(/no project/);
  });
});

describe("construction and control errors", () => {
  it("rejects an invalid manifest and an unknown active project", () => {
    expect(() => createFakeHost({ manifest: { id: "X" } })).toThrow(/invalid manifest.*"id".*; "name"/);
    expect(() => createFakeHost({ activeProject: "nope" })).toThrow(/no project/);
  });

  it("rejects invalid control paths and impossible operations", () => {
    const host = fake();
    expect(() => host.writeFile("../x", "")).toThrow(/invalid workspace path/);
    expect(() => host.writeFile("", "")).toThrow(/invalid workspace path/);
    expect(() => host.writeFile("Projects/Pomade", "")).toThrow(/is a folder/);
    expect(() => host.writeFile("Projects/Pomade/README.md/x", "")).toThrow(/is a file/);
    expect(() => host.deleteFile("Projects/nope.md")).toThrow(/no file/);
    expect(() => host.deleteFile("Projects/Pomade")).toThrow(/no file/);
    expect(() => host.rename("Projects/nope", "x")).toThrow(/nothing at/);
    expect(() => host.rename("Projects/Pomade/README.md", "Projects/Pomade/docs")).toThrow(/already exists/);
    expect(() => host.rename("Projects/Pomade", "Projects/Pomade/sub")).toThrow(/into itself/);
    expect(() => createFakeHost({ projects: [{ id: "x", name: "X", root: "../out" }] })).toThrow(/invalid workspace path/);
  });

  it("the default transport is one frame", () => {
    const host = fake();
    expect(host.transport).toBe(host.transport);
    expect(host.createTransport()).not.toBe(host.transport);
  });
});

describe("events (pomade:E-031)", () => {
  const manifest = {
    id: "pomade-runner",
    name: "Runner",
    version: "0.1.0",
    hostApi: 0,
    capabilities: [],
    events: { publish: ["run.finished"], subscribe: ["pomade.ready", "project.renamed", "pomade-agents:session.closed", "pomade-runner:run.finished"] },
  };
  const evs = (r: ReturnType<typeof raw>, name: string) =>
    r.events().flatMap((m) => (m.name === name ? [m.payload] : []));

  it("every frame hears project.changed; project.renamed only when subscribed", () => {
    const host = fake({ manifest, activeProject: "pomade" });
    const a = raw(host);
    const b = raw(host);
    a.hello();
    b.hello();
    expect(a.call("events.subscribe", { name: "project.renamed" }).ok).toBe(true);
    host.updateProject("pomade", { name: "Pomade 2" });
    const project = { id: "pomade", kind: "project", name: "Pomade 2", root: "Projects/Pomade" };
    expect(evs(a, "project.renamed")).toEqual([{ project, previous: { ...project, name: "Pomade" } }]);
    expect(evs(b, "project.renamed")).toEqual([]);
    expect(evs(a, "project.changed")).toEqual([project]);
    expect(evs(b, "project.changed")).toEqual([project]);
  });

  it("removeProject: project.removed to subscribers with the project as it was, then project.changed when it was active", () => {
    const host = fake({ manifest: { ...manifest, events: { subscribe: ["project.removed"] } }, activeProject: "pomade" });
    const r = raw(host);
    r.hello();
    expect(r.call("events.subscribe", { name: "project.removed" }).ok).toBe(true);
    host.removeProject("kit");
    host.removeProject("pomade");
    expect(evs(r, "project.removed")).toEqual([
      { id: "kit", kind: "project", name: "pomade-kit", root: "Projects/pomade-kit" },
      { id: "pomade", kind: "project", name: "Pomade", root: "Projects/Pomade" },
    ]);
    expect(evs(r, "project.changed")).toEqual([{ id: "__workspace__", kind: "workspace", name: "Workspace", root: "" }]);
    expect(() => host.removeProject("pomade")).toThrow(/no project/);
  });

  it("refuses undeclared and malformed names", () => {
    const r = raw(fake({ manifest }));
    r.hello();
    expect(r.errorOf("events.subscribe", { name: "project.created" })).toBe("capability-denied");
    expect(r.errorOf("events.subscribe", { name: "session.closed" })).toBe("invalid-params");
    expect(r.errorOf("events.publish", { name: "run.started" })).toBe("capability-denied");
    expect(r.errorOf("events.publish", { name: "run.finished", payload: { at: Number.POSITIVE_INFINITY } })).toBe("invalid-params");
    expect(r.errorOf("events.hasSubscribers", { name: "run.started" })).toBe("capability-denied");
    expect(r.errorOf("events.unsubscribe", { name: "never" })).toBeNull();
  });

  it("pomade.ready is sticky: a later subscription gets it right after its result", async () => {
    const host = fake({ manifest });
    host.ready();
    const r = raw(host);
    r.hello();
    r.call("events.subscribe", { name: "pomade.ready" });
    expect(evs(r, "pomade.ready")).toEqual([]);
    await flush();
    expect(evs(r, "pomade.ready")).toEqual([{}]);
  });

  it("publish reaches the other subscribed frames, is recorded, and other apps' events arrive by emitEvent", () => {
    const host = fake({ manifest });
    const a = raw(host);
    const b = raw(host);
    a.hello();
    b.hello();
    b.call("events.subscribe", { name: "pomade-runner:run.finished" });
    b.call("events.subscribe", { name: "pomade-agents:session.closed" });
    expect(a.call("events.publish", { name: "run.finished", payload: { id: "r1" } }).ok).toBe(true);
    expect(evs(b, "pomade-runner:run.finished")).toEqual([{ id: "r1" }]);
    expect(evs(a, "pomade-runner:run.finished")).toEqual([]);
    expect(host.published).toEqual([{ name: "run.finished", payload: { id: "r1" } }]);
    host.emitEvent("pomade-agents:session.closed", { sessionId: "s1" });
    expect(evs(b, "pomade-agents:session.closed")).toEqual([{ sessionId: "s1" }]);
    expect(() => host.emitEvent("nope", 1)).toThrow(/not a platform event/);
    expect(host.subscriptions).toEqual(["pomade-agents:session.closed", "pomade-runner:run.finished", "project.changed", "theme.changed"]);
  });

  it("hasSubscribers follows other apps' subscriptions, with subscribersChanged news", () => {
    const host = fake({ manifest });
    const r = raw(host);
    r.hello();
    expect(r.call("events.hasSubscribers", { name: "run.finished" })).toMatchObject({ ok: true, value: { subscribed: false } });
    const heard: unknown[] = [];
    const off = host.subscribeAs("pomade-agents", "run.finished", heard as never);
    expect(r.call("events.hasSubscribers", { name: "run.finished" })).toMatchObject({ ok: true, value: { subscribed: true } });
    r.call("events.publish", { name: "run.finished", payload: 1 });
    expect(heard).toEqual([1]);
    off();
    expect(r.call("events.hasSubscribers", { name: "run.finished" })).toMatchObject({ ok: true, value: { subscribed: false } });
    expect(evs(r, "events.subscribersChanged")).toEqual([
      { name: "run.finished", subscribed: true },
      { name: "run.finished", subscribed: false },
    ]);
  });

  it("a new handshake or a detach ends the frame's subscriptions", () => {
    const host = fake({ manifest });
    const r = raw(host);
    r.hello();
    r.call("events.subscribe", { name: "project.renamed" });
    r.hello();
    host.updateProject("kit", { name: "kit 2" });
    expect(evs(r, "project.renamed")).toEqual([]);
    r.call("events.subscribe", { name: "pomade-runner:run.finished" });
    const other = raw(host);
    other.hello();
    expect(other.call("events.hasSubscribers", { name: "run.finished" })).toMatchObject({ value: { subscribed: true } });
    r.frame.detach();
    expect(other.call("events.hasSubscribers", { name: "run.finished" })).toMatchObject({ value: { subscribed: false } });
  });

  it("through the SDK: subscribe, publish, hasSubscribers, subscriber news", async () => {
    const host = fake({ manifest });
    const a = await client(host);
    const b = await client(host);
    const runs: unknown[] = [];
    const news: [string, boolean][] = [];
    a.events.onSubscribersChange((name, subscribed) => news.push([name, subscribed]));
    expect(await a.events.hasSubscribers("run.finished")).toBe(false);
    const sub = await b.events.subscribe("pomade-runner:run.finished", (p) => runs.push(p));
    const sub2 = await b.events.subscribe("pomade-runner:run.finished", (p) => runs.push(["second", p]));
    expect(await a.events.hasSubscribers("run.finished")).toBe(true);
    await a.events.publish("run.finished", { id: "r9" });
    await flush();
    expect(runs).toEqual([{ id: "r9" }, ["second", { id: "r9" }]]);
    await sub.close();
    expect(await a.events.hasSubscribers("run.finished")).toBe(true);
    await sub2.close();
    expect(await a.events.hasSubscribers("run.finished")).toBe(false);
    await flush();
    expect(news).toEqual([
      ["run.finished", true],
      ["run.finished", false],
    ]);
    await expect(b.events.subscribe("project.created", () => {})).rejects.toMatchObject({ code: "capability-denied" });
    const renamed: unknown[] = [];
    await b.events.subscribe("project.renamed", (p) => renamed.push(p.project.name));
    host.updateProject("pomade", { name: "P" });
    await flush();
    expect(renamed).toEqual(["P"]);
    host.ready();
    const ready: unknown[] = [];
    await b.events.subscribe("pomade.ready", (p) => ready.push(p));
    await flush();
    expect(ready).toEqual([{}]);
  });
});

describe("notices (pomade:E-032)", () => {
  it("records a posted notice, normalized; a click runs its action like Pomade", () => {
    const host = fake({ activeProject: "pomade" });
    const r = raw(host);
    r.hello();
    expect(r.call("notices.post", { title: " Run failed ", body: "nightly", action: { kind: "openFile", path: "Projects/Pomade/README.md", projectId: "kit" } }).ok).toBe(true);
    expect(host.notices).toEqual([
      { title: "Run failed", body: "nightly", action: { kind: "openFile", path: "Projects/Pomade/README.md", projectId: "kit" } },
    ]);
    host.clickNotice();
    expect(host.openedTabs).toEqual([{ kind: "file", projectId: "kit", path: "Projects/Pomade/README.md" }]);
    expect(host.activeProject.id).toBe("kit");
    r.call("notices.post", { title: "Today", action: { kind: "openApp", route: "today" } });
    host.clickNotice();
    expect(host.openedTabs.at(-1)).toEqual({ kind: "app", projectId: "kit", route: "today" });
    r.call("notices.post", { title: "Just news" });
    host.clickNotice();
    expect(host.openedTabs).toHaveLength(2);
  });

  it("refuses an invalid notice; a tab-opening action needs tabs.open", () => {
    const host = fake({ manifest: { id: "planner", name: "Planner", version: "0.1.0", hostApi: 0, capabilities: [] } });
    const r = raw(host);
    r.hello();
    expect(r.errorOf("notices.post", { title: "" })).toBe("invalid-params");
    expect(r.errorOf("notices.post", { title: "x", action: { kind: "openFile", path: "../x" } })).toBe("outside-workspace");
    expect(r.errorOf("notices.post", { title: "x", action: { kind: "openTerminal", cwd: "" } })).toBe("capability-denied");
    expect(r.errorOf("notices.post", { title: "x", action: { kind: "openApp", route: "today" } })).toBeNull();
    expect(host.notices).toHaveLength(1);
  });
});
