import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchPomade } from "./index.js";

let dir: string;
const pids: number[] = [];

/** A stand-in "Pomade": listens on the socket and welcomes every hello. Records its env. */
const FAKE_POMADE = `
const net = require("node:net");
const fs = require("node:fs");
fs.writeFileSync(process.argv[3], JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, mark: process.env.FAKE_MARK ?? null }));
setTimeout(() => {
  net.createServer((s) => {
    s.setEncoding("utf8");
    s.on("data", () => s.write(JSON.stringify({ channel: "pomade", type: "welcome", hostApi: 0, pomadeVersion: "1.0.0", appId: "a1", surface: "backend", route: "", project: { id: "__workspace__", kind: "workspace", name: "Workspace", root: "" } }) + "\\n"));
  }).listen(process.argv[2]);
}, 300);
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-launch-"));
  writeFileSync(join(dir, "fake-pomade.cjs"), FAKE_POMADE);
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ POMADE_HOME: dir, POMADE_APP_ID: "a1", ELECTRON_RUN_AS_NODE: "1" });

describe("launchPomade", () => {
  it("launches Pomade as recorded, without Node mode, and waits for the handshake", async () => {
    const sock = join(dir, "p.sock");
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({ socket: sock, launch: { argv: [process.execPath, join(dir, "fake-pomade.cjs"), sock, join(dir, "seen.json")], env: { FAKE_MARK: "m1" } } }),
    );
    const r = await launchPomade({ env: env(), key: "k", readyTimeoutMs: 10000, pollMs: 50 });
    expect(r.status).toBe("connected");
    if (r.status !== "connected") return;
    if (r.pid) pids.push(r.pid);
    expect(r.launched).toBe(true);
    expect(typeof r.pid).toBe("number");
    expect(r.host.welcome.surface).toBe("backend");
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual({ runAsNode: null, mark: "m1" });
    r.host.close();
    // Running now: no second launch.
    const again = await launchPomade({ env: env(), key: "k" });
    expect(again).toMatchObject({ status: "connected", launched: false });
    if (again.status === "connected") again.host.close();
  });

  it("fails without a host record, and when Pomade never answers", async () => {
    await expect(launchPomade({ env: env(), key: "k" })).resolves.toMatchObject({ status: "failed", reason: expect.stringMatching(/no host.json/) });
    writeFileSync(join(dir, "host.json"), JSON.stringify({ socket: join(dir, "none.sock"), launch: { argv: ["/usr/bin/true"], env: {} } }));
    await expect(launchPomade({ env: env(), key: "k", readyTimeoutMs: 300, pollMs: 50 })).resolves.toEqual({
      status: "failed",
      reason: "Pomade did not become ready in time",
    });
  });
});
