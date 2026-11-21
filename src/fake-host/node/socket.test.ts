// The fake host's socket side: a backend or command connects to it as to Pomade — the identity,
// the handshake, the socket rules (no project of its own, only the events it subscribes to, no
// frame-only methods), the broker with the backend as the server, the app's own tab, and the
// connection's lifetime. The clients are the kit's own `pomade-kit/node` client.

import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createLineDecoder, encodeLine, type JsonValue } from "../../protocol/index.js";
import { connectSocket, stayConnected } from "../../node/socket.js";
import { HostError, type HostClient } from "../../sdk/client.js";
import { connect } from "../../sdk/connect.js";
import { createFakeHost, type FakeHost, type FakeHostOptions } from "../fake-host.js";
import { serveFakeHost, type FakeSocket } from "./socket.js";

const MANIFEST = {
  id: "agents",
  name: "Agents",
  version: "0.1.0",
  hostApi: 0,
  capabilities: ["project.read", "files.read", "tabs.open", "agentTabs.read", "agentTabs.write"],
  strip: [
    { id: "sessions", title: "Sessions", action: "both", route: "sessions" },
    { id: "live", title: "Live", action: "panel", route: "live" },
  ],
  api: ["sessions.last"],
  events: { subscribe: ["project.changed", "project.renamed"], publish: ["indexed"] },
  backend: { entry: "backend/main.mjs", mode: "always-on" },
  commands: [{ name: "agents-cli", entry: "bin/agents.mjs" }],
};

const PROJECTS = [
  { id: "alpha", name: "Alpha", root: "Projects/alpha" },
  { id: "beta", name: "Beta", root: "Projects/beta" },
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function serve(options: FakeHostOptions = {}, helloTimeoutMs?: number): Promise<{ fake: FakeHost; server: FakeSocket; userData: string }> {
  const userData = mkdtempSync("/tmp/pk-fs-");
  cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
  const fake = createFakeHost({ manifest: MANIFEST, projects: PROJECTS, activeProject: "alpha", files: { "Projects/alpha/a.md": "a\n" }, ...options });
  const server = await serveFakeHost(fake, { userData, ...(helloTimeoutMs !== undefined ? { helloTimeoutMs } : {}) });
  cleanups.push(() => server.close());
  return { fake, server, userData };
}

async function client(server: FakeSocket, role: "backend" | "command" = "backend"): Promise<HostClient> {
  const r = await connectSocket({ env: server.env(role), timeoutMs: 2000 });
  if (r.status !== "connected") throw new Error(`not connected: ${JSON.stringify(r)}`);
  cleanups.push(() => r.host.close());
  return r.host;
}

async function frame(fake: FakeHost): Promise<HostClient> {
  const r = await connect({ transport: fake.createTransport({ surface: "panel", icon: "live" }), keySource: null });
  if (r.status !== "connected") throw new Error(`frame not connected: ${r.status}`);
  return r.host;
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A raw socket connection: lines in, lines out. */
async function rawConnection(path: string): Promise<{ socket: Socket; send(m: unknown): void; next(): Promise<Record<string, unknown>>; closed: Promise<void> }> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  cleanups.push(() => void socket.destroy());
  const decoder = createLineDecoder();
  const queue: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    for (const m of decoder.push(chunk) as Record<string, unknown>[]) {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    }
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    socket,
    send: (m) => socket.write(encodeLine(m)),
    next: () => {
      const m = queue.shift();
      return m ? Promise.resolve(m) : new Promise((resolve) => waiters.push(resolve));
    },
    closed,
  };
}

