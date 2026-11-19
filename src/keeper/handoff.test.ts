// Keepers as processes (the built library): an update hands the PTYs to a new keeper with no byte
// lost or doubled under a flood; sessions, screens and exit reasons survive it; a failed update
// leaves the old keeper serving; a keeper crash ends its sessions and the next keeper reports them,
// killing what outlived it;
// `followSession` and `startKeeper`.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionExit } from "../protocol/index.js";
import { connectKeeper, followSession, startKeeper } from "../node/keeper.js";
import { runKeeper } from "./keeper.js";
import { ENTRY, FIXTURES, TEST_ENV, connect, isAliveForTest, keeperProcess, killKeepers, onCleanup, sleep, tmpDir, track, waitFor } from "./test-helpers.js";

const readOr = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

async function upgradeTo(socketPath: string, stateDir: string, version: string, entry = ENTRY): Promise<number> {
  const before = await connect(socketPath);
  const oldPid = before.k.keeper.pid;
  await before.k.upgrade(entry, [version]);
  const pid = await waitFor(async () => {
    const r = await connectKeeper({ socketPath, app: "test", timeoutMs: 500 });
    if (r.status !== "connected") return 0;
    r.keeper.close();
    return r.keeper.keeper.pid !== oldPid ? r.keeper.keeper.pid : 0;
  }, "the new keeper");
  track(stateDir, "keeper", pid);
  return pid;
}

/** The lines of a counting flood: 1, 2, 3, … — the gaps and repeats in them. Lines end in CR LF,
 *  and the PTY's own output processing now and then adds a second CR under a flood (macOS): the
 *  CRs are the terminal's, not the program's bytes, so any number of them ends a line. */
function countingProblems(text: string): { last: number; gaps: number; repeats: number } {
  const lines = text.split(/\r*\n/).filter((l) => /^\d+$/.test(l));
  lines.pop(); // the program was stopped mid-line
  let prev = 0;
  let gaps = 0;
  let repeats = 0;
  for (const l of lines) {
    if (!/^\d+$/.test(l)) continue;
    const n = Number(l);
    if (n === prev + 1) prev = n;
    else if (n <= prev) repeats++;
    else {
      gaps++;
      prev = n;
    }
  }
  return { last: prev, gaps, repeats };
}

