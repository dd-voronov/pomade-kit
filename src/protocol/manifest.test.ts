import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";

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
    expect(parseManifest(v)).toMatchObject({ ok: false, field: "" });
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

  it("accepts the longest valid id", () => {
    expect(parseManifest({ ...valid, id: "a" + "b".repeat(63) }).ok).toBe(true);
  });
});
