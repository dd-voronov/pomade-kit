// The keeper in this process, real PTYs: sessions, attach, input and paste, resize, several
// clients, exit reasons, who may do what, terminal queries, screen fidelity, flow control, ended
// sessions, crash records and the socket rules.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTACH_PROTOCOL, type KeeperMessage, type SessionInfo } from "../protocol/index.js";
import { connectKeeper } from "../node/keeper.js";
import { runKeeper } from "./keeper.js";
import { sessionEnv } from "./env.js";
import { FIXTURES, TEST_ENV, connect, keeperInProcess, screenState, sleep, tmpDir, viewTerm, waitFor } from "./test-helpers.js";

const readOr = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const snapshots = (events: KeeperMessage[], session: string): Extract<KeeperMessage, { type: "snapshot" }>[] =>
  events.filter((e): e is Extract<KeeperMessage, { type: "snapshot" }> => e.type === "snapshot" && e.session === session);

describe("sessions and attach", () => {
  it("runs a command in the login shell, keeps earlier output for a late client, streams live output and takes input", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    const s = await owner.k.spawn({
      id: "tick",
      title: "Ticker",
      command: 'echo "shell=$0"; echo early; read line; echo "you typed: $line"; sleep 30',
      cwd: dir,
      cols: 80,
      rows: 10,
    });
    expect(s).toMatchObject({ id: "tick", title: "Ticker", state: "running", cwd: dir, cols: 80, rows: 10, exit: null });
    expect(s.pid).toBeGreaterThan(0);
    // The earlier output exists before the late client comes: the owner watches for it, then leaves.
    await owner.k.attach("tick");
    await waitFor(() => `${snapshots(owner.events, "tick")[0]?.data ?? ""}${owner.output("tick")}`.includes("early"), "the early output");
    owner.k.detach("tick");
    await waitFor(async () => (await owner.k.list())[0]?.clients === 0, "the owner to detach");

    const viewer = await connect(socketPath, "viewer");
    await viewer.k.attach("tick", { cols: 100, rows: 12 });
    const [snap] = snapshots(viewer.events, "tick");
    expect(snap?.data).toContain("shell=/bin/sh");
    expect(snap?.data).toContain("early");
    expect(snap?.info).toMatchObject({ cols: 100, rows: 12, clients: 1 });
    expect(snap?.seq).toBeGreaterThan(0);

    viewer.k.input("tick", "hello\r");
    await waitFor(() => viewer.output("tick").includes("you typed: hello"), "the echo");
    const outputs = viewer.events.filter((e): e is Extract<KeeperMessage, { type: "output" }> => e.type === "output");
    // seq counts output characters: each chunk's seq is the previous one plus its length.
    let seq = snap?.seq ?? 0;
    for (const o of outputs) {
      seq += o.data.length;
      expect(o.seq).toBe(seq);
    }
    const listed = await viewer.k.list();
    expect(listed.map((x) => x.id)).toEqual(["tick"]);
  });

  it("runs argv directly, in the folder, with the terminal environment and the spawn's env", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    await owner.k.attach("x").catch(() => undefined);
    const s = await owner.k.spawn({
      title: "env",
      argv: ["/bin/sh", "-c", 'pwd; echo "T=$TERM P=$TERM_PROGRAM L=$LANG E=$EXTRA R=${ELECTRON_RUN_AS_NODE:-unset} K=${POMADE_APP_KEY_FILE:-unset}"'],
      cwd: dir,
      env: { EXTRA: "yes" },
    });
    await owner.k.attach(s.id);
    await waitFor(() => owner.exitOf(s.id), "the exit");
    const text = snapshots(owner.events, s.id)[0]?.data + owner.output(s.id);
    expect(text).toContain(dir);
    expect(text).toContain("T=xterm-256color P=Apple_Terminal");
    expect(text).toContain("E=yes R=unset K=unset");
    expect(text).toMatch(/L=\S+UTF-8/);
    expect(owner.exitOf(s.id)).toMatchObject({ code: 0, signal: null, reason: "exited" });
  });

  it("refuses a missing folder and a running id", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    await expect(owner.k.spawn({ title: "x", command: "true", cwd: join(dir, "nope") })).rejects.toMatchObject({ code: "spawn-failed" });
    await owner.k.spawn({ id: "one", title: "x", command: "sleep 30", cwd: dir });
    await expect(owner.k.spawn({ id: "one", title: "x", command: "true", cwd: dir })).rejects.toMatchObject({ code: "session-running" });
    await expect(owner.k.attach("nope")).rejects.toMatchObject({ code: "unknown-session" });
  });

  it("starting an ended session's id again keeps its clients attached, on the new session", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    await owner.k.spawn({ id: "svc", title: "Service", command: "echo first; exit 3", cwd: dir });
    const viewer = await connect(socketPath, "viewer");
    await viewer.k.attach("svc");
    await waitFor(() => viewer.exitOf("svc"), "the first run's end");
    const again = await owner.k.spawn({ id: "svc", title: "Service", command: "echo second; sleep 30", cwd: dir });
    expect(again.state).toBe("running");
    await waitFor(() => snapshots(viewer.events, "svc").length === 2, "the new session's snapshot");
    await waitFor(() => viewer.output("svc").includes("second") || (snapshots(viewer.events, "svc")[1]?.data ?? "").includes("second"), "the new output");
    expect(snapshots(viewer.events, "svc")[1]?.info.startedAt).toBeGreaterThan(snapshots(viewer.events, "svc")[0]?.info.startedAt ?? 0);
  });
});

