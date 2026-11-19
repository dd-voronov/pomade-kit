import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseQueuedNotice } from "../protocol/index.js";
import { pomadeUserData, postNotice } from "./index.js";
import { HostError, type HostClient } from "../sdk/index.js";

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
    const parsed = parseQueuedNotice(JSON.parse(await readFile(path!, "utf8")));
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

describe("postNotice with Pomade running", () => {
  it("posts over the caller's client with its source; nothing is queued", async () => {
    const posted: unknown[] = [];
    const host = { notices: { post: async (n: unknown) => void posted.push(n) } } as unknown as HostClient;
    const r = await postNotice({ title: " Hi " }, { source: "pomade-runner", userData, host });
    expect(r).toEqual({ delivered: "pomade", path: null });
    expect(posted).toEqual([{ title: "Hi", source: "pomade-runner" }]);
    await expect(readdir(join(userData, "notices", "queue"))).rejects.toThrow(/ENOENT/);
  });

  it("queues when the identity is set but Pomade is not running", async () => {
    const env = { POMADE_APP_ID: "pomade-runner", POMADE_SOCKET: join(userData, "none.sock"), POMADE_APP_KEY_FILE: join(userData, "k") };
    await writeFile(join(userData, "k"), "key\n");
    const r = await postNotice({ title: "Later" }, { source: "pomade-runner", userData, env });
    expect(r.delivered).toBe("queue");
    expect(r.path).toMatch(/notices\/queue\/.+\.json$/);
  });
});

describe("postNotice when the post over the connection fails", () => {
  const hostWith = (post: (n: unknown) => Promise<void>): HostClient => ({ notices: { post } }) as unknown as HostClient;
  const queued = async (): Promise<string[]> => readdir(join(userData, "notices", "queue")).catch(() => []);

  it("queues it when the connection closed before the answer (Pomade quitting mid-post)", async () => {
    let attempts = 0;
    const host = hostWith(async () => {
      attempts++;
      throw new Error("pomade-kit: client is closed");
    });
    const r = await postNotice({ title: "Run failed" }, { source: "pomade-runner", userData, host });
    expect(r.delivered).toBe("queue");
    expect(attempts).toBe(1);
    expect(await queued()).toHaveLength(1);
    const parsed = parseQueuedNotice(JSON.parse(await readFile(r.path!, "utf8")));
    expect(parsed).toMatchObject({ ok: true, notice: { title: "Run failed", source: "pomade-runner" } });
  });

  it("a delivered post is never also queued", async () => {
    const host = hostWith(async () => undefined);
    const r = await postNotice({ title: "Once" }, { source: "pomade-runner", userData, host });
    expect(r).toEqual({ delivered: "pomade", path: null });
    expect(await queued()).toEqual([]);
  });

  it("an error Pomade answered with is thrown, not queued", async () => {
    const host = hostWith(async () => {
      throw new HostError("capability-denied", "no");
    });
    await expect(postNotice({ title: "x" }, { source: "pomade-runner", userData, host })).rejects.toThrow(/no/);
    expect(await queued()).toEqual([]);
  });
});
