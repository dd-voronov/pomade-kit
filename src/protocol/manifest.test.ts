import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./types.js";
import {
  launchPanelIcon,
  parseManifest,
  resolveFrameTarget,
  resolveOverlayTarget,
  symlinkScopeCovers,
  type ManifestParseResult,
} from "./manifest.js";
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
    const r = parseManifest({ ...valid, sidePanels: [], dashboard: {} });
    expect(r).toMatchObject({ ok: true, unsupportedKeys: ["sidePanels", "dashboard"] });
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
    ["id", { id: "pomade" }],
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
    ["capabilities", { capabilities: ["files.delete"] }],
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
    const r = parseManifest({ ...valid, capabilities: ["files.read", "files.delete", "x"] });
    expect(!r.ok && r.errors).toEqual([
      { field: "capabilities", message: `"capabilities" has unknown capability "files.delete"; known: ${CAPABILITIES.join(", ")}` },
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

describe("parseManifest — startOnLaunch", () => {
  const panel = { id: "planner", title: "Planner", action: "panel" };
  const tab = { id: "log", title: "Log", action: "tab" };
  const both = { id: "board", title: "Board", action: "both" };

  it("absent: not on the manifest; false and true are kept", () => {
    const absent = parseManifest({ ...valid, strip: [panel] });
    expect(absent.ok && absent.manifest).not.toHaveProperty("startOnLaunch");
    for (const v of [true, false]) {
      const r = parseManifest({ ...valid, strip: [panel], startOnLaunch: v });
      expect(r.ok && r.manifest.startOnLaunch).toBe(v);
      expect(r.ok && r.unsupportedKeys).toEqual([]);
    }
  });

  it.each([1, "yes", null, {}])("must be a boolean (%j)", (v) => {
    const r = parseManifest({ ...valid, strip: [panel], startOnLaunch: v });
    expect(r).toMatchObject({ ok: false, field: "startOnLaunch", message: `"startOnLaunch" must be a boolean (got ${JSON.stringify(v)})` });
  });

  it.each<[string, unknown]>([
    ["no strip", undefined],
    ["an empty strip", []],
    ["only tab icons", [tab]],
  ])("true needs a panel or both icon: %s", (_label, strip) => {
    const r = parseManifest({ ...valid, ...(strip === undefined ? {} : { strip }), startOnLaunch: true });
    expect(r).toMatchObject({ ok: false, field: "startOnLaunch", message: '"startOnLaunch" needs a strip icon with action "panel" or "both"' });
  });

  it("false never needs one", () => {
    expect(parseManifest({ ...valid, startOnLaunch: false }).ok).toBe(true);
  });

  it("a panel icon with other errors does not add a startOnLaunch error", () => {
    const r = parseManifest({ ...valid, strip: [{ id: "X", title: "", action: "panel" }], startOnLaunch: true });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual(["strip[0].id", "strip[0].title"]);
  });

  it("is reported with every other invalid field, in key order", () => {
    const r = parseManifest({ ...valid, name: "", strip: [tab], startOnLaunch: true });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual(["name", "startOnLaunch"]);
  });

  it("launchPanelIcon: the first panel or both icon, only when startOnLaunch", () => {
    const ok = (m: unknown) => {
      const r = parseManifest(m);
      if (!r.ok) throw new Error(r.message);
      return r.manifest;
    };
    expect(launchPanelIcon(ok({ ...valid, strip: [tab, both, panel], startOnLaunch: true }))?.id).toBe("board");
    expect(launchPanelIcon(ok({ ...valid, strip: [panel, both], startOnLaunch: true }))?.id).toBe("planner");
    expect(launchPanelIcon(ok({ ...valid, strip: [panel], startOnLaunch: false }))).toBeUndefined();
    expect(launchPanelIcon(ok({ ...valid, strip: [panel] }))).toBeUndefined();
  });
});

describe("parseManifest — shortcuts", () => {
  const quick = { id: "today", title: " Open Today ", key: "cmd + shift + t", action: "tab", route: "today", extra: 1 };

  it("absent: not on the manifest; an empty list is kept", () => {
    const absent = parseManifest(valid);
    expect(absent.ok && absent.manifest).not.toHaveProperty("shortcuts");
    const empty = parseManifest({ ...valid, shortcuts: [] });
    expect(empty.ok && empty.manifest.shortcuts).toEqual([]);
  });

  it("reads shortcuts in order: trimmed title, canonical key, default route, unknown keys ignored", () => {
    const r = parseManifest({ ...valid, shortcuts: [quick, { id: "board", title: "Board", key: "Cmd+Alt+2", action: "tab" }] });
    expect(r.ok && r.manifest.shortcuts).toEqual([
      { id: "today", title: "Open Today", key: "Cmd+Shift+T", action: "tab", route: "today" },
      { id: "board", title: "Board", key: "Cmd+Alt+2", action: "tab", route: "" },
    ]);
    expect(r.ok && r.unsupportedKeys).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["not an array", { a: 1 }, "shortcuts"],
    ["an item not an object", ["x"], "shortcuts[0]"],
    ["id missing", [{ ...quick, id: undefined }], "shortcuts[0].id"],
    ["id uppercase", [{ ...quick, id: "Today" }], "shortcuts[0].id"],
    ["title empty", [{ ...quick, title: " " }], "shortcuts[0].title"],
    ["key missing", [{ ...quick, key: undefined }], "shortcuts[0].key"],
    ["key without Cmd", [{ ...quick, key: "Ctrl+K" }], "shortcuts[0].key"],
    ["key without a key", [{ ...quick, key: "Cmd+Shift" }], "shortcuts[0].key"],
    ["key a named key", [{ ...quick, key: "Cmd+Enter" }], "shortcuts[0].key"],
    ["key a repeated modifier", [{ ...quick, key: "Cmd+Cmd+K" }], "shortcuts[0].key"],
    ["key a number", [{ ...quick, key: 3 }], "shortcuts[0].key"],
    ["action unknown", [{ ...quick, action: "popup" }], "shortcuts[0].action"],
    ["action missing", [{ ...quick, action: undefined }], "shortcuts[0].action"],
    ["route not a string", [{ ...quick, route: 1 }], "shortcuts[0].route"],
  ])("rejects %s", (_label, shortcuts, field) => {
    const r = parseManifest({ ...valid, shortcuts });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual([field]);
  });

  it("messages name the rule and the value received", () => {
    const r = parseManifest({ ...valid, shortcuts: [{ ...quick, key: "Ctrl+K", action: "popup" }] });
    expect(!r.ok && r.errors.map((e) => e.message)).toEqual([
      '"shortcuts[0].key" must be a key chord: Cmd, then any of Ctrl, Alt, Shift, then one letter or digit, joined by + (Cmd+Shift+K) (got "Ctrl+K")',
      '"shortcuts[0].action" must be one of tab, overlay (got "popup")',
    ]);
  });

  it("overlay is an action; resolveOverlayTarget gives the overlay surface at the shortcut's route", () => {
    const r = parseManifest({ ...valid, shortcuts: [{ id: "quick-add", title: "Quick add", key: "Cmd+Shift+J", action: "overlay", route: "quick-add" }] });
    if (!r.ok) throw new Error(r.message);
    expect(r.manifest.shortcuts?.[0]?.action).toBe("overlay");
    expect(resolveOverlayTarget(r.manifest.shortcuts ?? [], "quick-add")).toEqual({ surface: "overlay", route: "quick-add" });
    expect(resolveOverlayTarget(r.manifest.shortcuts ?? [], "nope")).toEqual({ surface: "overlay", route: "" });
    expect(resolveOverlayTarget([])).toEqual({ surface: "overlay", route: "" });
  });

  it("a repeated id or chord is reported on the later shortcut; chords compare canonically", () => {
    const r = parseManifest({
      ...valid,
      shortcuts: [quick, { ...quick, key: "Cmd+K" }, { ...quick, id: "other", key: "Shift+Cmd+T" }],
    });
    expect(!r.ok && r.errors.map((e) => e.message)).toEqual([
      '"shortcuts[1].id" repeats the shortcut id "today"',
      '"shortcuts[2].key" repeats Cmd+Shift+T, already used by shortcuts[0]',
    ]);
  });

  it("reports every invalid field of every shortcut, after the other fields", () => {
    const r = parseManifest({ ...valid, name: "", shortcuts: [{ id: "X", title: "", key: "K", action: "x" }, quick] });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual([
      "name",
      "shortcuts[0].id",
      "shortcuts[0].title",
      "shortcuts[0].key",
      "shortcuts[0].action",
    ]);
  });
});

describe("parseManifest — skills", () => {
  it("absent: not on the manifest; an empty list is kept", () => {
    const absent = parseManifest(valid);
    expect(absent.ok && absent.manifest).not.toHaveProperty("skills");
    const empty = parseManifest({ ...valid, skills: [] });
    expect(empty.ok && empty.manifest.skills).toEqual([]);
  });

  it("each folder's last segment is the skill name, in order", () => {
    const r = parseManifest({ ...valid, skills: ["skills/pomade-runner-jobs", "agent.format_v2", "a/b/c"] });
    expect(r.ok && r.manifest.skills).toEqual([
      { name: "pomade-runner-jobs", path: "skills/pomade-runner-jobs" },
      { name: "agent.format_v2", path: "agent.format_v2" },
      { name: "c", path: "a/b/c" },
    ]);
    expect(r.ok && r.unsupportedKeys).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["not an array", "skills/x", "skills"],
    ["not a string", [3], "skills[0]"],
    ["empty", [""], "skills[0]"],
    ["absolute", ["/skills/x"], "skills[0]"],
    ["escaping", ["../x"], "skills[0]"],
    ["a dot segment", ["skills/./x"], "skills[0]"],
    ["a trailing slash", ["skills/x/"], "skills[0]"],
    ["an uppercase name", ["skills/Jobs"], "skills[0]"],
    ["a name starting with a dash", ["skills/-x"], "skills[0]"],
  ])("rejects %s", (_label, skills, field) => {
    const r = parseManifest({ ...valid, skills });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual([field]);
  });

  it("messages: the rule, the value; a repeated name is reported on the later entry", () => {
    const r = parseManifest({ ...valid, skills: ["a/jobs", "b/jobs", "../x", "skills/Jobs"] });
    expect(!r.ok && r.errors.map((e) => e.message)).toEqual([
      '"skills[1]" repeats the skill name "jobs", already used by skills[0]',
      '"skills[2]" must be a relative folder path inside the build folder (got "../x")',
      '"skills[3]" must end in a skill name matching ^[a-z0-9][a-z0-9._-]{0,63}$ (got "skills/Jobs")',
    ]);
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

describe("parseManifest — symlinks", () => {
  const base = { id: "pomade-agents", name: "Agents", version: "0.1.0", hostApi: 0, capabilities: ["files.symlink"] };

  it("accepts folder patterns with whole-segment wildcards, deduped", () => {
    const r = parseManifest({ ...base, symlinks: ["Agents/*/skills", "Knowledge/_skills", "Agents/*/skills"] });
    expect(r.ok && r.manifest.symlinks).toEqual(["Agents/*/skills", "Knowledge/_skills"]);
    expect(r.ok && r.unsupportedKeys).toEqual([]);
  });

  it("absent: no symlinks on the manifest", () => {
    const r = parseManifest(base);
    expect(r.ok && r.manifest).not.toHaveProperty("symlinks");
  });

  it.each([["/abs"], [""], ["a/../b"], ["a/sk*"], ["./a"], ["a//b"], [3], ["a\\b"]])("refuses %j, naming its index", (bad) => {
    const r = parseManifest({ ...base, symlinks: ["ok", bad] });
    expect(!r.ok && r.errors.map((e) => e.field)).toEqual(["symlinks[1]"]);
  });

  it("refuses a non-array", () => {
    const r = parseManifest({ ...base, symlinks: "Agents/*/skills" });
    expect(!r.ok && r.field).toBe("symlinks");
  });
});

describe("symlinkScopeCovers", () => {
  const scopes = ["Agents/*/skills", "Knowledge/_skills"];
  it.each([
    ["Agents/claude-coder/skills/pomade-runner-jobs", true],
    ["Knowledge/_skills/x", true],
    ["Agents/claude-coder/skills", false],
    ["Agents/claude-coder/skills/a/b", false],
    ["Agents/skills/x", false],
    ["Knowledge/_skills", false],
    ["x", false],
    ["", false],
  ])("%s → %s", (path, covered) => {
    expect(symlinkScopeCovers(scopes, path)).toBe(covered);
  });
  it("no scopes cover nothing", () => {
    expect(symlinkScopeCovers([], "Agents/a/skills/x")).toBe(false);
  });
});

describe("backend", () => {
  it("accepts a with-pomade or always-on Node entry; restartOnUpdate defaults to false", () => {
    for (const entry of ["backend/main.js", "server.mjs", "b/c.cjs"]) {
      const r = parseManifest({ ...valid, backend: { entry, mode: "with-pomade" } });
      expect(r.ok && r.manifest.backend).toEqual({ entry, mode: "with-pomade", restartOnUpdate: false });
    }
    const r = parseManifest({ ...valid, backend: { entry: "keeper.js", mode: "always-on", restartOnUpdate: true, extra: 1 } });
    expect(r.ok && r.manifest.backend).toEqual({ entry: "keeper.js", mode: "always-on", restartOnUpdate: true });
    expect(parseManifest(valid).ok && (parseManifest(valid) as { manifest: object }).manifest).not.toHaveProperty("backend");
  });

  it.each<[string, unknown]>([
    ["backend", "main.js"],
    ["backend", []],
    ["backend.entry", { mode: "with-pomade" }],
    ["backend.entry", { entry: "/abs/main.js", mode: "with-pomade" }],
    ["backend.entry", { entry: "../main.js", mode: "with-pomade" }],
    ["backend.entry", { entry: "main.ts", mode: "with-pomade" }],
    ["backend.mode", { entry: "main.js" }],
    ["backend.mode", { entry: "main.js", mode: "always" }],
    ["backend.restartOnUpdate", { entry: "main.js", mode: "always-on", restartOnUpdate: "yes" }],
    ["backend.restartOnUpdate", { entry: "main.js", mode: "with-pomade", restartOnUpdate: true }],
  ])("%s is invalid: %j", (field, backend) => {
    const r = parseManifest({ ...valid, backend });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.field)).toContain(field);
  });

  it("reports every invalid backend field", () => {
    const r = parseManifest({ ...valid, backend: { entry: 3, mode: 4 } });
    expect(!r.ok && r.errors.map((e) => e.message)).toEqual([
      '"backend.entry" must be a .js, .mjs or .cjs file inside the build folder (got 3)',
      '"backend.mode" must be one of with-pomade, always-on (got 4)',
    ]);
  });
});

describe("api and calls", () => {
  it("keeps the declared methods and called apps", () => {
    const r = parseManifest({ ...valid, api: ["today", "jobsForRepo", "sessions.list"], calls: ["pomade-agents", "pomade-runner"] });
    expect(r.ok && r.manifest).toMatchObject({ api: ["today", "jobsForRepo", "sessions.list"], calls: ["pomade-agents", "pomade-runner"] });
    expect(parseManifest({ ...valid, api: [], calls: [] }).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["api", { api: "today" }],
    ["api[0]", { api: ["Today"] }],
    ["api[0]", { api: ["to day"] }],
    ["api[0]", { api: ["a..b"] }],
    ["api[0]", { api: [1] }],
    ["api[0]", { api: ["a" + "b".repeat(64)] }],
    ["api[1]", { api: ["today", "today"] }],
    ["calls", { calls: "pomade-agents" }],
    ["calls[0]", { calls: ["Pomade"] }],
    ["calls[0]", { calls: ["pomade"] }],
    ["calls[0]", { calls: ["pomade-planner"] }],
    ["calls[1]", { calls: ["pomade-agents", "pomade-agents"] }],
  ])("%s is invalid: %j", (field, patch) => {
    const r = parseManifest({ ...valid, ...patch });
    expect(!r.ok && r.errors.map((e) => e.field)).toContain(field);
  });
});

describe("commands", () => {
  it("named after the app; title defaults to empty", () => {
    const r = parseManifest({
      ...valid,
      commands: [
        { name: "pomade-planner", entry: "cli/main.js", title: " Today's items " },
        { name: "pomade-planner-today", entry: "cli/today.mjs" },
      ],
    });
    expect(r.ok && r.manifest.commands).toEqual([
      { name: "pomade-planner", entry: "cli/main.js", title: "Today's items" },
      { name: "pomade-planner-today", entry: "cli/today.mjs", title: "" },
    ]);
  });

  it.each<[string, unknown]>([
    ["commands", "x"],
    ["commands[0]", ["x"]],
    ["commands[0].name", [{ name: "ls", entry: "a.js" }]],
    ["commands[0].name", [{ name: "pomade-plannerx", entry: "a.js" }]],
    ["commands[0].name", [{ name: "Pomade-planner", entry: "a.js" }]],
    ["commands[0].name", [{ entry: "a.js" }]],
    ["commands[1].name", [{ name: "pomade-planner", entry: "a.js" }, { name: "pomade-planner", entry: "b.js" }]],
    ["commands[0].entry", [{ name: "pomade-planner", entry: "a.sh" }]],
    ["commands[0].entry", [{ name: "pomade-planner", entry: "../a.js" }]],
    ["commands[0].title", [{ name: "pomade-planner", entry: "a.js", title: 1 }]],
  ])("%s is invalid: %j", (field, commands) => {
    const r = parseManifest({ ...valid, commands });
    expect(!r.ok && r.errors.map((e) => e.field)).toContain(field);
  });

  it("Pomade's own command names are reserved", () => {
    const r = parseManifest({ ...valid, id: "pomade-git", commands: [{ name: "pomade-git", entry: "a.js" }] });
    expect(!r.ok && r.errors[0]?.message).toMatch(/one of Pomade's own commands/);
  });
});