describe("several clients, resize, paste", () => {
  it("both clients see the same echo; a resize reaches the program and the other client", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    await owner.k.spawn({ id: "w", title: "w", command: 'trap \'echo "size $(stty size)"\' WINCH; while :; do read l && echo "echo:$l"; done', cwd: dir, cols: 80, rows: 24 });
    const a = await connect(socketPath, "viewer");
    const b = await connect(socketPath, "viewer");
    await a.k.attach("w");
    await b.k.attach("w");
    await sleep(200);
    a.k.input("w", "ping\r");
    await waitFor(() => a.output("w").includes("echo:ping") && b.output("w").includes("echo:ping"), "both clients to see the echo");
    b.k.resize("w", 120, 40);
    await waitFor(() => a.output("w").includes("size 40 120"), "the program's SIGWINCH");
    expect(a.events.some((e) => e.type === "resized" && e.cols === 120 && e.rows === 40)).toBe(true);
    expect(b.events.some((e) => e.type === "resized")).toBe(false);
    expect((await a.k.list())[0]).toMatchObject({ cols: 120, rows: 40, clients: 2 });
  });

  it("a paste is bracketed only while the program asked for it, and cannot end the bracket early", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    const log = join(dir, "stdin.log");
    // Raw mode, the bytes logged as JSON: what the program received.
    await owner.k.spawn({
      id: "p",
      title: "p",
      argv: [process.execPath, "-e", `process.stdin.setRawMode(true);process.stdin.on("data",d=>require("fs").appendFileSync(${JSON.stringify(log)},JSON.stringify(String(d))+"\\n"));process.stdout.write("ready\\n")`],
      cwd: dir,
    });
    await owner.k.attach("p");
    await waitFor(() => (snapshots(owner.events, "p")[0]?.data ?? "").includes("ready") || owner.output("p").includes("ready"), "ready");
    owner.k.paste("p", "a\nb");
    await waitFor(() => readOr(log).includes("a\\rb"), "the plain paste");
    expect(readFileSync(log, "utf8")).not.toContain("200~");
    await owner.k.spawn({
      id: "q",
      title: "q",
      argv: [process.execPath, "-e", `process.stdout.write("\\x1b[?2004h");process.stdin.setRawMode(true);process.stdin.on("data",d=>require("fs").appendFileSync(${JSON.stringify(log)},JSON.stringify(String(d))+"\\n"));process.stdout.write("armed\\n")`],
      cwd: dir,
    });
    // Bracketed paste is on once the program said so (it asks before it prints "armed").
    await owner.k.attach("q");
    await waitFor(() => `${snapshots(owner.events, "q")[0]?.data ?? ""}${owner.output("q")}`.includes("armed"), "the program to ask for bracketed paste");
    owner.k.paste("q", "x\x1b[201~y");
    await waitFor(() => readOr(log).includes("200~"), "the bracketed paste");
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string).join("");
    expect(lines).toContain("\x1b[200~xy\x1b[201~");
  });
});

