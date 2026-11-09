import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspace } from "./index.js";

describe("resolveWorkspace", () => {
  it("returns POMADE_WORKSPACE as an absolute path", () => {
    expect(resolveWorkspace({ POMADE_WORKSPACE: "/Users/x/git-base" })).toBe("/Users/x/git-base");
    expect(resolveWorkspace({ POMADE_WORKSPACE: "rel/ws" })).toBe(resolve("rel/ws"));
    expect(resolveWorkspace({ POMADE_WORKSPACE: "/Users/x/git-base/" })).toBe("/Users/x/git-base");
  });

  it("null when unset or empty", () => {
    expect(resolveWorkspace({})).toBeNull();
    expect(resolveWorkspace({ POMADE_WORKSPACE: "" })).toBeNull();
  });

  it("reads process.env by default", () => {
    const saved = process.env.POMADE_WORKSPACE;
    try {
      process.env.POMADE_WORKSPACE = "/tmp/ws";
      expect(resolveWorkspace()).toBe("/tmp/ws");
    } finally {
      if (saved === undefined) delete process.env.POMADE_WORKSPACE;
      else process.env.POMADE_WORKSPACE = saved;
    }
  });
});
