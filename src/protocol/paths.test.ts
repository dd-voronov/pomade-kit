import { describe, expect, it } from "vitest";
import { baseName, isInside, joinPath, normalizeWorkspacePath, parentPath } from "./paths.js";

describe("normalizeWorkspacePath", () => {
  it.each([
    ["", ""],
    [".", ""],
    ["docs", "docs"],
    ["docs/roadmap", "docs/roadmap"],
    ["docs/roadmap/", "docs/roadmap"],
    ["./docs//roadmap/.", "docs/roadmap"],
    ["docs/../src", "src"],
    ["a/b/../../c", "c"],
    ["a/..", ""],
    ["name with spaces/é.md", "name with spaces/é.md"],
  ])("%j → %j", (input, out) => {
    expect(normalizeWorkspacePath(input)).toEqual({ ok: true, path: out });
  });

  it.each(["/", "/etc/passwd", "..", "../x", "a/../../x", "./../x", "a/b/../../../c"])("%j is outside", (input) => {
    expect(normalizeWorkspacePath(input)).toEqual({ ok: false });
  });
});

describe("joinPath / baseName / parentPath", () => {
  it("joins a project root with a relative path", () => {
    expect(joinPath("Projects/Pomade", "docs/roadmap")).toBe("Projects/Pomade/docs/roadmap");
    expect(joinPath("", "docs/roadmap")).toBe("docs/roadmap");
    expect(joinPath("Projects/Pomade/", "docs/")).toBe("Projects/Pomade/docs");
    expect(joinPath("", "")).toBe("");
  });
  it("splits names", () => {
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("c.md")).toBe("c.md");
    expect(parentPath("a/b/c.md")).toBe("a/b");
    expect(parentPath("c.md")).toBe("");
  });
});

describe("isInside", () => {
  it.each([
    ["a/b", "a", true],
    ["a", "a", true],
    ["ab", "a", false],
    ["a", "a/b", false],
    ["x", "", true],
    ["", "", true],
  ])("%j inside %j → %s", (path, folder, inside) => {
    expect(isInside(path, folder)).toBe(inside);
  });
});