describe("keeper update (fd hand-off)", { timeout: 30_000 }, () => {
  it("hands the sessions to a new keeper twice under a flood: no byte lost or doubled, in the log or at the client", async () => {
    const { socketPath, stateDir, dir } = await keeperProcess({ KEEPER_TEST_RING: String(256 * 1024 * 1024) });
    const owner = await connect(socketPath);
    const log = join(dir, "flood.log");
    const s = await owner.k.spawn({ id: "flood", title: "flood", argv: ["/usr/bin/awk", "BEGIN { for (i = 1; ; i++) print i }"], cwd: dir, log });
    track(stateDir, "session", s.pid);
    let seen = "";
    let snapshots = 0;
    const follower = followSession(
      { socketPath, app: "pomade", session: "flood", minDelayMs: 20 },
      {
        onSnapshot: () => snapshots++,
        onDelta: (d) => (seen += d),
        onOutput: (d) => (seen += d),
      },
    );
    await waitFor(() => follower.state.kind === "attached", "the follower to attach");
    await sleep(400);
    await upgradeTo(socketPath, stateDir, "v2");
    await sleep(400);
    await upgradeTo(socketPath, stateDir, "v3");
    await waitFor(() => follower.state.kind === "attached", "the follower to reattach");
    await sleep(400);
    const owner3 = await connect(socketPath);
    await owner3.k.stop("flood");
    await waitFor(async () => (await owner3.k.list())[0]?.state === "exited", "the flood to stop");
    follower.close();

    const fromLog = countingProblems(readFileSync(log, "utf8"));
    expect(fromLog.last).toBeGreaterThan(10000);
    expect(fromLog).toMatchObject({ gaps: 0, repeats: 0 });
    // The follower attached once (snapshot), then resumed twice from what it had seen (delta).
    expect(snapshots).toBe(1);
    const fromClient = countingProblems(seen);
    expect(fromClient).toMatchObject({ gaps: 0, repeats: 0 });
    expect(fromClient.last).toBeGreaterThan(fromLog.last - 100000);
  });

  it("adopted sessions keep their screen, input, resize and exit reasons", async () => {
    const { socketPath, stateDir, dir } = await keeperProcess();
    const owner = await connect(socketPath);
    const spawn = async (id: string, command: string): Promise<void> => {
      const s = await owner.k.spawn({ id, title: id, command, cwd: dir, cols: 80, rows: 24 });
      track(stateDir, "session", s.pid);
    };
    await spawn("echo", "echo before-update; while read l; do echo \"got:$l\"; done");
    await spawn("winch", "trap 'echo \"size $(stty size)\"' WINCH; while :; do sleep 0.1; done");
    await spawn("ctrlc", "sleep 60");
    await spawn("killed", "echo $$ > killed.pid; exec sleep 60");
    await spawn("clean", "read l; exit 0");
    await sleep(500);
    const oldPid = owner.k.keeper.pid;
    await upgradeTo(socketPath, stateDir, "v2");
    await waitFor(() => !isAliveForTest(oldPid), "the old keeper to exit");

    const c = await connect(socketPath, "viewer");
    const listed = await c.k.list();
    expect(listed.map((x) => x.state)).toEqual(["running", "running", "running", "running", "running"]);
    for (const id of ["echo", "winch", "ctrlc", "killed", "clean"]) await c.k.attach(id);
    const snap = c.events.find((e) => e.type === "snapshot" && e.session === "echo");
    expect(snap && "data" in snap ? snap.data : "").toContain("before-update");
    c.k.input("echo", "after\r");
    await waitFor(() => c.output("echo").includes("got:after"), "input on an adopted session");
    c.k.resize("winch", 100, 30);
    await waitFor(() => c.output("winch").includes("size 30 100"), "resize on an adopted session");

    c.k.input("ctrlc", "\x03");
    const killedPid = Number(readFileSync(join(dir, "killed.pid"), "utf8").trim());
    process.kill(killedPid, "SIGKILL");
    c.k.input("clean", "x\r");
    const exits = await waitFor(() => {
      const all = ["ctrlc", "killed", "clean"].map((id) => c.exitOf(id));
      return all.every(Boolean) ? (all as SessionExit[]) : null;
    }, "three exits");
    expect(exits[0]).toMatchObject({ reason: "stopped-by-you", code: 130 });
    expect(exits[1]).toMatchObject({ reason: "crashed", code: 137, signal: "SIGKILL" });
    expect(exits[2]).toMatchObject({ reason: "exited", code: 0 });
  });

  it("an update whose new keeper never answers leaves the old keeper serving the same sessions", async () => {
    const { socketPath, stateDir, dir } = await keeperProcess();
    const owner = await connect(socketPath);
    const s = await owner.k.spawn({ id: "svc", title: "svc", command: "while read l; do echo \"got:$l\"; done", cwd: dir });
    track(stateDir, "session", s.pid);
    const pid = owner.k.keeper.pid;
    await owner.k.upgrade(join(FIXTURES, "broken-entry.mjs"));
    const back = await waitFor(async () => {
      const r = await connectKeeper({ socketPath, app: "test", timeoutMs: 500 });
      if (r.status !== "connected") return null;
      r.keeper.close();
      return r.keeper.keeper.pid;
    }, "the keeper to serve again");
    expect(back).toBe(pid);
    const c = await connect(socketPath, "viewer");
    await c.k.attach("svc");
    c.k.input("svc", "still\r");
    await waitFor(() => c.output("svc").includes("got:still"), "the session to answer");
  });
});

