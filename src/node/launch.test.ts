import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // A stuck "Pomade" the test did not get to record (it failed first) goes too.
  try {
    const p = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { main: number; helper: number };
    pids.push(p.main, p.helper);
  } catch {
    /* none started */
  }
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
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual({ runAsNode: null, mark: "m1" });
    r.host.close();
    // Running now: no second launch.
    const again = await launchPomade({ env: env(), key: "k" });
    expect(again).toMatchObject({ status: "connected", launched: false });
    if (again.status === "connected") again.host.close();
  });

  it("fails without a host record", async () => {
    await expect(launchPomade({ env: env(), key: "k" })).resolves.toMatchObject({ status: "failed", reason: expect.stringMatching(/no host.json/) });
  });

  it("a launch that never gets ready is stopped with what it started: SIGTERM to its group first", async () => {
    record([process.execPath, join(dir, "stuck.cjs"), join(dir, "pids.json")]);
    const r = await launchPomade({ env: env(), key: "k", readyTimeoutMs: 1500, pollMs: 50 });
    expect(r).toEqual({ status: "failed", reason: "Pomade did not become ready in time; the process it started was stopped" });
    const { main, helper } = started();
    // Gone (an orphan's zombie is reaped by launchd a moment later).
    await expect.poll(() => [alive(main), alive(helper)], { timeout: 2000 }).toEqual([false, false]);
    expect(readFileSync(join(dir, "term.txt"), "utf8")).toBe("SIGTERM");
  });

  it("one that ignores SIGTERM is killed after stopGraceMs", async () => {
    record([process.execPath, join(dir, "stuck.cjs"), join(dir, "pids.json"), "ignore-term"]);
    const t0 = Date.now();
    const r = await launchPomade({ env: env(), key: "k", readyTimeoutMs: 1500, pollMs: 50, stopGraceMs: 300 });
    expect(r).toMatchObject({ status: "failed" });
    expect(Date.now() - t0).toBeLessThan(4000);
    const { main, helper } = started();
    // Gone (an orphan's zombie is reaped by launchd a moment later).
    await expect.poll(() => [alive(main), alive(helper)], { timeout: 2000 }).toEqual([false, false]);
  });

  it("fails at once when the launch exits before Pomade answers, or cannot start", async () => {
    record([process.execPath, "-e", "process.exit(3)"]);
    const t0 = Date.now();
    await expect(launchPomade({ env: env(), key: "k", readyTimeoutMs: 20000, pollMs: 50 })).resolves.toEqual({
      status: "failed",
      reason: "Pomade exited before Pomade was ready (code 3)",
    });
    record([join(dir, "no-such-pomade")]);
    await expect(launchPomade({ env: env(), key: "k", readyTimeoutMs: 20000, pollMs: 50 })).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/^could not launch Pomade: .*ENOENT/),
    });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

/** A "Pomade" that never listens: it starts a helper in its own process group, records both pids,
 *  and records the SIGTERM it gets (and, with `ignore-term`, ignores it). */
const STUCK_POMADE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => {
  fs.writeFileSync(path.join(path.dirname(process.argv[2]), "term.txt"), "SIGTERM");
  if (process.argv[3] !== "ignore-term") process.exit(0);
});
fs.writeFileSync(process.argv[2], JSON.stringify({ main: process.pid, helper: helper.pid }));
setInterval(() => {}, 1000);
`;

function record(argv: string[]): void {
  writeFileSync(join(dir, "stuck.cjs"), STUCK_POMADE);
  writeFileSync(join(dir, "host.json"), JSON.stringify({ socket: join(dir, "none.sock"), launch: { argv, env: {} } }));
}

function started(): { main: number; helper: number } {
  const p = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { main: number; helper: number };
  pids.push(p.main, p.helper);
  return p;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
