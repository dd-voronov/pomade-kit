import { describe, expect, it } from "vitest";

import {
  ATTACH_PROTOCOL,
  OWNER_ONLY,
  POMADE_ENV,
  checkActions,
  checkSessionRef,
  checkSpawnSpec,
  keeperSocketPath,
  keeperSocketProblem,
  parseHostMessage,
  parseKeeperMessage,
  parseKeeperRequest,
  type SessionInfo,
} from "./index.js";

const info: SessionInfo = {
  id: "svc",
  title: "Coda web",
  command: "npm run dev",
  cwd: "/w",
  pid: 12,
  startedAt: 1,
  cols: 80,
  rows: 24,
  state: "running",
  exit: null,
  clients: 0,
  actions: [],
};

describe("where keepers live", () => {
  it("one socket per app under Pomade's user data, named in the backend's environment", () => {
    expect(keeperSocketPath("/U/Pomade", "pomade-runner")).toBe("/U/Pomade/run/keepers/pomade-runner.sock");
    expect(keeperSocketPath("/U/Pomade/", "hello")).toBe("/U/Pomade/run/keepers/hello.sock");
    expect(POMADE_ENV.keeperSocket).toBe("POMADE_KEEPER_SOCKET");
    expect(keeperSocketProblem("/Users/me/Library/Application Support/Pomade", "pomade-runner")).toBeNull();
    expect(keeperSocketProblem(`/Users/${"x".repeat(60)}/Library/Application Support/Pomade`, "pomade-runner")).toMatch(/at most 103/);
  });
});

describe("session references", () => {
  it.each([
    [{ app: "pomade-runner", session: "svc:coda-web" }, null],
    [{ app: "hello", session: "a1", extra: 1 }, null],
    [null, '"session" must be an object'],
    [[], '"session" must be an object'],
    [{ app: "Bad", session: "a" }, '"session.app"'],
    [{ app: "hello" }, '"session.session"'],
    [{ app: "hello", session: "-x" }, '"session.session"'],
    [{ app: "hello", session: "a/b" }, '"session.session"'],
    [{ app: "hello", session: "a".repeat(129) }, '"session.session"'],
  ])("%j", (raw, problem) => {
    const r = checkSessionRef(raw);
    if (problem === null) expect(r).toEqual({ ok: true, value: { app: (raw as { app: string }).app, session: (raw as { session: string }).session } });
    else expect(r.ok ? "" : r.message).toContain(problem);
  });
});

describe("spawn specs", () => {
  const base = { title: " Web ", command: "npm run dev", cwd: "/w" };
  it("accepts a command or argv, trims the title, keeps the options", () => {
    expect(checkSpawnSpec(base)).toEqual({ ok: true, value: { title: "Web", command: "npm run dev", cwd: "/w" } });
    expect(
      checkSpawnSpec({ id: "svc", title: "x", argv: ["/bin/ls", "-l"], cwd: "/", env: { A: "1" }, cols: 100, rows: 30, background: true, log: "/l", actions: [{ id: "restart", title: "Restart" }] }),
    ).toEqual({
      ok: true,
      value: { id: "svc", title: "x", argv: ["/bin/ls", "-l"], cwd: "/", env: { A: "1" }, cols: 100, rows: 30, background: true, log: "/l", actions: [{ id: "restart", title: "Restart" }] },
    });
  });
  it.each([
    [{ ...base, title: "" }, '"title"'],
    [{ title: "x", cwd: "/" }, "exactly one"],
    [{ ...base, argv: ["/bin/ls"] }, "exactly one"],
    [{ title: "x", argv: [], cwd: "/" }, '"argv"'],
    [{ title: "x", argv: [""], cwd: "/" }, '"argv"'],
    [{ ...base, command: "  " }, '"command"'],
    [{ ...base, cwd: "rel" }, '"cwd"'],
    [{ ...base, id: "a b" }, '"id"'],
    [{ ...base, env: { A: 1 } }, '"env"'],
    [{ ...base, cols: 1 }, '"cols"'],
    [{ ...base, rows: 501 }, '"rows"'],
    [{ ...base, background: "yes" }, '"background"'],
    [{ ...base, log: "x.log" }, '"log"'],
    [{ ...base, actions: [{ id: "Restart", title: "R" }] }, '"actions[0].id"'],
    [null, '"spec"'],
  ])("refuses %j", (raw, problem) => {
    const r = checkSpawnSpec(raw);
    expect(r.ok ? "" : r.message).toContain(problem);
  });
  it("header actions: at most four, unique, titled", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, title: "x" }));
    expect(checkActions(five)).toMatchObject({ ok: false });
    expect(checkActions([{ id: "a", title: "x" }, { id: "a", title: "y" }])).toMatchObject({ ok: false, message: expect.stringContaining("repeats") as string });
    expect(checkActions([{ id: "a", title: "x".repeat(41) }])).toMatchObject({ ok: false });
    expect(checkActions("x")).toMatchObject({ ok: false });
  });
});

