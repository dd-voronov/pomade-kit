import { describe, expect, it, vi } from "vitest";
import { postMessageTransport, type MessageWindow } from "./transport.js";

function fakeWindow() {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const win: MessageWindow = Object.assign(target, { parent });
  const message = (data: unknown, source: unknown) =>
    target.dispatchEvent(Object.assign(new Event("message"), { data, source }));
  return { win, parent, message };
}

describe("postMessageTransport", () => {
  it("posts to the parent window with target origin *", () => {
    const w = fakeWindow();
    postMessageTransport(w.win).send({ channel: "pomade", type: "hello", hostApi: 0 });
    expect(w.parent.postMessage).toHaveBeenCalledWith({ channel: "pomade", type: "hello", hostApi: 0 }, "*");
  });

  it("receives only messages whose source is the parent, until unsubscribed", () => {
    const w = fakeWindow();
    const got = vi.fn();
    const off = postMessageTransport(w.win).listen(got);
    w.message({ a: 1 }, w.parent);
    w.message({ b: 2 }, {});
    w.message({ c: 3 }, null);
    expect(got.mock.calls).toEqual([[{ a: 1 }]]);
    off();
    w.message({ d: 4 }, w.parent);
    expect(got).toHaveBeenCalledTimes(1);
  });
});
