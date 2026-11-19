import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type ConnectResult } from "./connect.js";
import { mockTransport, PROJECT, WELCOME, type MockTransport } from "./test-helpers.js";

const HELLO = { channel: "pomade", type: "hello", hostApi: 0 };

/** Start a handshake and expose its result once settled. */
function start(mock: MockTransport, options: Parameters<typeof connect>[0] = {}) {
  let result: ConnectResult | undefined;
  const promise = connect({ transport: mock.transport, keySource: null, ...options }).then((r) => (result = r));
  return { promise, settled: () => result };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connect — handshake", () => {
  it("sends hello at once, then resends every 250 ms until answered", async () => {
    const mock = mockTransport();
    const h = start(mock);
    expect(mock.sent).toEqual([HELLO]);
    await vi.advanceTimersByTimeAsync(249);
    expect(mock.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.sent).toHaveLength(4);
    expect(mock.sent.every((m) => m.type === "hello" && m.hostApi === 0)).toBe(true);
    mock.deliver(WELCOME);
    await h.promise;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.sent).toHaveLength(4);
  });

  it("welcome → connected, with the welcome data on the client", async () => {
    const mock = mockTransport();
    const h = start(mock);
    mock.deliver(WELCOME);
    const r = await h.promise;
    expect(r.status).toBe("connected");
    if (r.status !== "connected") return;
    expect(r.host.welcome).toEqual({ hostApi: 0, pomadeVersion: "0.3.0", appId: "hello", surface: "tab", route: "", project: PROJECT, theme: "light" });
    // The handshake listener is gone; the client's own listener remains.
    expect(mock.listenerCount()).toBe(1);
  });

  it("a panel welcome exposes its surface, strip icon and route", async () => {
    const mock = mockTransport();
    const h = start(mock);
    mock.deliver({ ...WELCOME, surface: "panel", icon: "board", route: "needs-you" });
    const r = await h.promise;
    if (r.status !== "connected") throw new Error(r.status);
    expect(r.host.welcome).toEqual({
      hostApi: 0,
      pomadeVersion: "0.3.0",
      appId: "hello",
      surface: "panel",
      icon: "board",
      route: "needs-you",
      project: PROJECT,
      theme: "light",
    });
  });

  it.each(["needs-newer-pomade", "app-too-old"] as const)("reject %s → rejected result, nothing left listening", async (reason) => {
    const mock = mockTransport();
    const h = start(mock);
    mock.deliver({ channel: "pomade", type: "reject", reason, hostApi: 3 });
    expect(await h.promise).toEqual({ status: "rejected", reason, hostApi: 3 });
    expect(mock.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.sent).toHaveLength(1);
  });

  it("no answer within 1500 ms → no-host (never throws), stops sending hello", async () => {
    const mock = mockTransport();
    const h = start(mock);
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.settled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.settled()).toEqual({ status: "no-host" });
    expect(mock.listenerCount()).toBe(0);
    const count = mock.sent.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.sent).toHaveLength(count);
  });

  it("a welcome just before the deadline connects", async () => {
    const mock = mockTransport();
    const h = start(mock);
    await vi.advanceTimersByTimeAsync(1499);
    mock.deliver(WELCOME);
    expect((await h.promise).status).toBe("connected");
  });

  it("a late welcome after the deadline is ignored", async () => {
    const mock = mockTransport();
    const h = start(mock);
    await vi.advanceTimersByTimeAsync(1500);
    mock.deliver(WELCOME);
    expect(await h.promise).toEqual({ status: "no-host" });
    expect(mock.listenerCount()).toBe(0);
  });

  it("the first answer wins", async () => {
    const mock = mockTransport();
    const h = start(mock);
    mock.deliver(WELCOME);
    mock.deliver({ channel: "pomade", type: "reject", reason: "app-too-old", hostApi: 0 });
    expect((await h.promise).status).toBe("connected");
  });

  it("ignores foreign and malformed messages while waiting", async () => {
    const mock = mockTransport();
    const h = start(mock);
    mock.deliver({ type: "welcome" });
    mock.deliver({ ...WELCOME, channel: "other" });
    mock.deliver({ ...WELCOME, project: null });
    mock.deliver({ channel: "pomade", type: "reject", reason: "bogus", hostApi: 0 });
    mock.deliver({ channel: "pomade", type: "result", id: "1", ok: true, value: 1 });
    mock.deliver({ channel: "pomade", type: "event", name: "project.changed", payload: PROJECT });
    mock.deliver({ channel: "pomade", type: "hello", hostApi: 0 });
    mock.deliver("welcome");
    mock.deliver(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.settled()).toBeUndefined();
    mock.deliver(WELCOME);
    expect((await h.promise).status).toBe("connected");
  });

  it("honors timeoutMs and helloIntervalMs", async () => {
    const mock = mockTransport();
    const h = start(mock, { timeoutMs: 300, helloIntervalMs: 100 });
    await vi.advanceTimersByTimeAsync(299);
    expect(mock.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.settled()).toEqual({ status: "no-host" });
  });

  it("without a transport and without a window → no-host at once", async () => {
    expect(typeof window).toBe("undefined");
    expect(await connect()).toEqual({ status: "no-host" });
  });
});
