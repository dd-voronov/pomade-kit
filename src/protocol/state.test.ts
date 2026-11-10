import { describe, expect, it } from "vitest";
import {
  checkStateKey,
  checkStateValue,
  isJsonValue,
  STATE_KEY_MAX_LENGTH,
  STATE_VALUE_MAX_BYTES,
  STATE_VALUE_MAX_DEPTH,
} from "./state.js";

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

describe("checkStateKey", () => {
  it.each(["k", "view.p1", "view:__workspace__", "Ünïcode key with spaces", "x".repeat(STATE_KEY_MAX_LENGTH)])("accepts %j", (key) => {
    expect(checkStateKey(key)).toBeNull();
  });

  it.each([
    ["", '"key" must be a non-empty string'],
    [undefined, '"key" must be a non-empty string'],
    [null, '"key" must be a non-empty string'],
    [3, '"key" must be a non-empty string'],
    [["k"], '"key" must be a non-empty string'],
    ["x".repeat(STATE_KEY_MAX_LENGTH + 1), `"key" must be at most ${STATE_KEY_MAX_LENGTH} characters`],
  ])("refuses %j", (key, message) => {
    expect(checkStateKey(key)).toBe(message);
  });
});

describe("isJsonValue / checkStateValue", () => {
  it.each([
    null,
    true,
    false,
    0,
    -1.5,
    "",
    "text",
    [],
    {},
    [1, "a", null, [true], { b: [] }],
    { view: "board", pins: ["a", "b"], nested: { n: 1 } },
    Object.assign(Object.create(null) as object, { a: 1 }),
    nested(STATE_VALUE_MAX_DEPTH - 1),
  ])("accepts %j", (value) => {
    expect(isJsonValue(value)).toBe(true);
    expect(checkStateValue(value)).toBeNull();
  });

  it.each([
    [undefined, '"value" is required (null removes the key)'],
    [Number.NaN, '"value" is not plain JSON'],
    [Number.POSITIVE_INFINITY, '"value" is not plain JSON'],
    [() => 1, '"value" is not plain JSON'],
    [Symbol("s"), '"value" is not plain JSON'],
    [10n, '"value" is not plain JSON'],
    [new Date(0), '"value" is not plain JSON'],
    [new Map(), '"value" is not plain JSON'],
    [[1, undefined], '"value[1]" is not plain JSON'],
    [{ a: { b: Number.NaN } }, '"value.a.b" is not plain JSON'],
    [{ a: [0, new Set()] }, '"value.a[1]" is not plain JSON'],
    [nested(STATE_VALUE_MAX_DEPTH + 1), '"value' + "[0]".repeat(STATE_VALUE_MAX_DEPTH) + '" is not plain JSON'],
  ])("refuses %s", (value, prefix) => {
    if (value !== undefined) expect(isJsonValue(value)).toBe(false);
    expect(checkStateValue(value)).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("refuses a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(isJsonValue(a)).toBe(false);
    expect(checkStateValue(a)).toMatch(/^"value\.self" is not plain JSON/);
  });

  it("accepts the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(isJsonValue([shared, shared, { shared }])).toBe(true);
  });

  it("limits the JSON size in UTF-8 bytes", () => {
    // `"…"` adds 2 bytes of quotes.
    expect(checkStateValue("a".repeat(STATE_VALUE_MAX_BYTES - 2))).toBeNull();
    expect(checkStateValue("a".repeat(STATE_VALUE_MAX_BYTES - 1))).toBe(`"value" must be at most ${STATE_VALUE_MAX_BYTES} bytes as JSON`);
    // "é" is 2 bytes in UTF-8.
    expect(checkStateValue("é".repeat(STATE_VALUE_MAX_BYTES / 2))).toMatch(/must be at most/);
  });
});
