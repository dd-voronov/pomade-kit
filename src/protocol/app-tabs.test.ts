import { describe, expect, it } from "vitest";

import { APP_TAB_KEY_RE, checkOpenAppParams, checkTabRoute, checkTabTitle } from "./app-tabs.js";

const KINDS = { output: { title: "Output", icon: "output.svg" } };

describe("tabs.openApp params", () => {
  it("without key: route defaulted, projectId kept, unknown keys dropped", () => {
    expect(checkOpenAppParams(undefined, KINDS)).toEqual({ ok: true, value: { route: "" } });
    expect(checkOpenAppParams({ route: "board", projectId: "p1", extra: 1 }, undefined)).toEqual({
      ok: true,
      value: { route: "board", projectId: "p1" },
    });
  });

  it("a keyed tab: key, trimmed title and a declared kind", () => {
    expect(checkOpenAppParams({ key: "output:run-1", title: "  Scraper · output ", kind: "output", route: "output/run-1" }, KINDS)).toEqual({
      ok: true,
      value: { route: "output/run-1", key: "output:run-1", title: "Scraper · output", kind: "output" },
    });
  });

  it.each<[string, unknown, string]>([
    ["route not a string", { route: 1 }, '"route" must be a string'],
    ["projectId not a string", { projectId: 1 }, '"projectId" must be a project id'],
    ["params not an object", "x", "params must be an object"],
    ["params an array", [], "params must be an object"],
    ["key not a string", { key: 1 }, `"key" must match ${APP_TAB_KEY_RE.source}`],
    ["empty key", { key: "" }, `"key" must match ${APP_TAB_KEY_RE.source}`],
    ["key starting with a dot", { key: ".a" }, `"key" must match ${APP_TAB_KEY_RE.source}`],
    ["key with a slash", { key: "a/b" }, `"key" must match ${APP_TAB_KEY_RE.source}`],
    ["key of 129 characters", { key: "a".repeat(129) }, `"key" must match ${APP_TAB_KEY_RE.source}`],
    ["blank title", { key: "a", title: "  " }, '"title" must be a non-empty string'],
    ["title not a string", { key: "a", title: 3 }, '"title" must be a non-empty string'],
    ["title without key", { title: "A" }, '"title" needs "key": only a keyed tab takes an app title'],
    ["kind without key", { kind: "output" }, '"kind" needs "key": only a keyed tab has a kind'],
    ["kind not a string", { key: "a", kind: 1 }, '"kind" must be a tab kind id'],
    ["unknown kind", { key: "a", kind: "log" }, 'No tab kind "log" in the manifest\'s "tabKinds"'],
    ["inherited name as kind", { key: "a", kind: "toString" }, 'No tab kind "toString" in the manifest\'s "tabKinds"'],
  ])("%s → invalid", (_label, params, message) => {
    expect(checkOpenAppParams(params, KINDS)).toEqual({ ok: false, message });
  });

  it("a kind needs a manifest that declares tab kinds", () => {
    expect(checkOpenAppParams({ key: "a", kind: "output" }, undefined)).toEqual({
      ok: false,
      message: 'No tab kind "output" in the manifest\'s "tabKinds"',
    });
  });

  it("keys: letters, digits, then . _ : - up to 128 characters", () => {
    for (const ok of ["a", "A", "0", "output:run-1", "a.b_c-d:e", "a".repeat(128)]) expect(APP_TAB_KEY_RE.test(ok)).toBe(true);
    for (const bad of ["", "-a", ":a", "a b", "a/b", "é", "a".repeat(129)]) expect(APP_TAB_KEY_RE.test(bad)).toBe(false);
  });
});

describe("tabs.setTitle title", () => {
  it("a string that is not blank", () => {
    expect(checkTabTitle("A")).toBeNull();
    expect(checkTabTitle(" A ")).toBeNull();
    for (const bad of ["", "  ", 1, null, undefined]) expect(checkTabTitle(bad)).toBe('"title" must be a non-empty string');
  });
});

describe("tabs.setRoute route", () => {
  it("any string, the empty default view included", () => {
    for (const ok of ["", "card/1", " a b "]) expect(checkTabRoute(ok)).toBeNull();
    for (const bad of [1, null, undefined, {}]) expect(checkTabRoute(bad)).toBe('"route" must be a string');
  });
});