describe("serveFakeHost: the socket and the key", () => {
  it("listens at <userData>/run/pomade.sock and issues the app's key at <userData>/app-keys/<id>, 0600 in a 0700 folder", async () => {
    const { server, userData } = await serve({ workspaceRoot: "/ws/root" });
    expect(server.socketPath).toBe(`${userData}/run/pomade.sock`);
    expect(server.keyFile).toBe(`${userData}/app-keys/agents`);
    expect(server.key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(server.keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(`${userData}/app-keys`).mode & 0o777).toBe(0o700);
    expect(statSync(`${userData}/run`).mode & 0o777).toBe(0o700);
    expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);
    expect(server.env()).toEqual({
      POMADE_APP_ID: "agents",
      POMADE_APP_KEY_FILE: server.keyFile,
      POMADE_CLIENT: "backend",
      POMADE_SOCKET: server.socketPath,
      POMADE_WORKSPACE: "/ws/root",
      POMADE_KEEPER_SOCKET: `${userData}/run/keepers/agents.sock`,
    });
    expect(server.env("command")).not.toHaveProperty("POMADE_KEEPER_SOCKET");
    expect(server.env("command").POMADE_CLIENT).toBe("command");
  });

  it("keeps a key already issued under the user data", async () => {
    const first = await serve();
    const userData = first.userData;
    await first.server.close();
    const again = await serveFakeHost(first.fake, { userData });
    cleanups.push(() => again.close());
    expect(again.key).toBe(first.server.key);
  });

  it("refuses a socket path longer than macOS allows", async () => {
    const fake = createFakeHost({ manifest: MANIFEST });
    await expect(serveFakeHost(fake, { userData: `/tmp/${"x".repeat(100)}` })).rejects.toThrow(/macOS allows at most 103/);
  });
});

