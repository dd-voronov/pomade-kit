import { describe, expect, it } from "vitest";
import { parseManifest, resolveFrameTarget, type ManifestParseResult } from "./manifest.js";
import type { StripIcon } from "./types.js";

const valid = { id: "pomade-planner", name: "Planner", version: "0.1.0", hostApi: 0, capabilities: ["project.read", "files.read"] };

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parseManifest(valid)).toEqual({ ok: true, manifest: valid, unsupportedKeys: [] });
  });

  it("keeps optional entry and icon", () => {
    const r = parseManifest({ ...valid, entry: "app/index.html", icon: "icon.svg" });
    expect(r.ok && r.manifest).toMatchObject({ entry: "app/index.html", icon: "icon.svg" });
  });

  it("lists unknown top-level keys as unsupported, still valid", () => {
    const r = parseManifest({ ...valid, sidePanels: [], shortcuts: {} });
    expect(r).toMatchObject({ ok: true, unsupportedKeys: ["sidePanels", "shortcuts"] });
    expect(r.ok && r.manifest).not.toHaveProperty("sidePanels");
  });

  it("accepts an empty capability list and prerelease versions", () => {
    expect(parseManifest({ ...valid, capabilities: [], version: "1.0.0-beta.1+build.5" }).ok).toBe(true);
  });

  it.each([null, [], "x", 1])("rejects a non-object %j", (v) => {
    expect(parseManifest(v)).toEqual({
      ok: false,
      field: "",
      message: "manifest must be a JSON object",
      errors: [{ field: "", message: "manifest must be a JSON object" }],
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["id", { id: undefined }],
    ["id", { id: "Planner" }],
    ["id", { id: "p" }],
    ["id", { id: "1abc" }],
    ["id", { id: "a_b" }],
    ["id", { id: "a" + "b".repeat(64) }],
    ["name", { name: "" }],
    ["name", { name: "  " }],
    ["name", { name: 3 }],
    ["version", { version: "1.0" }],
    ["version", { version: "v1.0.0" }],
    ["version", { version: "01.0.0" }],
    ["hostApi", { hostApi: "0" }],
    ["hostApi", { hostApi: -1 }],
    ["hostApi", { hostApi: 0.5 }],
    ["hostApi", { hostApi: undefined }],
    ["entry", { entry: "" }],
    ["entry", { entry: "/index.html" }],
    ["entry", { entry: "../index.html" }],
    ["entry", { entry: "a//b.html" }],
    ["entry", { entry: 5 }],
    ["icon", { icon: "../icon.svg" }],
    ["capabilities", { capabilities: undefined }],
    ["capabilities", { capabilities: "files.read" }],
    ["capabilities", { capabilities: ["files.write"] }],
    ["capabilities", { capabilities: [1] }],
  ])("rejects a bad %s (%j) with a message naming the field", (field, patch) => {
    const r = parseManifest({ ...valid, ...patch });
    expect(r).toMatchObject({ ok: false, field });
    expect(!r.ok && r.message).toContain(`"${field}"`);
  });

  it("names the received value in the message", () => {
    expect(parseManifest({ ...valid, hostApi: "zero" })).toMatchObject({
      field: "hostApi",
      message: '"hostApi" must be a non-negative integer (got "zero")',
    });
    expect(parseManifest({ ...valid, id: undefined })).toMatchObject({ message: expect.stringMatching(/\(missing\)$/) });
  });

  it("reports every invalid field at once, in key order; field/message are the first error", () => {
    const r = parseManifest({ id: "X", version: "x", hostApi: "zero", icon: "/i.svg", strip: [{ id: "a" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual(["id", "name", "version", "hostApi", "icon", "capabilities", "strip[0].title", "strip[0].action"]);
    expect(r.field).toBe("id");
    expect(r.message).toBe(r.errors[0]?.message);
    for (const e of r.errors) expect(e.message).toContain(`"${e.field}"`);
  });

  it("reports one unknown capability once", () => {
    const r = parseManifest({ ...valid, capabilities: ["files.read", "files.write", "x"] });
    expect(!r.ok && r.errors).toEqual([
      { field: "capabilities", message: '"capabilities" has unknown capability "files.write"; known: project.read, files.read' },
    ]);
  });

  it("accepts the longest valid id", () => {
    expect(parseManifest({ ...valid, id: "a" + "b".repeat(63) }).ok).toBe(true);
  });
});

function errorFields(r: ManifestParseResult): string[] {
  return r.ok ? [] : r.errors.map((e) => e.field);
}

describe("parseManifest — strip", () => {
  const icon = { id: "p", title: "P", action: "panel" };

  it("absent strip: no strip on the manifest", () => {
    const r = parseManifest(valid);
    expect(r.ok && r.manifest).not.toHaveProperty("strip");
  });

  it("an empty strip is kept", () => {
    const r = parseManifest({ ...valid, strip: [] });
    expect(r.ok && r.manifest.strip).toEqual([]);
  });

  it("reads icons in order, trims titles, defaults the route, ignores unknown icon keys", () => {
    const r = parseManifest({
      ...valid,
      strip: [
        { id: "planner", title: " Planner ", icon: "img/planner.svg", action: "panel", badgeColor: "x" },
        { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" },
        { id: "log", title: "Log", action: "tab", route: "" },
        { id: "b-2", title: "B", action: "both", panelRoute: "" },
      ],
    });
    expect(r.ok && r.manifest.strip).toEqual([
      { id: "planner", title: "Planner", icon: "img/planner.svg", action: "panel", route: "" },
      { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" },
      { id: "log", title: "Log", action: "tab", route: "" },
      { id: "b-2", title: "B", action: "both", route: "", panelRoute: "" },
    ]);
    expect(r.ok && r.unsupportedKeys).toEqual([]);
  });

  it.each(["a", "a1", "a-b", "z" + "9".repeat(31)])("accepts icon id %j", (id) => {
    expect(parseManifest({ ...valid, strip: [{ ...icon, id }] }).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["strip not an array", { strip: { id: "p" } }, "strip"],
    ["strip null", { strip: null }, "strip"],
    ["icon not an object", { strip: ["p"] }, "strip[0]"],
    ["icon null", { strip: [null] }, "strip[0]"],
    ["icon an array", { strip: [[]] }, "strip[0]"],
    ["icon id missing", { strip: [{ ...icon, id: undefined }] }, "strip[0].id"],
    ["icon id not a string", { strip: [{ ...icon, id: 1 }] }, "strip[0].id"],
    ["icon id empty", { strip: [{ ...icon, id: "" }] }, "strip[0].id"],
    ["icon id uppercase", { strip: [{ ...icon, id: "P" }] }, "strip[0].id"],
    ["icon id leading digit", { strip: [{ ...icon, id: "1p" }] }, "strip[0].id"],
    ["icon id leading dash", { strip: [{ ...icon, id: "-p" }] }, "strip[0].id"],
    ["icon id underscore", { strip: [{ ...icon, id: "a_b" }] }, "strip[0].id"],
    ["icon id too long", { strip: [{ ...icon, id: "p".repeat(33) }] }, "strip[0].id"],
    ["icon id repeated", { strip: [icon, { ...icon, title: "Other" }] }, "strip[1].id"],
    ["title missing", { strip: [{ ...icon, title: undefined }] }, "strip[0].title"],
    ["title empty", { strip: [{ ...icon, title: "" }] }, "strip[0].title"],
    ["title blank", { strip: [{ ...icon, title: " \t" }] }, "strip[0].title"],
    ["title not a string", { strip: [{ ...icon, title: 3 }] }, "strip[0].title"],
    ["icon path escapes", { strip: [{ ...icon, icon: "../x.svg" }] }, "strip[0].icon"],
    ["icon path absolute", { strip: [{ ...icon, icon: "/x.svg" }] }, "strip[0].icon"],
    ["icon path not a string", { strip: [{ ...icon, icon: 1 }] }, "strip[0].icon"],
    ["action unknown", { strip: [{ ...icon, action: "popup" }] }, "strip[0].action"],
    ["action missing", { strip: [{ ...icon, action: undefined }] }, "strip[0].action"],
    ["action wrong case", { strip: [{ ...icon, action: "Panel" }] }, "strip[0].action"],
    ["route not a string", { strip: [{ ...icon, route: 3 }] }, "strip[0].route"],
    ["route null", { strip: [{ ...icon, route: null }] }, "strip[0].route"],
    ["panelRoute with panel", { strip: [{ ...icon, panelRoute: "x" }] }, "strip[0].panelRoute"],
    ["panelRoute with tab", { strip: [{ ...icon, action: "tab", panelRoute: "x" }] }, "strip[0].panelRoute"],
    ["panelRoute not a string", { strip: [{ ...icon, action: "both", panelRoute: 1 }] }, "strip[0].panelRoute"],
  ])("rejects %s, naming the icon field", (_label, patch, field) => {
    const r = parseManifest({ ...valid, ...patch });
    expect(errorFields(r)).toEqual([field]);
    expect(!r.ok && r.message).toContain(`"${field}"`);
  });

  it("messages: received value, repeated id, panelRoute rule", () => {
    const messages = (patch: Record<string, unknown>) => {
      const r = parseManifest({ ...valid, ...patch });
      return r.ok ? [] : r.errors.map((e) => e.message);
    };
    expect(messages({ strip: [{ ...icon, action: "popup" }] })).toEqual(['"strip[0].action" must be one of panel, tab, both (got "popup")']);
    expect(messages({ strip: [{ ...icon, title: undefined }] })).toEqual(['"strip[0].title" must be a non-empty string (missing)']);
    expect(messages({ strip: [icon, icon] })).toEqual(['"strip[1].id" repeats the icon id "p"']);
    expect(messages({ strip: [{ ...icon, panelRoute: "x" }] })).toEqual(['"strip[0].panelRoute" is only for action "both"']);
    expect(messages({ strip: 1 })).toEqual(['"strip" must be an array of icons (got 1)']);
  });

  it("reports every invalid field of every icon", () => {
    const r = parseManifest({
      ...valid,
      strip: [{ id: "A", title: "", action: "x", route: 1 }, icon, "nope", { ...icon, panelRoute: 2 }, icon],
    });
    expect(errorFields(r)).toEqual([
      "strip[0].id",
      "strip[0].title",
      "strip[0].action",
      "strip[0].route",
      "strip[2]",
      "strip[3].id",
      "strip[3].panelRoute",
      "strip[4].id",
    ]);
  });

  it("an invalid icon's id still counts for repeats only when the id itself is valid", () => {
    expect(errorFields(parseManifest({ ...valid, strip: [{ ...icon, action: "x" }, icon] }))).toEqual(["strip[0].action", "strip[1].id"]);
  });
});

describe("resolveFrameTarget", () => {
  const strip: StripIcon[] = [
    { id: "planner", title: "Planner", action: "panel", route: "" },
    { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" },
    { id: "log", title: "Log", action: "both", route: "log" },
  ];

  it.each<[string, "tab" | "panel", string | undefined, object]>([
    ["tab, no icon", "tab", undefined, { surface: "tab", route: "" }],
    ["panel, no icon", "panel", undefined, { surface: "panel", route: "" }],
    ["tab for an icon takes its route", "tab", "board", { surface: "tab", icon: "board", route: "board" }],
    ["panel takes panelRoute", "panel", "board", { surface: "panel", icon: "board", route: "needs-you" }],
    ["panel falls back to route", "panel", "log", { surface: "panel", icon: "log", route: "log" }],
    ["default route", "panel", "planner", { surface: "panel", icon: "planner", route: "" }],
    ["unknown icon → default view, no icon", "tab", "ghost", { surface: "tab", route: "" }],
    ["unknown icon on a panel", "panel", "ghost", { surface: "panel", route: "" }],
  ])("%s", (_label, surface, icon, expected) => {
    expect(resolveFrameTarget(strip, surface, icon)).toEqual(expected);
  });

  it("an empty strip resolves every icon to the default view", () => {
    expect(resolveFrameTarget([], "tab", "board")).toEqual({ surface: "tab", route: "" });
  });
});