describe("exit reasons", () => {
  const run = async (command: string, act?: (c: Awaited<ReturnType<typeof connect>>, id: string) => Promise<void> | void, role: "owner" | "viewer" = "owner") => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    const s = await owner.k.spawn({ title: "x", command, cwd: dir });
    const client = role === "owner" ? owner : await connect(socketPath, "viewer");
    await client.k.attach(s.id);
    await sleep(200);
    await act?.(client, s.id);
    return waitFor(() => client.exitOf(s.id), "the exit");
  };

  it("exit 0 → exited, exit 3 → crashed", async () => {
    expect(await run("exit 0")).toMatchObject({ code: 0, signal: null, reason: "exited" });
    expect(await run("exit 3")).toMatchObject({ code: 3, signal: null, reason: "crashed" });
  });

  it("Ctrl+C typed through a client, then the exit → stopped-by-you", async () => {
    expect(await run("sleep 30", (c, id) => c.k.input(id, "\x03"), "viewer")).toMatchObject({ code: 130, signal: "SIGINT", reason: "stopped-by-you" });
  });

  it("kill -9 of the program → crashed", async () => {
    expect(await run("echo $$ > pid; exec sleep 30", async (c, id) => {
      const info = (await c.k.list()).find((x) => x.id === id);
      const dir = info?.cwd ?? "";
      const pid = Number(await waitFor(() => readOr(join(dir, "pid")).trim(), "the pid"));
      process.kill(pid, "SIGKILL");
    })).toMatchObject({ code: 137, signal: "SIGKILL", reason: "crashed" });
  });

  it("Stop: a viewer's is stopped-by-you; the owner's says why", async () => {
    expect(await run("sleep 30", (c, id) => c.k.stop(id), "viewer")).toMatchObject({ reason: "stopped-by-you", code: 143, signal: "SIGTERM" });
    expect(await run("sleep 30", (c, id) => c.k.stop(id))).toMatchObject({ reason: "stopped" });
    expect(await run("sleep 30", (c, id) => c.k.stop(id, { reason: "time-limit" }))).toMatchObject({ reason: "time-limit" });
  });

  it("Stop kills a program that ignores SIGTERM after the grace period", async () => {
    const t0 = Date.now();
    const exit = await run("trap '' TERM; sleep 30", (c, id) => c.k.stop(id, { graceMs: 300 }));
    expect(exit).toMatchObject({ reason: "stopped" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("who may do what", () => {
  it("only the owner, with its key, may spawn, update, forget and upgrade", async () => {
    const { socketPath, dir } = await keeperInProcess({ ownerKey: "secret" });
    const wrong = await connectKeeper({ socketPath, app: "hello", role: "owner", key: "nope" });
    expect(wrong).toMatchObject({ status: "rejected", code: "unauthorized" });
    const otherApp = await connectKeeper({ socketPath, app: "runner", role: "owner", key: "secret" });
    expect(otherApp).toMatchObject({ status: "rejected", code: "unauthorized" });
    const owner = await connect(socketPath, "owner", "secret");
    const s = await owner.k.spawn({ title: "x", command: "sleep 30", cwd: dir });
    const viewer = await connect(socketPath, "viewer");
    await expect(viewer.k.spawn({ title: "y", command: "true", cwd: dir })).rejects.toMatchObject({ code: "not-owner" });
    await expect(viewer.k.update(s.id, { title: "z" })).rejects.toMatchObject({ code: "not-owner" });
    await expect(viewer.k.forget(s.id)).rejects.toMatchObject({ code: "not-owner" });
    await expect(viewer.k.upgrade("/bin/true")).rejects.toMatchObject({ code: "not-owner" });
    expect((await viewer.k.list()).length).toBe(1);
  });

  it("a client speaking another protocol version is rejected", async () => {
    const { socketPath } = await keeperInProcess();
    const { createConnection } = await import("node:net");
    const reply = await new Promise<string>((resolve) => {
      const sock = createConnection(socketPath, () =>
        sock.write(`${JSON.stringify({ type: "hello", protocol: ATTACH_PROTOCOL + 1, client: { app: "pomade", role: "viewer" } })}\n`),
      );
      let text = "";
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => (text += d));
      sock.on("close", () => resolve(text));
    });
    expect(JSON.parse(reply)).toMatchObject({ type: "reject", code: "version-mismatch" });
  });

  it("the owner updates the title and header actions; attached clients hear it", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    const s = await owner.k.spawn({ title: "Coda web", command: "sleep 30", cwd: dir, actions: [{ id: "restart", title: "Restart" }] });
    expect(s.actions).toEqual([{ id: "restart", title: "Restart" }]);
    const viewer = await connect(socketPath, "viewer");
    await viewer.k.attach(s.id);
    await owner.k.update(s.id, { title: "Coda web (dev)", actions: [] });
    await waitFor(() => viewer.events.find((e) => e.type === "info"), "the info event");
    expect(viewer.events.find((e) => e.type === "info")).toMatchObject({ info: { title: "Coda web (dev)", actions: [] } });
  });
});

describe("terminal queries and screen fidelity", () => {
  it("the keeper answers the program's queries exactly once; a late client's snapshot asks nothing and reproduces the screen cell for cell", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const qlog = join(dir, "q.log");
    const owner = await connect(socketPath);
    // A live view from the first byte is the ground truth.
    const live = viewTerm(100, 30);
    await owner.k.spawn({ id: "tui", title: "tui", argv: [process.execPath, join(FIXTURES, "query-tui.cjs")], cwd: dir, cols: 100, rows: 30, env: { QLOG: qlog, QTICK: "30" } });
    const liveClient = await connect(socketPath, "viewer");
    liveClient.k.onEvent((e) => {
      if (e.type === "snapshot") void live.write(e.data);
      if (e.type === "output") void live.write(e.data);
    });
    await liveClient.k.attach("tui");
    await sleep(800);

    const late = viewTerm(100, 30);
    const lateClient = await connect(socketPath, "viewer");
    lateClient.k.onEvent((e) => {
      if (e.type === "snapshot") void late.write(e.data);
      if (e.type === "output") void late.write(e.data);
    });
    await lateClient.k.attach("tui");
    const snap = snapshots(lateClient.events, "tui")[0];
    expect(snap?.data).not.toContain("\x1b[6n");
    expect(snap?.data).not.toContain("\x1b[c");
    await sleep(500);
    // Freeze the program, let both views parse everything, compare.
    const pid = (await owner.k.list())[0]?.pid ?? 0;
    process.kill(-pid, "SIGSTOP");
    await sleep(300);
    await live.write("");
    await late.write("");
    try {
      expect(screenState(late.term)).toEqual(screenState(live.term));
      expect(screenState(late.term)).toMatchObject({
        buffer: "alternate",
        cursorHidden: true,
        mouseEncoding: "SGR",
        scrollRegion: [2, 20],
        modes: { bracketedPasteMode: true, applicationCursorKeysMode: true, sendFocusMode: true, mouseTrackingMode: "drag" },
      });
    } finally {
      process.kill(-pid, "SIGCONT");
    }
    // The program got one answer per question: the keeper's. Clients never forward theirs.
    const received = readFileSync(qlog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string).join("");
    expect(received.match(/\x1b\[\d+;\d+R/g)?.length).toBe(1);
    expect(received.match(/\x1b\[\?[\d;]*c/g)?.length).toBe(1);
  });

  it("the headless terminal uses the Unicode 11 widths Pomade's renderer uses", async () => {
    const { socketPath, dir } = await keeperInProcess();
    const owner = await connect(socketPath);
    // ✅ is two cells wide in Unicode 11 and one in xterm's default tables: the keeper's answer to
    // "where is the cursor?" after printing it says which tables it uses.
    const s = await owner.k.spawn({
      title: "u",
      argv: [process.execPath, join(FIXTURES, "width-probe.cjs")],
      cwd: dir,
      cols: 20,
      rows: 4,
    });
    await owner.k.attach(s.id);
    await waitFor(() => owner.exitOf(s.id), "the program to read the answer");
    const text = (snapshots(owner.events, s.id)[0]?.data ?? "") + owner.output(s.id);
    expect(text).toContain('answer:"\\u001b[1;3R"');
  });
});

describe("resuming and falling behind", () => {
  it("a client that names what it saw gets only the output since (delta); a stale or foreign `since` gets a snapshot", async () => {
    const { socketPath, dir } = await keeperInProcess({ ringChars: 64 });
    const owner = await connect(socketPath);
    await owner.k.spawn({ id: "r", title: "r", command: "while read l; do echo \"line:$l\"; done", cwd: dir });
    const a = await connect(socketPath, "viewer");
    await a.k.attach("r");
    await sleep(100);
    const snap = snapshots(a.events, "r")[0];
    const startedAt = snap?.info.startedAt ?? 0;
    owner.k.input("r", "one\r");
    await waitFor(() => a.output("r").includes("line:one"), "line one");
    const seenSeq = a.events.filter((e): e is Extract<KeeperMessage, { type: "output" }> => e.type === "output").at(-1)?.seq ?? 0;
    a.k.close();
    owner.k.input("r", "two\r");
    await sleep(200);
    const b = await connect(socketPath, "viewer");
    await b.k.attach("r", { since: { startedAt, seq: seenSeq } });
    const delta = b.events.find((e) => e.type === "delta");
    expect(delta).toMatchObject({ type: "delta" });
    expect(delta && "data" in delta ? delta.data : "").toContain("line:two");
    expect(delta && "data" in delta ? delta.data : "").not.toContain("line:one");
    expect(snapshots(b.events, "r")).toHaveLength(0);
    // Past the ring (64 characters): a snapshot.
    owner.k.input("r", `${"x".repeat(100)}\r`);
    await sleep(200);
    const c = await connect(socketPath, "viewer");
    await c.k.attach("r", { since: { startedAt, seq: seenSeq } });
    expect(snapshots(c.events, "r")).toHaveLength(1);
    // Another session in the same slot: a snapshot.
    const d = await connect(socketPath, "viewer");
    await d.k.attach("r", { since: { startedAt: startedAt - 1, seq: seenSeq } });
    expect(snapshots(d.events, "r")).toHaveLength(1);
  });

  it("a client that stops reading has its output dropped past the high-water mark, then gets a fresh snapshot", async () => {
    const { socketPath, dir } = await keeperInProcess({ highWaterBytes: 64 * 1024 });
    const owner = await connect(socketPath);
    await owner.k.spawn({ id: "f", title: "flood", command: "i=0; while [ $i -lt 4000 ]; do echo \"flood line $i padding padding padding padding\"; i=$((i+1)); done; echo DONE; sleep 30", cwd: dir });
    // A raw socket that reads nothing for a while.
    const { createConnection } = await import("node:net");
    const sock = createConnection(socketPath);
    let text = "";
    sock.setEncoding("utf8");
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.write(`${JSON.stringify({ type: "hello", protocol: ATTACH_PROTOCOL, client: { app: "pomade", role: "viewer" } })}\n`);
    sock.write(`${JSON.stringify({ type: "attach", rid: "1", session: "f" })}\n`);
    sock.on("data", (d: string) => (text += d));
    sock.pause();
    await waitFor(async () => (await owner.k.list())[0]?.state === "running" && (await owner.k.list()).length > 0, "the flood");
    await sleep(1500);
    sock.resume();
    await waitFor(() => text.includes('"resync":true'), "the resync snapshot");
    const messages = text.trim().split("\n").map((l) => JSON.parse(l) as KeeperMessage);
    const resync = messages.find((m) => m.type === "snapshot" && m.resync);
    expect(resync && "data" in resync ? resync.data : "").toContain("DONE");
    // Output was dropped, never duplicated: the last output before the resync ends below its seq.
    const before = messages.slice(0, messages.indexOf(resync as KeeperMessage)).filter((m) => m.type === "output");
    expect(before.length).toBeGreaterThan(0);
    expect((before.at(-1) as Extract<KeeperMessage, { type: "output" }>).seq).toBeLessThan((resync as Extract<KeeperMessage, { type: "snapshot" }>).seq);
    sock.destroy();
  });
});

describe("ended sessions and keeper restarts", () => {
  it("keeps ended sessions for clients to see until the owner forgets them; keeps at most exitedMax", async () => {
    const { socketPath, dir } = await keeperInProcess({ exitedMax: 2 });
    const owner = await connect(socketPath);
    for (const id of ["a", "b", "c"]) {
      await owner.k.spawn({ id, title: id, command: "true", cwd: dir });
      await waitFor(async () => (await owner.k.list()).find((s: SessionInfo) => s.id === id)?.state === "exited", `${id} to end`);
      await sleep(20);
    }
    expect((await owner.k.list()).map((s) => s.id).sort()).toEqual(["b", "c"]);
    await owner.k.forget("b");
    expect((await owner.k.list()).map((s) => s.id)).toEqual(["c"]);
    await owner.k.spawn({ id: "d", title: "d", command: "sleep 30", cwd: dir });
    await expect(owner.k.forget("d")).rejects.toMatchObject({ code: "session-running" });
  });

  it("a session a dead keeper was running is reported lost-in-keeper-crash by the next keeper", async () => {
    const dir = tmpDir();
    const stateDir = join(dir, "state");
    mkdirSync(join(stateDir, "sessions"), { recursive: true });
    writeFileSync(
      join(stateDir, "sessions", "svc.json"),
      JSON.stringify({ id: "svc", title: "Coda web", command: "npm run dev", cwd: dir, pid: 999999, startedAt: 1, actions: [], exit: null }),
    );
    const { socketPath } = await keeperInProcess({ stateDir }, dir);
    const viewer = await connect(socketPath, "viewer");
    const [s] = await viewer.k.list();
    expect(s).toMatchObject({ id: "svc", title: "Coda web", state: "exited", pid: null, exit: { reason: "lost-in-keeper-crash" } });
    const record = JSON.parse(readFileSync(join(stateDir, "sessions", "svc.json"), "utf8")) as { exit: { reason: string } };
    expect(record.exit.reason).toBe("lost-in-keeper-crash");
  });
});

describe("the socket", () => {
  it("refuses a socket path macOS cannot bind, naming the limit", async () => {
    const dir = tmpDir();
    const long = join(dir, "x".repeat(110), "k.sock");
    await expect(runKeeper({ app: "hello", socketPath: long, stateDir: join(dir, "s"), ownerKey: null, log: () => undefined })).rejects.toThrow(/at most 103/);
  });

  it("a second keeper on a served socket refuses to start; a stale socket file is replaced", async () => {
    const first = await keeperInProcess();
    await expect(runKeeper({ app: "hello", socketPath: first.socketPath, stateDir: join(first.dir, "s2"), ownerKey: null, log: () => undefined })).rejects.toThrow(/already serves/);
    const dir = tmpDir();
    writeFileSync(join(dir, "k.sock"), "");
    const second = await keeperInProcess({}, dir);
    expect(second.keeper.sessions()).toEqual([]);
  });

  it("keeps its state in POMADE_APP_STATE/keeper; without it, in app-state next to the socket's user data", async () => {
    const dir = tmpDir();
    const appState = join(dir, "ud/app-state/hello");
    const base = { app: "hello", ownerKey: null, log: () => undefined };
    const withEnv = await runKeeper({ ...base, socketPath: join(dir, "a.sock"), env: { ...TEST_ENV, POMADE_APP_STATE: appState } });
    const derived = await runKeeper({ ...base, socketPath: join(dir, "ud2/run/keepers/hello.sock"), env: TEST_ENV });
    try {
      expect(withEnv.stateDir).toBe(join(appState, "keeper"));
      expect(derived.stateDir).toBe(join(dir, "ud2/app-state/hello/keeper"));
    } finally {
      await withEnv.close();
      await derived.close();
    }
  });

  it("creates the socket's folder private (0700)", async () => {
    const dir = tmpDir();
    const { statSync } = await import("node:fs");
    const k = await keeperInProcess({ socketPath: join(dir, "run/keepers/hello.sock"), stateDir: join(dir, "state") }, dir);
    expect(statSync(join(dir, "run/keepers")).mode & 0o777).toBe(0o700);
    expect(k.keeper.socketPath).toBe(join(dir, "run/keepers/hello.sock"));
  });
});

describe("sessionEnv", () => {
  it("drops the runtime switch and the app's identity and state folder, sets the terminal variables, keeps LANG", () => {
    const env = sessionEnv(
      { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", POMADE_APP_ID: "a", POMADE_APP_KEY_FILE: "/k", POMADE_CLIENT: "backend", POMADE_KEEPER_SOCKET: "/s", POMADE_APP_STATE: "/st", LANG: "de_DE.UTF-8", POMADE_SOCKET: "/p" },
      { FOO: "bar", TERM: "dumb" },
    );
    expect(env).toEqual({ PATH: "/bin", LANG: "de_DE.UTF-8", POMADE_SOCKET: "/p", TERM: "dumb", TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "453", POMADE: "1", FOO: "bar" });
    expect(sessionEnv({}).LANG).toBe("en_US.UTF-8");
    expect(TEST_ENV.SHELL).toBe("/bin/sh");
  });
});