describe("handshake", () => {
  it("welcomes a backend and a command with their role, route \"\", no icon and the active project", async () => {
    const { server } = await serve();
    const backend = await client(server);
    expect(backend.welcome).toEqual({
      hostApi: 0,
      pomadeVersion: "0.0.0-fake",
      appId: "agents",
      surface: "backend",
      route: "",
      project: { id: "alpha", kind: "project", name: "Alpha", root: "Projects/alpha" },
      theme: "light",
    });
    const command = await client(server, "command");
    expect(command.welcome.surface).toBe("command");
    expect(await backend.info()).toEqual({ pomadeVersion: "0.0.0-fake", hostApi: 0, appId: "agents", surface: "backend", route: "", skills: [] });
    expect(server.clients()).toEqual([{ role: "backend" }, { role: "command" }]);
    command.close();
    await until(() => server.clients().length === 1, "the command to go");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a wrong key", { key: "not-the-key" }],
    ["another app's id", { appId: "planner" }],
    ["Pomade's platform client (the fake hosts one app)", { appId: "pomade", role: "command" }],
  ])("refuses %s as unauthorized", async (_label, override) => {
    const { server } = await serve();
    const r = await connectSocket({ env: server.env(), timeoutMs: 2000, ...override });
    expect(r).toEqual({ status: "rejected", reason: "unauthorized", hostApi: 0 });
  });

  it("refuses a role the manifest does not have: a backend without `backend`, a command without `commands`", async () => {
    const { server } = await serve({ manifest: { ...MANIFEST, backend: undefined, commands: undefined } });
    expect(await connectSocket({ env: server.env("backend"), timeoutMs: 2000 })).toMatchObject({ status: "rejected", reason: "unauthorized" });
    expect(await connectSocket({ env: server.env("command"), timeoutMs: 2000 })).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  it("refuses a hello without an identity, and checks the version first", async () => {
    const { server } = await serve();
    const c = await rawConnection(server.socketPath);
    c.send({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(await c.next()).toEqual({ channel: "pomade", type: "reject", reason: "unauthorized", hostApi: 0 });
    c.send({ channel: "pomade", type: "hello", hostApi: 1, client: { appId: "nope", key: "x", role: "backend" } });
    expect(await c.next()).toEqual({ channel: "pomade", type: "reject", reason: "needs-newer-pomade", hostApi: 0 });
    // The connection stays open: a right hello is welcomed.
    c.send({ channel: "pomade", type: "hello", hostApi: 0, client: { appId: "agents", key: server.key, role: "backend" } });
    expect(await c.next()).toMatchObject({ type: "welcome", surface: "backend" });
  });

  it("a removed key file revokes the key: the next hello is refused", async () => {
    const { server } = await serve();
    unlinkSync(server.keyFile);
    const r = await connectSocket({ env: server.env(), key: server.key, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: "rejected", reason: "unauthorized" });
  });

  it("answers a call before welcome with not-ready, and handles a call sent right after hello once welcomed", async () => {
    const { server } = await serve();
    const c = await rawConnection(server.socketPath);
    c.send({ channel: "pomade", type: "call", id: "1", method: "project.getActive" });
    expect(await c.next()).toMatchObject({ type: "result", id: "1", ok: false, error: { code: "not-ready" } });
    c.send({ channel: "pomade", type: "hello", hostApi: 0, client: { appId: "agents", key: server.key, role: "backend" } });
    c.send({ channel: "pomade", type: "call", id: "2", method: "project.getActive" });
    expect(await c.next()).toMatchObject({ type: "welcome" });
    expect(await c.next()).toMatchObject({ type: "result", id: "2", ok: true, value: { id: "alpha" } });
  });

  it("closes a connection that is not welcomed in time", async () => {
    const { server } = await serve({}, 100);
    const c = await rawConnection(server.socketPath);
    await c.closed;
    expect(c.socket.destroyed).toBe(true);
  });

  it("closes a connection that sends a line longer than 16 MiB", async () => {
    const { server } = await serve();
    const c = await rawConnection(server.socketPath);
    c.socket.write("x".repeat(16 * 1024 * 1024 + 1));
    await c.closed;
  });
});

describe("a socket session", () => {
  it("hears only the events it subscribes to: project.changed too", async () => {
    const { fake, server } = await serve();
    const c = await rawConnection(server.socketPath);
    c.send({ channel: "pomade", type: "hello", hostApi: 0, client: { appId: "agents", key: server.key, role: "backend" } });
    expect(await c.next()).toMatchObject({ type: "welcome" });
    fake.setActiveProject("beta");
    c.send({ channel: "pomade", type: "call", id: "1", method: "events.subscribe", params: { name: "project.changed" } });
    // The switch before the subscription sent nothing: the next line is the call's result.
    expect(await c.next()).toEqual({ channel: "pomade", type: "result", id: "1", ok: true, value: {} });
    fake.setActiveProject("alpha");
    expect(await c.next()).toMatchObject({ type: "event", name: "project.changed", payload: { id: "alpha" } });
    expect(fake.subscriptions).toEqual(["project.changed"]);
  });

  it("is in no project: tabs, agent tabs and notices default to the Workspace scope", async () => {
    const { fake, server } = await serve();
    const backend = await client(server);
    await backend.tabs.openFile({ path: "Projects/alpha/a.md" });
    expect(fake.openedTabs.at(-1)).toEqual({ kind: "file", projectId: "__workspace__", path: "Projects/alpha/a.md" });
    expect(fake.activeProject.id).toBe("__workspace__");
    fake.setActiveProject("alpha");
    await backend.tabs.openApp({ route: "today" });
    expect(fake.appTabs).toEqual([{ tabId: "app-tab-1", projectId: "__workspace__", route: "today" }]);
    const { tabId } = await backend.agentTabs.launch({ agentId: "claude" });
    expect(fake.agentTabs.find((t) => t.tabId === tabId)?.projectId).toBe("__workspace__");
    fake.setActiveProject("alpha");
    await backend.notices.post({ title: "Indexed", action: { kind: "openApp", route: "sessions" } });
    fake.clickNotice();
    expect(fake.appTabs.at(-1)).toEqual({ tabId: "app-tab-2", projectId: "__workspace__", icon: "sessions", route: "sessions" });
    // A named project is used as given.
    await backend.tabs.openApp({ route: "today", projectId: "beta" });
    expect(fake.activeProject.id).toBe("beta");
  });

  it("is refused the frame-only methods", async () => {
    const { server } = await serve({ manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "git.read"] } });
    const backend = await client(server);
    for (const call of [() => backend.files.pickFolder(), () => backend.git.watch({}, () => undefined), () => backend.overlay.open()]) {
      await expect(call()).rejects.toMatchObject({ code: "capability-denied" });
    }
  });

  it("keeps its capabilities: what the manifest does not grant is denied", async () => {
    const { server } = await serve();
    const backend = await client(server);
    await expect(backend.files.write({ path: "Projects/alpha/b.md", content: "" })).rejects.toMatchObject({ code: "capability-denied" });
    expect(await backend.files.readFile({ path: "Projects/alpha/a.md" })).toMatchObject({ content: "a\n" });
  });
});

describe("the broker", () => {
  it("carries a frame's apps.call to the serving backend and its answer back, with the caller", async () => {
    const { fake, server } = await serve();
    const backend = await client(server);
    const seen: string[] = [];
    await backend.api.serve({
      "sessions.last": (params, { from }) => {
        seen.push(from);
        return { cwd: (params as { cwd: string }).cwd, from };
      },
    });
    const ui = await frame(fake);
    expect(await ui.apps.call("agents", "sessions.last", { cwd: "/x" })).toEqual({ cwd: "/x", from: "agents" });
    expect(await fake.callApi("sessions.last", { cwd: "/y" })).toEqual({ cwd: "/y", from: "pomade" });
    expect(seen).toEqual(["agents", "pomade"]);
  });

  it("prefers the backend over a frame that serves, whichever served last", async () => {
    const { fake, server } = await serve();
    const backend = await client(server);
    await backend.api.serve({ "sessions.last": () => "backend" });
    const ui = await frame(fake);
    await ui.api.serve({ "sessions.last": () => "frame" });
    expect(await fake.callApi("sessions.last")).toBe("backend");
    backend.close();
    await until(() => server.clients().length === 0, "the backend to go");
    expect(await fake.callApi("sessions.last")).toBe("frame");
  });

  it("a handler's HostError reaches the caller as given; a backend that goes away answers app-not-responding, then app-absent", async () => {
    const { fake, server } = await serve();
    const backend = await client(server);
    let answer: ((v: JsonValue) => void) | null = null;
    await backend.api.serve({
      "sessions.last": (params) => {
        if ((params as { fail?: boolean }).fail) throw new HostError("not-found", "no session");
        return new Promise<JsonValue>((resolve) => (answer = resolve));
      },
    });
    await expect(fake.callApi("sessions.last", { fail: true })).rejects.toMatchObject({ code: "not-found", message: "no session" });
    const pending = fake.callApi("sessions.last");
    await until(() => answer !== null, "the request");
    backend.close();
    await expect(pending).rejects.toMatchObject({ code: "app-not-responding" });
    await expect(fake.callApi("sessions.last")).rejects.toMatchObject({ code: "app-absent" });
  });
});

describe("lifetime", () => {
  it("close(): every client sees its channel end, the socket file goes, a stayConnected backend reconnects when the fake is back", async () => {
    const { fake, server, userData } = await serve();
    const connects: string[] = [];
    let disconnects = 0;
    const keeper = stayConnected(
      { env: server.env(), minDelayMs: 20, maxDelayMs: 50 },
      { onConnect: (host) => void connects.push(host.welcome.surface), onDisconnect: () => disconnects++ },
    );
    cleanups.push(() => keeper.stop());
    await until(() => server.clients().length === 1, "the backend");
    await server.close();
    expect(existsSync(server.socketPath)).toBe(false);
    await until(() => disconnects === 1, "the disconnect");
    const again = await serveFakeHost(fake, { userData });
    cleanups.push(() => again.close());
    await until(() => again.clients().length === 1, "the reconnect");
    expect(connects).toEqual(["backend", "backend"]);
  });
});