describe("client → keeper requests", () => {
  it.each([
    [{ type: "hello", protocol: ATTACH_PROTOCOL, client: { app: "pomade", role: "viewer" } }, true],
    [{ type: "hello", protocol: 1, client: { app: "hello", role: "owner", key: "k" } }, true],
    [{ type: "hello", protocol: 1, client: { app: "hello", role: "admin" } }, false],
    [{ type: "hello", protocol: "1", client: { app: "hello", role: "owner" } }, false],
    [{ type: "list", rid: "1" }, true],
    [{ type: "list" }, false],
    [{ type: "spawn", rid: "1", spec: { title: "x", command: "true", cwd: "/" } }, true],
    [{ type: "spawn", rid: "1", spec: { title: "x", cwd: "/" } }, false],
    [{ type: "attach", rid: "1", session: "s" }, true],
    [{ type: "attach", rid: "1", session: "s", cols: 80, rows: 24, since: { startedAt: 5, seq: 10 }, scrollback: 100 }, true],
    [{ type: "attach", rid: "1", session: "s", cols: 80 }, false],
    [{ type: "attach", rid: "1", session: "s", since: 10 }, false],
    [{ type: "attach", session: "s" }, false],
    [{ type: "input", session: "s", data: "x" }, true],
    [{ type: "input", session: "s", data: 1 }, false],
    [{ type: "paste", session: "s", text: "x" }, true],
    [{ type: "resize", session: "s", cols: 80, rows: 24 }, true],
    [{ type: "resize", session: "s", cols: 1001, rows: 24 }, false],
    [{ type: "detach", session: "s" }, true],
    [{ type: "detach", session: "" }, false],
    [{ type: "stop", rid: "1", session: "s" }, true],
    [{ type: "stop", rid: "1", session: "s", reason: "time-limit", graceMs: 0 }, true],
    [{ type: "stop", rid: "1", session: "s", reason: "exited" }, false],
    [{ type: "update", rid: "1", session: "s", title: "t", actions: [] }, true],
    [{ type: "update", rid: "1", session: "s", title: "" }, false],
    [{ type: "forget", rid: "1", session: "s" }, true],
    [{ type: "upgrade", rid: "1", entry: "/k.mjs", args: ["v2"] }, true],
    [{ type: "upgrade", rid: "1", entry: "k.mjs" }, false],
    [{ type: "nope", rid: "1" }, false],
    ["hello", false],
  ])("%j → %s", (raw, ok) => {
    expect(parseKeeperRequest(raw).ok).toBe(ok);
  });
  it("names the rid of a bad request so the keeper can answer it", () => {
    expect(parseKeeperRequest({ type: "attach", rid: "7", session: "a b" })).toEqual({ ok: false, rid: "7", message: '"session" must be a session id' });
  });
  it("spawn, update, forget and upgrade are the owner's", () => {
    expect([...OWNER_ONLY].sort()).toEqual(["forget", "spawn", "update", "upgrade"]);
  });
});

describe("keeper → client messages", () => {
  it.each([
    [{ type: "welcome", protocol: 1, app: "hello", keeper: { version: "1", pid: 3 } }, true],
    [{ type: "reject", protocol: 1, code: "unauthorized", message: "no" }, true],
    [{ type: "result", rid: "1", value: [] }, true],
    [{ type: "error", code: "unknown-session", message: "no" }, true],
    [{ type: "snapshot", session: "s", info, data: "x", seq: 4, resync: false }, true],
    [{ type: "snapshot", session: "s", info: { ...info, state: "zombie" }, data: "x", seq: 4, resync: false }, false],
    [{ type: "delta", session: "s", info, data: "x", seq: 4 }, true],
    [{ type: "output", session: "s", data: "x", seq: 4 }, true],
    [{ type: "output", session: "s", data: "x" }, false],
    [{ type: "resized", session: "s", cols: 1, rows: 2 }, true],
    [{ type: "exit", session: "s", exit: { code: 130, signal: "SIGINT", reason: "stopped-by-you", at: 1 } }, true],
    [{ type: "exit", session: "s", exit: { code: 1, signal: null, reason: "oops", at: 1 } }, false],
    [{ type: "info", session: "s", info }, true],
    [{ type: "keeper-restarting", reconnectAfterMs: 100 }, true],
    [{ type: "other" }, false],
  ])("%j → %s", (raw, ok) => {
    expect(parseKeeperMessage(raw) !== null).toBe(ok);
  });
});

describe("the attachedTab.action event", () => {
  it("is a platform event carrying the session, the action and the project", () => {
    const payload = { session: { app: "pomade-runner", session: "svc" }, action: "restart", projectId: "p1" };
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "attachedTab.action", payload })).toEqual({
      channel: "pomade",
      type: "event",
      name: "attachedTab.action",
      payload,
    });
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "attachedTab.action", payload: { ...payload, session: { app: "x" } } })).toBeNull();
  });
});
