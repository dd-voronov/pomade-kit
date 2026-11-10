import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pomadeHome, readHostRecord, resolveWorkspace } from "./index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kit-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("pomadeHome", () => {
  it("POMADE_HOME, absolute; else the stable Pomade's ~/.pomade", () => {
    expect(pomadeHome({ POMADE_HOME: "/x/home/" })).toBe("/x/home");
    expect(pomadeHome({ POMADE_HOME: "rel" })).toBe(resolve("rel"));
    expect(pomadeHome({})).toBe(join(homedir(), ".pomade"));
  });
});

describe("resolveWorkspace", () => {
  it("returns POMADE_WORKSPACE as an absolute path", () => {
    expect(resolveWorkspace({ POMADE_WORKSPACE: "/Users/x/git-base", POMADE_HOME: home })).toBe("/Users/x/git-base");
    expect(resolveWorkspace({ POMADE_WORKSPACE: "rel/ws", POMADE_HOME: home })).toBe(resolve("rel/ws"));
    expect(resolveWorkspace({ POMADE_WORKSPACE: "/Users/x/git-base/", POMADE_HOME: home })).toBe("/Users/x/git-base");
  });

  it("falls back to the pointer Pomade records in its home", () => {
    writeFileSync(join(home, "workspace"), "/Users/x/ws\n");
    expect(resolveWorkspace({ POMADE_HOME: home })).toBe("/Users/x/ws");
    expect(resolveWorkspace({ POMADE_HOME: home, POMADE_WORKSPACE: "" })).toBe("/Users/x/ws");
  });

  it("null without either, or with a pointer that is not an absolute path", () => {
    expect(resolveWorkspace({ POMADE_HOME: home })).toBeNull();
    writeFileSync(join(home, "workspace"), "relative/ws\n");
    expect(resolveWorkspace({ POMADE_HOME: home })).toBeNull();
    writeFileSync(join(home, "workspace"), "");
    expect(resolveWorkspace({ POMADE_HOME: home })).toBeNull();
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

describe("readHostRecord", () => {
  it("reads host.json from the home; null when missing or malformed", () => {
    expect(readHostRecord({ POMADE_HOME: home })).toBeNull();
    const record = { socket: "/u/run/pomade.sock", launch: { argv: ["/usr/bin/open", "-a", "/Applications/Pomade.app"], env: {} } };
    writeFileSync(join(home, "host.json"), JSON.stringify(record));
    expect(readHostRecord({ POMADE_HOME: home })).toEqual(record);
    writeFileSync(join(home, "host.json"), "{");
    expect(readHostRecord({ POMADE_HOME: home })).toBeNull();
    mkdirSync(join(home, "sub"));
    expect(readHostRecord({ POMADE_HOME: join(home, "sub") })).toBeNull();
  });
});
