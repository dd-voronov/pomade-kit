import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyMessage } from "../protocol/index.js";
import { connect } from "./connect.js";
import { installKeyForwarder, shouldForwardKey } from "./keys.js";
import { FakeKeyEvent, mockTransport, WELCOME } from "./test-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("shouldForwardKey", () => {
  const base = { key: "w", code: "KeyW", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false };
  it.each([
    [{ metaKey: true }, true],
    [{ ctrlKey: true }, true],
    [{ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }, true],
    [{ metaKey: true, key: "Meta", code: "MetaLeft" }, false],
    [{ ctrlKey: true, key: "Control", code: "ControlLeft" }, false],
    [{ metaKey: true, altKey: true, key: "Alt", code: "AltLeft" }, false],
    [{ ctrlKey: true, shiftKey: true, key: "Shift", code: "ShiftRight" }, false],
    [{ metaKey: true, key: "Enter", code: "Enter" }, true],
    [{}, false],
    [{ altKey: true }, false],
    [{ shiftKey: true }, false],
    [{ metaKey: true, defaultPrevented: true }, false],
    [{ ctrlKey: true, defaultPrevented: true }, false],
  ])("%j → %s", (patch, expected) => {
    expect(shouldForwardKey({ ...base, ...patch })).toBe(expected);
  });

  const esc = { ...base, key: "Escape", code: "Escape" };
  it.each([
    [{}, true],
    [{ shiftKey: true }, false],
    [{ altKey: true }, false],
    [{ defaultPrevented: true }, false],
    [{ metaKey: true }, true],
  ])("with escape: plain Escape %j → %s", (patch, expected) => {
    expect(shouldForwardKey({ ...esc, ...patch }, { escape: true })).toBe(expected);
  });

  it("without escape, a plain Escape is not forwarded", () => {
    expect(shouldForwardKey(esc)).toBe(false);
    expect(shouldForwardKey(esc, { escape: false })).toBe(false);
  });
});

describe("installKeyForwarder", () => {
  function setup() {
    const target = new EventTarget();
    const sent: KeyMessage[] = [];
    const stop = installKeyForwarder(target, (m) => sent.push(m));
    return { target, sent, stop };
  }

  it("forwards an unhandled Cmd/Ctrl keydown with every modifier flag", async () => {
    const t = setup();
    t.target.dispatchEvent(new FakeKeyEvent({ key: "W", code: "KeyW", metaKey: true, shiftKey: true }));
    t.target.dispatchEvent(new FakeKeyEvent({ key: "t", code: "KeyT", ctrlKey: true, altKey: true }));
    expect(t.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([
      { channel: "pomade", type: "key", key: "W", code: "KeyW", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      { channel: "pomade", type: "key", key: "t", code: "KeyT", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false },
    ]);
  });

  it("does not forward modifier keys pressed alone", async () => {
    const t = setup();
    t.target.dispatchEvent(new FakeKeyEvent({ key: "Meta", code: "MetaLeft", metaKey: true }));
    t.target.dispatchEvent(new FakeKeyEvent({ key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true }));
    t.target.dispatchEvent(new FakeKeyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
  });

  it("does not forward keys without Cmd/Ctrl", async () => {
    const t = setup();
    t.target.dispatchEvent(new FakeKeyEvent({ key: "a", code: "KeyA" }));
    t.target.dispatchEvent(new FakeKeyEvent({ key: "a", code: "KeyA", altKey: true, shiftKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
  });

  it("does not forward a key the app handled — even by a listener added after the forwarder", async () => {
    const t = setup();
    t.target.addEventListener("keydown", (e) => e.preventDefault());
    t.target.dispatchEvent(new FakeKeyEvent({ key: "k", code: "KeyK", metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
  });

  it("ignores other event types", async () => {
    const t = setup();
    t.target.dispatchEvent(Object.assign(new Event("keyup"), { metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
  });

  it("with escape: forwards an unhandled plain Escape, never a handled one", async () => {
    const target = new EventTarget();
    const sent: KeyMessage[] = [];
    installKeyForwarder(target, (m) => sent.push(m), { escape: true });
    target.dispatchEvent(new FakeKeyEvent({ key: "Escape", code: "Escape" }));
    const handled = new FakeKeyEvent({ key: "Escape", code: "Escape" });
    target.addEventListener("keydown", (e) => {
      if (e === handled) e.preventDefault();
    });
    target.dispatchEvent(handled);
    target.dispatchEvent(new FakeKeyEvent({ key: "Escape", code: "Escape", shiftKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([
      { channel: "pomade", type: "key", key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    ]);
  });

  it("stop() removes the listener and drops keys not yet forwarded", async () => {
    const t = setup();
    t.target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    t.stop();
    t.target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
  });
});

describe("connect installs key forwarding", () => {
  async function connected(keySource: EventTarget | null) {
    const mock = mockTransport();
    const p = connect({ transport: mock.transport, keySource });
    mock.deliver(WELCOME);
    const r = await p;
    if (r.status !== "connected") throw new Error("not connected");
    return { mock, host: r.host };
  }
  const keys = (sent: { type: string }[]) => sent.filter((m) => m.type === "key");

  it("after welcome, forwards through the transport until the client closes", async () => {
    const target = new EventTarget();
    const { mock, host } = await connected(target);
    target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(mock.sent)).toEqual([
      { channel: "pomade", type: "key", key: "w", code: "KeyW", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    ]);
    host.close();
    target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(mock.sent)).toHaveLength(1);
  });

  it("is not installed before welcome, nor after no-host or reject", async () => {
    const target = new EventTarget();
    const mock = mockTransport();
    const p = connect({ transport: mock.transport, keySource: target });
    target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    mock.deliver({ channel: "pomade", type: "reject", reason: "app-too-old", hostApi: 0 });
    await p;
    target.dispatchEvent(new FakeKeyEvent({ key: "w", code: "KeyW", metaKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(mock.sent)).toEqual([]);
  });

  it("an overlay frame also forwards a plain Escape; a tab frame does not", async () => {
    for (const surface of ["overlay", "tab"] as const) {
      const target = new EventTarget();
      const mock = mockTransport();
      const p = connect({ transport: mock.transport, keySource: target });
      mock.deliver({ ...WELCOME, surface });
      await p;
      target.dispatchEvent(new FakeKeyEvent({ key: "Escape", code: "Escape" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(keys(mock.sent), surface).toHaveLength(surface === "overlay" ? 1 : 0);
    }
  });

  it("keySource: null turns forwarding off", async () => {
    const { mock } = await connected(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(keys(mock.sent)).toEqual([]);
  });
});