describe("keeper crash", { timeout: 30_000 }, () => {
  it("a killed keeper takes its sessions down; the next keeper reports them lost-in-keeper-crash", async () => {
    const dir = tmpDir();
    const first = await keeperProcess({}, dir);
    const owner = await connect(first.socketPath);
    const s = await owner.k.spawn({ id: "svc", title: "Coda web", command: "sleep 60", cwd: dir });
    track(first.stateDir, "session", s.pid);
    killKeepers(first.stateDir);
    await waitFor(() => !isAliveForTest(s.pid ?? 0), "the session to end with its keeper", 3000);
    await keeperProcess({}, dir);
    const c = await connect(first.socketPath, "viewer");
    expect(await c.k.list()).toMatchObject([{ id: "svc", title: "Coda web", state: "exited", exit: { reason: "lost-in-keeper-crash" } }]);
  });

  it("what outlives a killed keeper — a program ignoring the hang-up, with its group — is killed when the next keeper starts", async () => {
    const dir = tmpDir();
    const first = await keeperProcess({}, dir);
    const owner = await connect(first.socketPath);
    const s = await owner.k.spawn({ id: "svc", title: "svc", command: "trap '' HUP; sleep 61 & echo $! > bg; sleep 60", cwd: dir });
    track(first.stateDir, "session", s.pid);
    const bg = Number(await waitFor(() => readOr(join(dir, "bg")).trim(), "the background pid"));
    process.kill(first.child.pid ?? 0, "SIGKILL");
    await sleep(500);
    expect([isAliveForTest(s.pid ?? 0), isAliveForTest(bg)]).toEqual([true, true]);
    await keeperProcess({}, dir);
    await waitFor(() => !isAliveForTest(s.pid ?? 0) && !isAliveForTest(bg), "the session's group to be killed", 3000);
    const c = await connect(first.socketPath, "viewer");
    expect(await c.k.list()).toMatchObject([{ id: "svc", state: "exited", exit: { reason: "lost-in-keeper-crash", signal: "SIGKILL" } }]);
  });

  it("a keeper refuses to start while the keeper recorded for its state folder still runs, and kills nothing", async () => {
    const dir = tmpDir();
    const first = await keeperProcess({}, dir);
    const owner = await connect(first.socketPath);
    const s = await owner.k.spawn({ id: "svc", title: "svc", command: "sleep 60", cwd: dir });
    track(first.stateDir, "session", s.pid);
    // As during an update: the old keeper still runs, its socket file is gone.
    rmSync(first.socketPath, { force: true });
    await expect(
      runKeeper({ app: "hello", socketPath: first.socketPath, stateDir: first.stateDir, ownerKey: null, env: TEST_ENV, log: () => undefined }),
    ).rejects.toThrow(/still runs/);
    expect(isAliveForTest(s.pid ?? 0)).toBe(true);
  });
});

describe("followSession and startKeeper", { timeout: 30_000 }, () => {
  it("startKeeper starts the keeper once, detached, and reports it running afterwards", async () => {
    const dir = tmpDir();
    const socketPath = join(dir, "k.sock");
    const stateDir = join(dir, "state");
    const env = { ...TEST_ENV, POMADE_APP_ID: "hello", KEEPER_TEST_STATE: stateDir };
    onCleanup(() => killKeepers(stateDir));
    const started = await startKeeper({ entry: ENTRY, socketPath, env, logFile: join(dir, "keeper.out") });
    expect(started).toMatchObject({ status: "running", started: true });
    if (started.status === "running") track(stateDir, "keeper", started.pid);
    const again = await startKeeper({ entry: ENTRY, socketPath, env });
    expect(again).toEqual(started.status === "running" ? { status: "running", started: false, pid: started.pid } : again);
    const tooLong = await startKeeper({ entry: ENTRY, socketPath: join(dir, "y".repeat(120), "k.sock"), env });
    expect(tooLong).toMatchObject({ status: "failed" });
    expect(tooLong.status === "failed" ? tooLong.reason : "").toMatch(/at most 103/);
  });

  it("followSession reports gone for an unknown session and unreachable without a keeper, and attaches when it appears", async () => {
    const dir = tmpDir();
    const socketPath = join(dir, "k.sock");
    const states: string[] = [];
    const follower = followSession({ socketPath, app: "pomade", session: "later", minDelayMs: 20, maxDelayMs: 100 }, { onState: (s) => states.push(s.kind) });
    await waitFor(() => states.includes("unreachable"), "unreachable");
    const { stateDir } = await keeperProcess({}, dir);
    await waitFor(() => states.includes("gone"), "gone");
    const owner = await connect(socketPath);
    const s = await owner.k.spawn({ id: "later", title: "later", command: "sleep 60", cwd: dir });
    track(stateDir, "session", s.pid);
    await waitFor(() => follower.state.kind === "attached", "attached once the session exists");
    follower.close();
  });
});
