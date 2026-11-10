import { describe, expect, it } from "vitest";
import { jsonProblem, mergeProjectSettings, normalizeVisibleAgents, settingsSizeProblem } from "./project-data.js";
import { PROJECT_SETTINGS_MAX_BYTES } from "./types.js";

describe("jsonProblem", () => {
  it.each([null, "", "x", 0, -1.5, true, [], {}, { a: [1, { b: null }] }, Object.create(null) as object])("accepts %j", (v) => {
    expect(jsonProblem(v)).toBeNull();
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", { a: Infinity }],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a bigint", 1n],
    ["undefined in a list", [undefined]],
  ])("refuses %s", (_label, v) => {
    expect(jsonProblem(v)).toEqual(expect.any(String));
  });

  it("refuses nesting deeper than 32 levels", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 33; i++) deep = [deep];
    expect(jsonProblem(deep)).toMatch(/deeper/);
    let ok: unknown = 1;
    for (let i = 0; i < 32; i++) ok = [ok];
    expect(jsonProblem(ok)).toBeNull();
  });
});

describe("mergeProjectSettings", () => {
  it("adds and replaces keys; null removes one; the input is not changed", () => {
    const current = { backlog: "docs/roadmap", view: { cols: 3 } };
    expect(mergeProjectSettings(current, { view: { cols: 4 }, extra: [1], backlog: null })).toEqual({ view: { cols: 4 }, extra: [1] });
    expect(current).toEqual({ backlog: "docs/roadmap", view: { cols: 3 } });
    expect(mergeProjectSettings({}, { gone: null })).toEqual({});
  });
});

describe("settingsSizeProblem", () => {
  it("allows the limit and refuses past it, counting UTF-8 bytes", () => {
    const pad = (n: number) => ({ k: "x".repeat(n) });
    const overhead = JSON.stringify(pad(0)).length;
    expect(settingsSizeProblem(pad(PROJECT_SETTINGS_MAX_BYTES - overhead))).toBeNull();
    expect(settingsSizeProblem(pad(PROJECT_SETTINGS_MAX_BYTES - overhead + 1))).toMatch(/limit/);
    expect(settingsSizeProblem({ k: "é".repeat(PROJECT_SETTINGS_MAX_BYTES / 2) })).toMatch(/limit/);
  });
});

describe("normalizeVisibleAgents", () => {
  it("trims, dedupes, keeps order; [] and ['*'] are valid", () => {
    expect(normalizeVisibleAgents([" claude", "codex", "claude"])).toEqual(["claude", "codex"]);
    expect(normalizeVisibleAgents([])).toEqual([]);
    expect(normalizeVisibleAgents(["*"])).toEqual(["*"]);
  });

  it.each<[string, unknown]>([
    ["not an array", "claude"],
    ["an empty id", [""]],
    ["a non-string", [3]],
    ["a path", ["a/b"]],
    ["a line break", ["a\nb"]],
    ["* with ids", ["*", "claude"]],
  ])("refuses %s", (_label, v) => {
    expect(typeof normalizeVisibleAgents(v)).toBe("string");
  });
});
