import { describe, expect, it } from "vitest";
import { APP_CALL_TIMEOUT_MS, brokerErrors, parseAppCall } from "./index.js";

describe("parseAppCall", () => {
  it("defaults params to {} and the timeout to 5000 ms", () => {
    expect(parseAppCall({ app: "pomade-agents", method: "sessions.last" })).toEqual({
      ok: true,
      call: { app: "pomade-agents", method: "sessions.last", params: {}, timeoutMs: APP_CALL_TIMEOUT_MS },
    });
    expect(parseAppCall({ app: "a1", method: "m", params: [1, "x", null], timeoutMs: 100, extra: true })).toEqual({
      ok: true,
      call: { app: "a1", method: "m", params: [1, "x", null], timeoutMs: 100 },
    });
    expect(parseAppCall({ app: "a1", method: "m", params: null, timeoutMs: 60000 })).toMatchObject({ ok: true, call: { params: null } });
  });

  it.each<[unknown, RegExp]>([
    [null, /params must be an object/],
    [[], /params must be an object/],
    [{ method: "m" }, /"app" must be an app id/],
    [{ app: "", method: "m" }, /"app"/],
    [{ app: "a1" }, /"method"/],
    [{ app: "a1", method: "m", params: new Date(0) }, /"params" must be plain JSON/],
    [{ app: "a1", method: "m", params: { x: Infinity } }, /plain JSON/],
    [{ app: "a1", method: "m", timeoutMs: 99 }, /"timeoutMs" must be an integer from 100 to 60000/],
    [{ app: "a1", method: "m", timeoutMs: 60001 }, /timeoutMs/],
    [{ app: "a1", method: "m", timeoutMs: 1.5 }, /timeoutMs/],
  ])("refuses %j", (raw, message) => {
    const r = parseAppCall(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid-params");
      expect(r.error.message).toMatch(message);
    }
  });
});

describe("brokerErrors", () => {
  it("absent and not responding are distinct codes a caller can fall back on", () => {
    expect(brokerErrors.notInstalled("x").code).toBe("app-absent");
    expect(brokerErrors.notRunning("x").code).toBe("app-absent");
    expect(brokerErrors.timeout("x", 100)).toEqual({ code: "app-not-responding", message: 'The app "x" did not answer within 100 ms' });
    expect(brokerErrors.gone("x").code).toBe("app-not-responding");
    expect(brokerErrors.notDeclared("a", "b")).toEqual({ code: "capability-denied", message: '"b" is not in the "calls" of a\'s manifest' });
    expect(brokerErrors.unknownMethod("b", "m").code).toBe("unknown-method");
    expect(brokerErrors.notJson("b").code).toBe("app-error");
  });
});
