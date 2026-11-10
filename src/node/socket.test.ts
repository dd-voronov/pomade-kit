import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLineDecoder, encodeLine, type HelloMessage } from "../protocol/index.js";
import { connectSocket, stayConnected } from "./index.js";

const PROJECT = { id: "__workspace__", kind: "workspace", name: "Workspace", root: "" };

let dir: string;
let sockPath: string;
let server: Server | null = null;
let sockets: Socket[] = [];
let hellos: HelloMessage[] = [];

/** A minimal host: answers hello with welcome (or a scripted reject), echoes calls. */
function listen(answer: (hello: HelloMessage) => "welcome" | "unauthorized" | "silent" = () => "welcome"): Promise<void> {
  server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    const decoder = createLineDecoder();
    socket.on("data", (chunk: string) => {
      for (const m of decoder.push(chunk) as Record<string, unknown>[]) {
        if (m.type === "hello") {
          const hello = m as unknown as HelloMessage;
          hellos.push(hello);
          const verdict = answer(hello);
          if (verdict === "silent") continue;
          socket.write(
            encodeLine(
              verdict === "welcome"
                ? { channel: "pomade", type: "welcome", hostApi: 0, pomadeVersion: "9.9.9", appId: hello.client?.appId, surface: hello.client?.role, route: "", project: PROJECT }
                : { channel: "pomade", type: "reject", reason: "unauthorized", hostApi: 0 },
            ),
          );
        } else if (m.type === "call") {
          socket.write(encodeLine({ channel: "pomade", type: "result", id: m.id, ok: true, value: { echo: m.method } }));
        }
      }
    });
  });
  return new Promise((resolve) => server!.listen(sockPath, resolve));
}

function closeServer(): Promise<void> {
  for (const s of sockets) s.destroy();
  sockets = [];
  const s = server;
  server = null;
  return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-sock-"));
  sockPath = join(dir, "s.sock");
  hellos = [];
  writeFileSync(join(dir, "key"), "secret-key\n");
});
afterEach(async () => {
  await closeServer();
  rmSync(dir, { recursive: true, force: true });
});

const ENV = (): Record<string, string> => ({
  POMADE_SOCKET: sockPath,
  POMADE_APP_ID: "pomade-agents",
  POMADE_APP_KEY_FILE: join(dir, "key"),
  POMADE_CLIENT: "backend",
  POMADE_HOME: dir,
});

describe("connectSocket", () => {
  it("sends hello with the identity from the environment and gets a typed client", async () => {
    await listen();
    const r = await connectSocket({ env: ENV() });
    expect(r.status).toBe("connected");
    if (r.status !== "connected") return;
    expect(hellos).toEqual([
      { channel: "pomade", type: "hello", hostApi: 0, client: { appId: "pomade-agents", key: "secret-key", role: "backend" } },
    ]);
    expect(r.host.welcome).toEqual({ hostApi: 0, pomadeVersion: "9.9.9", appId: "pomade-agents", surface: "backend", route: "", project: PROJECT });
    await expect(r.host.info()).resolves.toEqual({ echo: "host.info" });
    r.host.close();
  });

  it("options win over the environment; the socket path can come from the host record", async () => {
    await listen();
    writeFileSync(join(dir, "host.json"), JSON.stringify({ socket: sockPath, launch: { argv: ["/x"], env: {} } }));
    const r = await connectSocket({ env: { POMADE_HOME: dir }, appId: "pomade-planner", key: "k2", role: "command" });
    expect(r.status).toBe("connected");
    expect(hellos[0]?.client).toEqual({ appId: "pomade-planner", key: "k2", role: "command" });
    if (r.status === "connected") r.host.close();
  });

  it("not-running when nothing listens, or nothing is recorded", async () => {
    await expect(connectSocket({ env: ENV() })).resolves.toEqual({ status: "not-running", reason: "ENOENT" });
    await expect(connectSocket({ env: { ...ENV(), POMADE_SOCKET: "" } })).resolves.toEqual({
      status: "not-running",
      reason: "no Pomade socket is recorded",
    });
  });

  it("not-running when Pomade does not answer in time", async () => {
    await listen(() => "silent");
    await expect(connectSocket({ env: ENV(), timeoutMs: 100 })).resolves.toEqual({ status: "not-running", reason: "Pomade did not answer" });
  });

  it("rejected: unauthorized", async () => {
    await listen(() => "unauthorized");
    await expect(connectSocket({ env: ENV() })).resolves.toEqual({ status: "rejected", reason: "unauthorized", hostApi: 0 });
  });

  it("throws when the identity is not configured", () => {
    expect(() => connectSocket({ env: { POMADE_SOCKET: sockPath } })).toThrow(/no app id — set POMADE_APP_ID/);
    expect(() => connectSocket({ env: { POMADE_SOCKET: sockPath, POMADE_APP_ID: "a1" } })).toThrow(/no key file — set POMADE_APP_KEY_FILE/);
    expect(() => connectSocket({ env: { ...ENV(), POMADE_CLIENT: "tab" } })).toThrow(/POMADE_CLIENT must be one of backend, command/);
  });

  it("the client closes when Pomade goes away; pending calls reject", async () => {
    await listen();
    const r = await connectSocket({ env: ENV() });
    if (r.status !== "connected") throw new Error(r.status);
    const closed = new Promise<void>((resolve) => r.host.onClose(resolve));
    await closeServer();
    await closed;
    await expect(r.host.info()).rejects.toThrow(/client is closed/);
  });
});

describe("stayConnected", () => {
  it("connects once Pomade is up, and reconnects after it restarts", async () => {
    const events: string[] = [];
    const keeper = stayConnected(
      { env: ENV(), minDelayMs: 20, maxDelayMs: 40 },
      { onConnect: (host) => events.push(`connect ${host.welcome.appId}`), onDisconnect: () => events.push("disconnect") },
    );
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(events).toEqual([]);
      await listen();
      await expect.poll(() => events).toEqual(["connect pomade-agents"]);
      await closeServer();
      await expect.poll(() => events).toEqual(["connect pomade-agents", "disconnect"]);
      await listen();
      await expect.poll(() => events).toEqual(["connect pomade-agents", "disconnect", "connect pomade-agents"]);
    } finally {
      keeper.stop();
    }
  });

  it("reports a rejection and keeps trying", async () => {
    await listen(() => "unauthorized");
    const rejected: string[] = [];
    const keeper = stayConnected({ env: ENV(), minDelayMs: 10, maxDelayMs: 20 }, { onConnect: () => undefined, onRejected: (r) => rejected.push(r) });
    try {
      await expect.poll(() => rejected.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rejected)).toEqual(new Set(["unauthorized"]));
    } finally {
      keeper.stop();
    }
  });
});

describe("stayConnected and a missing key file", () => {
  it("keeps retrying until the key file appears", async () => {
    await listen();
    const keyFile = join(dir, "late-key");
    const connected: string[] = [];
    const keeper = stayConnected({ env: { ...ENV(), POMADE_APP_KEY_FILE: keyFile }, minDelayMs: 10, maxDelayMs: 20 }, { onConnect: (h) => connected.push(h.welcome.appId) });
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(connected).toEqual([]);
      writeFileSync(keyFile, "k\n");
      await expect.poll(() => connected).toEqual(["pomade-agents"]);
    } finally {
      keeper.stop();
    }
  });
});
