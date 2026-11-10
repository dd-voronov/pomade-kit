import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseQueuedNotice } from "../protocol/index.js";
import { pomadeUserData, postNotice } from "./index.js";

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "kit-notices-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("pomadeUserData", () => {
  it("userData, then POMADE_USER_DATA, then the dev or stable folder", () => {
    expect(pomadeUserData({ userData: "/x", env: { POMADE_USER_DATA: "/y" } })).toBe("/x");
    expect(pomadeUserData({ env: { POMADE_USER_DATA: "/y" }, stable: true })).toBe("/y");
    expect(pomadeUserData({ env: {} })).toBe(join(homedir(), "Library", "Application Support", "pomade-dev"));
    expect(pomadeUserData({ env: { POMADE_USER_DATA: "  " }, stable: true })).toBe(join(homedir(), "Library", "Application Support", "Pomade"));
  });
});

describe("postNotice", () => {
  it("queues one JSON file Pomade can read, named by time, with no leftovers", async () => {
    const at = new Date("2026-11-10T08:30:00.000Z");
    const { path } = await postNotice(
      { title: "  Commit & push failed ", body: "Knowledge: conflict", action: { kind: "openFile", path: "Projects/x/./log.md" } },
      { source: "pomade-git", userData, now: () => at },
    );
    const dir = join(userData, "notices", "queue");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(path).toBe(join(dir, files[0]!));
    expect(files[0]).toMatch(/^001794299400000-[0-9a-f]{12}\.json$/);
    const parsed = parseQueuedNotice(JSON.parse(await readFile(path, "utf8")));
    expect(parsed).toEqual({
      ok: true,
      notice: {
        title: "Commit & push failed",
        body: "Knowledge: conflict",
        action: { kind: "openFile", path: "Projects/x/log.md" },
        source: "pomade-git",
        postedAt: "2026-11-10T08:30:00.000Z",
      },
    });
  });

  it("two notices in the same millisecond are two files, in posting order by name", async () => {
    const at = new Date(1000);
    await postNotice({ title: "a" }, { source: "pomade-runner", userData, now: () => at });
    await postNotice({ title: "b" }, { source: "pomade-runner", userData, now: () => at });
    expect(await readdir(join(userData, "notices", "queue"))).toHaveLength(2);
  });

  it("refuses an invalid notice or source and writes nothing", async () => {
    await expect(postNotice({ title: "" }, { source: "pomade-runner", userData })).rejects.toThrow(/"title"/);
    await expect(postNotice({ title: "x", action: { kind: "openFile", path: "../out" } }, { source: "pomade-runner", userData })).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(postNotice({ title: "x" }, { source: "Runner!", userData })).rejects.toThrow(/"source"/);
    await expect(readdir(join(userData, "notices", "queue"))).rejects.toThrow();
  });
});
