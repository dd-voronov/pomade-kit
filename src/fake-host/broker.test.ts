import { describe, expect, it } from "vitest";
import { connect, HostError, type HostClient } from "../sdk/index.js";
import { createFakeHost, type FakeHostOptions } from "./index.js";

const MANIFEST = {
  id: "pomade-runner",
  name: "Runner",
  version: "0.1.0",
  hostApi: 0,
  capabilities: [],
  api: ["jobsForRepo", "boom"],
  calls: ["pomade-agents", "pomade-slow"],
};

async function client(options: FakeHostOptions, surface: "tab" | "backend" = "tab"): Promise<{ host: HostClient; fake: ReturnType<typeof createFakeHost> }> {
  const fake = createFakeHost({ manifest: MANIFEST, ...options });
  const r = await connect({ transport: fake.createTransport({ surface }), keySource: null });
  if (r.status !== "connected") throw new Error(r.status);
  return { host: r.host, fake };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return (err as { code: string }).code;
  }
}

describe("apps.call in the fake host", () => {
  it("reaches a scripted app's handler with the caller's id; values are copies", async () => {
    const seen: unknown[] = [];
    const { host } = await client({
      apps: {
        "pomade-agents": {
          "sessions.last": (params, ctx) => {
            seen.push([params, ctx.from]);
            return { id: "s1" };
          },
        },
      },
    });
    await expect(host.apps.call("pomade-agents", "sessions.last", { cwd: "/x" })).resolves.toEqual({ id: "s1" });
    await expect(host.apps.call("pomade-agents", "sessions.last")).resolves.toEqual({ id: "s1" });
    expect(seen).toEqual([
      [{ cwd: "/x" }, "pomade-runner"],
      [{}, "pomade-runner"],
    ]);
  });

  it("absent, undeclared, unknown method, not responding, a thrown error", async () => {
    const { host } = await client({
      apps: {
        "pomade-agents": {
          fail: () => {
            throw new HostError("not-found", "no such session");
          },
          crash: () => {
            throw new Error("kaput");
          },
        },
        "pomade-slow": "not-responding",
      },
    });
    expect(await codeOf(host.apps.call("pomade-planner", "today"))).toBe("capability-denied");
    expect(await codeOf(host.apps.call("pomade-agents", "nope"))).toBe("unknown-method");
    expect(await codeOf(host.apps.call("pomade-agents", "fail"))).toBe("not-found");
    expect(await codeOf(host.apps.call("pomade-agents", "crash"))).toBe("app-error");
    expect(await codeOf(host.apps.call("pomade-slow", "x", {}, { timeoutMs: 100 }))).toBe("app-not-responding");
    expect(await codeOf(host.apps.call("pomade-agents", "x", {}, { timeoutMs: 5 }))).toBe("invalid-params");
    const absent = await client({});
    expect(await codeOf(absent.host.apps.call("pomade-agents", "sessions.last"))).toBe("app-absent");
  });
});

describe("api.serve and requests", () => {
  it("the app serves its API: callApi and its own frames reach the handlers", async () => {
    const { host, fake } = await client({}, "backend");
    const served = await host.api.serve({
      jobsForRepo: (params, ctx) => ({ repo: (params as { repo: string }).repo, from: ctx.from }),
      boom: () => {
        throw new HostError("not-found", "no jobs");
      },
    });
    expect(served).toEqual({ methods: ["jobsForRepo", "boom"] });
    await expect(fake.callApi("jobsForRepo", { repo: "Knowledge" })).resolves.toEqual({ repo: "Knowledge", from: "pomade" });
    await expect(fake.callApi("jobsForRepo", { repo: "x" }, { from: "pomade-git" })).resolves.toEqual({ repo: "x", from: "pomade-git" });
    expect(await codeOf(fake.callApi("boom"))).toBe("not-found");
    expect(await codeOf(fake.callApi("undeclared"))).toBe("unknown-method");
    // A frame of the same app calls its own backend's API without declaring it in "calls".
    const r = await connect({ transport: fake.createTransport(), keySource: null });
    if (r.status !== "connected") throw new Error(r.status);
    await expect(r.host.apps.call("pomade-runner", "jobsForRepo", { repo: "y" })).resolves.toEqual({ repo: "y", from: "pomade-runner" });
  });

  it("a declared method without a handler is unknown-method; no server is app-absent; a closed server is not responding", async () => {
    const { host, fake } = await client({});
    expect(await codeOf(fake.callApi("jobsForRepo"))).toBe("app-absent");
    await host.api.serve({});
    expect(await codeOf(fake.callApi("jobsForRepo"))).toBe("unknown-method");
    const slow = await client({});
    await slow.host.api.serve({ jobsForRepo: () => new Promise(() => undefined) });
    expect(await codeOf(slow.fake.callApi("jobsForRepo", {}, { timeoutMs: 50 }))).toBe("app-not-responding");
  });

  it("an app without api cannot serve", async () => {
    const fake = createFakeHost({ manifest: { ...MANIFEST, api: undefined } });
    const r = await connect({ transport: fake.createTransport(), keySource: null });
    if (r.status !== "connected") throw new Error(r.status);
    expect(await codeOf(r.host.api.serve({}))).toBe("capability-denied");
  });
});

describe("agents.liveIn", () => {
  it("is Pomade's own: an app is refused", async () => {
    const { host } = await client({});
    expect(await codeOf(host.agents.liveIn("/repo"))).toBe("capability-denied");
  });
});
