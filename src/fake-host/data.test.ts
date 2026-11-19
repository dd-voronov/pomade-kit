import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBody } from "../frontmatter/index.js";
import { FILES_DELETE_MAX_PATHS, type FileChange, type HostToAppMessage } from "../protocol/index.js";
import { connect, HostError, type HostClient } from "../sdk/index.js";
import { createFakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.js";

const TICKET = readFileSync(new URL("../frontmatter/fixtures/T-210-board-drag-mixed.md", import.meta.url), "utf8");
const TICKET_CRLF = TICKET.replace(/\n/g, "\r\n");

const FILES = {
  "Projects/Pomade/docs/roadmap/T-210.md": TICKET,
  "Projects/Pomade/docs/roadmap/T-211-crlf.md": TICKET_CRLF,
  "Projects/Pomade/docs/roadmap/broken.md": "---\nid: [oops\n---\n\nBody.\n",
  "Projects/Pomade/notes/plain.txt": "plain\n",
};

let clock = 1000;
function fake(options: FakeHostOptions = {}): FakeHost {
  clock = 1000;
  return createFakeHost({ files: FILES, now: () => ++clock, ...options });
}

function raw(host: FakeHost) {
  const got: HostToAppMessage[] = [];
  const frame = host.attach((m) => got.push(m));
  let id = 0;
  frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
  const call = (method: string, params?: unknown) => {
    const callId = String(++id);
    frame.receive({ channel: "pomade", type: "call", id: callId, method, params });
    const reply = [...got].reverse().find((m) => m.type === "result" && m.id === callId);
    if (!reply || reply.type !== "result") throw new Error(`no result for ${method}`);
    return reply;
  };
  const errorOf = (method: string, params?: unknown) => {
    const r = call(method, params);
    return r.ok ? null : r.error.code;
  };
  return { got, call, errorOf };
}

async function client(host: FakeHost): Promise<HostClient> {
  const r = await connect({ transport: host.createTransport(), keySource: null });
  if (r.status !== "connected") throw new Error(`not connected: ${r.status}`);
  return r.host;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

async function read(host: HostClient, path: string): Promise<string> {
  return (await host.files.readFile({ path })).content;
}

describe("files.readFile", () => {
  it("returns the text, its byte size and mtime", async () => {
    const host = await client(fake());
    const r = await host.files.readFile({ path: "Projects/Pomade/docs/roadmap/T-211-crlf.md" });
    expect(r.content).toBe(TICKET_CRLF);
    expect(r.size).toBe(new TextEncoder().encode(TICKET_CRLF).length);
    expect(typeof r.mtimeMs).toBe("number");
  });

  it("errors: a folder is io-error, a missing file not-found, an escape outside-workspace, the root invalid-params", () => {
    const f = raw(fake());
    expect(f.errorOf("files.readFile", { path: "Projects/Pomade" })).toBe("io-error");
    expect(f.errorOf("files.readFile", { path: "nope.md" })).toBe("not-found");
    expect(f.errorOf("files.readFile", { path: "../x" })).toBe("outside-workspace");
    expect(f.errorOf("files.readFile", { path: "" })).toBe("invalid-params");
    expect(f.errorOf("files.readFile", {})).toBe("invalid-params");
  });
});

describe("files.setField / removeField — field-only", () => {
  it("changes exactly the field's line of a real-shaped ticket; every other byte stays", async () => {
    const fh = fake();
    const host = await client(fh);
    const path = "Projects/Pomade/docs/roadmap/T-210.md";
    expect(await host.files.setField({ path, key: "status", value: "done" })).toEqual({ changed: true });
    expect(await read(host, path)).toBe(TICKET.replace("status: 'in-progress'   # moved by the Board\n", "status: done   # moved by the Board\n"));
    expect(await host.files.setField({ path, key: "status", value: "done" })).toEqual({ changed: false });
    expect(await host.files.setField({ path, key: "tags", value: ["board", "done"] })).toEqual({ changed: true });
    expect(await read(host, path)).toContain("tags: [board, done]\n");
    expect(await host.files.removeField({ path, key: "blocked" })).toEqual({ changed: true });
    const after = await read(host, path);
    expect(after).not.toContain("blocked:");
    expect(getBody(after)).toBe(getBody(TICKET));
  });

  it("CRLF stays CRLF; numbers, booleans and null are written as YAML", async () => {
    const host = await client(fake());
    const path = "Projects/Pomade/docs/roadmap/T-211-crlf.md";
    await host.files.setField({ path, key: "estimate", value: 5 });
    await host.files.setField({ path, key: "blocked", value: true });
    await host.files.setField({ path, key: "owner", value: null });
    expect(await read(host, path)).toBe(
      TICKET_CRLF.replace("estimate: 3\r\n", "estimate: 5\r\n")
        .replace("blocked: false\r\n", "blocked: true\r\n")
        .replace("created: 2026-11-10\r\n---", "created: 2026-11-10\r\nowner:\r\n---"),
    );
  });

  it("a write emits one change event; an unchanged write emits none", async () => {
    const fh = fake();
    const host = await client(fh);
    const batches: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade/docs/roadmap" }, (c) => batches.push(c));
    await host.files.setField({ path: "Projects/Pomade/docs/roadmap/T-210.md", key: "status", value: "in-progress" });
    await host.files.setField({ path: "Projects/Pomade/docs/roadmap/T-210.md", key: "status", value: "in-progress" });
    await flush();
    expect(batches).toEqual([[{ kind: "change", path: "Projects/Pomade/docs/roadmap/T-210.md" }]]);
  });

  it("refusals carry the kit's reasons as codes; nothing is written", async () => {
    const f = raw(fake());
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/broken.md", key: "id", value: "x" })).toBe("unreadable-frontmatter");
    expect(f.errorOf("files.removeField", { path: "Projects/Pomade/docs/roadmap/broken.md", key: "id" })).toBe("unreadable-frontmatter");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/T-210.md", key: "", value: "x" })).toBe("invalid-params");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/T-210.md", key: "n", value: Infinity })).toBe("invalid-params");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/T-210.md", key: "n", value: { a: 1 } })).toBe("invalid-params");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/T-210.md", key: "n", value: [1] })).toBe("invalid-params");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/T-210.md", key: "n" })).toBe("invalid-params");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs/roadmap/nope.md", key: "n", value: 1 })).toBe("not-found");
    expect(f.errorOf("files.setField", { path: "Projects/Pomade/docs", key: "n", value: 1 })).toBe("io-error");
    const r = f.call("files.readFile", { path: "Projects/Pomade/docs/roadmap/T-210.md" });
    expect(r.ok && (r.value as { content: string }).content).toBe(TICKET);
  });
});

describe("files.readFile — frontmatter: true", () => {
  it("adds a Markdown file's frontmatter record, as readFolder reports it; another file gets none", async () => {
    const host = await client(fake());
    const r = await host.files.readFile({ path: "Projects/Pomade/docs/roadmap/T-210.md", frontmatter: true });
    const [entry] = (await host.files.readFolder({ path: "Projects/Pomade/docs/roadmap", frontmatter: true })).entries.filter((e) => e.name === "T-210.md");
    expect(r.content).toBe(TICKET);
    expect(r.frontmatter).toEqual(entry?.frontmatter);
    expect(r.frontmatter).toMatchObject({ id: "T-210", status: "in-progress", created: "2026-11-10" });
    expect(await host.files.readFile({ path: "Projects/Pomade/docs/roadmap/broken.md", frontmatter: true })).toMatchObject({ frontmatterError: expect.any(String) });
    const plain = await host.files.readFile({ path: "Projects/Pomade/notes/plain.txt", frontmatter: true });
    expect("frontmatter" in plain || "frontmatterError" in plain).toBe(false);
    expect("frontmatter" in (await host.files.readFile({ path: "Projects/Pomade/docs/roadmap/T-210.md" }))).toBe(false);
  });
});

describe("files.setKeyLines — one key as its own YAML lines", () => {
  it("sets a mapping field-only, replaces it in place, reports an identical write as no change", async () => {
    const host = await client(fake());
    const path = "Projects/Pomade/docs/roadmap/T-210.md";
    const repeat = "repeat:\n  every: { week: 1, on: [mon] }";
    expect(await host.files.setKeyLines({ path, key: "repeat", text: repeat })).toEqual({ changed: true });
    expect(await read(host, path)).toBe(TICKET.replace("created: 2026-11-10\n---", `created: 2026-11-10\n${repeat}\n---`));
    expect(await host.files.setKeyLines({ path, key: "repeat", text: "repeat:\n  once: 2026-12-01" })).toEqual({ changed: true });
    expect(await read(host, path)).toBe(TICKET.replace("created: 2026-11-10\n---", "created: 2026-11-10\nrepeat:\n  once: 2026-12-01\n---"));
    expect(await host.files.setKeyLines({ path, key: "repeat", text: "repeat:\n  once: 2026-12-01" })).toEqual({ changed: false });
    expect((await host.files.readFile({ path, frontmatter: true })).frontmatter).toMatchObject({ repeat: { once: "2026-12-01" } });
  });

  it("refusals: text that is not the key's own lines is invalid-params; an unreadable block, unreadable-frontmatter", () => {
    const f = raw(fake());
    const path = "Projects/Pomade/docs/roadmap/T-210.md";
    expect(f.errorOf("files.setKeyLines", { path, key: "repeat", text: "other:\n  a: 1" })).toBe("invalid-params");
    expect(f.errorOf("files.setKeyLines", { path, key: "repeat", text: "repeat:\n  a: [1" })).toBe("invalid-params");
    expect(f.errorOf("files.setKeyLines", { path, key: "repeat" })).toBe("invalid-params");
    expect(f.errorOf("files.setKeyLines", { path: "Projects/Pomade/docs/roadmap/broken.md", key: "r", text: "r: 1" })).toBe("unreadable-frontmatter");
    const r = f.call("files.readFile", { path });
    expect(r.ok && (r.value as { content: string }).content).toBe(TICKET);
  });
});

describe("ifMtime — write only while the file is the one read", () => {
  const path = "Projects/Pomade/docs/roadmap/T-210.md";
  const writes: [string, Record<string, unknown>][] = [
    ["files.write", { content: "x\n" }],
    ["files.setBody", { body: "x\n" }],
    ["files.setField", { key: "status", value: "done" }],
    ["files.removeField", { key: "status" }],
    ["files.setKeyLines", { key: "repeat", text: "repeat:\n  a: 1" }],
  ];

  it.each(writes)("%s: a stale mtime is changed-on-disk and the file is untouched; the fresh one writes", (method, params) => {
    const f = raw(fake());
    const read1 = f.call("files.readFile", { path });
    const { mtimeMs } = (read1.ok ? read1.value : {}) as { mtimeMs: number };
    expect(f.errorOf(method, { path, ...params, ifMtime: mtimeMs - 1 })).toBe("changed-on-disk");
    const after = f.call("files.readFile", { path });
    expect(after.ok && after.value).toEqual(read1.ok && read1.value);
    expect(f.errorOf(method, { path, ...params, ifMtime: mtimeMs })).toBeNull();
  });

  it("two writes within one clock tick: the second write's mtime moves on, so the first read is stale", async () => {
    const fh = createFakeHost({ files: FILES, now: () => 5000 });
    const host = await client(fh);
    const { mtimeMs } = await host.files.readFile({ path });
    await host.files.setField({ path, key: "status", value: "done", ifMtime: mtimeMs });
    await expect(host.files.setField({ path, key: "status", value: "x", ifMtime: mtimeMs })).rejects.toMatchObject({ code: "changed-on-disk" });
    expect((await host.files.readFile({ path })).mtimeMs).toBeGreaterThan(mtimeMs);
  });

  it("a stale no-op write is refused too; a non-number ifMtime is invalid-params", () => {
    const f = raw(fake());
    expect(f.errorOf("files.setField", { path, key: "kind", value: "task", ifMtime: 1 })).toBe("changed-on-disk");
    expect(f.errorOf("files.setField", { path, key: "kind", value: "task", ifMtime: "1" })).toBe("invalid-params");
    expect(f.errorOf("files.write", { path, content: "x", ifMtime: Number.NaN })).toBe("invalid-params");
  });
});

describe("a silent change — new bytes, no watch event", () => {
  const path = "Projects/Pomade/docs/roadmap/T-210.md";

  it("moves the bytes and the mtime without a files.changed; the app's ifMtime write is then changed-on-disk, as in Pomade", async () => {
    const fh = fake();
    const host = await client(fh);
    const heard: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade/docs/roadmap" }, (changes) => heard.push(changes));
    const { mtimeMs } = await host.files.readFile({ path });
    fh.writeFile(path, "edited elsewhere\n", { silent: true });
    await flush();
    expect(heard).toEqual([]);
    const now = await host.files.readFile({ path });
    expect(now.content).toBe("edited elsewhere\n");
    expect(now.mtimeMs).toBeGreaterThan(mtimeMs);
    await expect(host.files.setField({ path, key: "status", value: "done", ifMtime: mtimeMs })).rejects.toEqual(
      new HostError("changed-on-disk", `${JSON.stringify(path)} changed on disk since it was read; nothing was written`),
    );
    expect(fh.readFile(path)).toBe("edited elsewhere\n");
  });

  it("within one clock tick the mtime still moves on; a silent create is heard by no watch either", async () => {
    const fh = createFakeHost({ files: FILES, now: () => 5000 });
    const host = await client(fh);
    const heard: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade/docs/roadmap" }, (changes) => heard.push(changes));
    const { mtimeMs } = await host.files.readFile({ path });
    fh.writeFile(path, "x\n", { silent: true });
    fh.writeFile("Projects/Pomade/docs/roadmap/new.md", "new\n", { silent: true });
    await flush();
    expect(heard).toEqual([]);
    expect((await host.files.readFile({ path })).mtimeMs).toBeGreaterThan(mtimeMs);
    expect(await read(host, "Projects/Pomade/docs/roadmap/new.md")).toBe("new\n");
  });
});

describe("scripted write failures — fake.failNextWrite", () => {
  const path = "Projects/Pomade/docs/roadmap/T-210.md";
  const writes: [string, Record<string, unknown>][] = [
    ["files.write", { path, content: "x\n" }],
    ["files.setBody", { path, body: "x\n" }],
    ["files.setField", { path, key: "status", value: "done" }],
    ["files.removeField", { path, key: "status" }],
    ["files.setKeyLines", { path, key: "repeat", text: "repeat:\n  a: 1" }],
    ["files.move", { from: path, to: "Projects/Pomade/docs/roadmap/moved.md" }],
  ];

  it.each(writes)("%s: the next write fails with Pomade's error, the file is untouched, the write after it goes", (method, params) => {
    const fh = fake();
    const f = raw(fh);
    fh.failNextWrite(path, "permission");
    const r = f.call(method, params);
    expect(!r.ok && r.error).toEqual({ code: "io-error", message: `EACCES: permission denied, open '${path}'` });
    expect(fh.readFile(path)).toBe(TICKET);
    expect(f.errorOf(method, params)).toBeNull();
  });

  it("io-error and already-exists carry Pomade's codes and messages; files.create fails on its target", () => {
    const fh = fake();
    const f = raw(fh);
    const target = "Projects/Pomade/docs/roadmap/new.md";
    fh.failNextWrite(target, "already-exists");
    fh.failNextWrite(path, "io-error");
    const created = f.call("files.create", { path: target, content: "x" });
    expect(!created.ok && created.error).toEqual({ code: "already-exists", message: `${JSON.stringify(target)} already exists` });
    expect(() => fh.readFile(target)).toThrow();
    const written = f.call("files.write", { path, content: "x" });
    expect(!written.ok && written.error).toEqual({ code: "io-error", message: `EIO: i/o error, write '${path}'` });
    expect(f.errorOf("files.create", { path: target, content: "x" })).toBeNull();
  });

  it("failures queue up per path, each used once; another path's write is not affected; paths are normalized", () => {
    const fh = fake();
    const f = raw(fh);
    fh.failNextWrite(`./${path}`, "io-error");
    fh.failNextWrite(path, "permission");
    expect(f.errorOf("files.write", { path: "Projects/Pomade/notes/plain.txt", content: "y" })).toBeNull();
    expect(f.errorOf("files.write", { path, content: "x" })).toBe("io-error");
    const second = f.call("files.write", { path, content: "x" });
    expect(!second.ok && second.error.message).toMatch(/^EACCES/);
    expect(f.errorOf("files.write", { path, content: "x" })).toBeNull();
  });

  it("checks Pomade makes first still win, and keep the failure scripted: a stale ifMtime, a missing file", () => {
    const fh = fake();
    const f = raw(fh);
    fh.failNextWrite(path, "permission");
    expect(f.errorOf("files.setField", { path, key: "status", value: "done", ifMtime: 1 })).toBe("changed-on-disk");
    expect(f.errorOf("files.write", { path: "Projects/Pomade/none.md", content: "x" })).toBe("not-found");
    expect(f.errorOf("files.write", { path, content: "x" })).toBe("io-error");
  });

  it("files.delete fails that entry only; the move's target path fails it too", () => {
    const fh = fake();
    const f = raw(fh);
    const plain = "Projects/Pomade/notes/plain.txt";
    fh.failNextWrite(path, "permission");
    const r = f.call("files.delete", { paths: [path, plain] });
    expect(r.ok && r.value).toEqual({
      results: [
        { path, ok: false, error: { code: "io-error", message: `EACCES: permission denied, open '${path}'` } },
        { path: plain, ok: true },
      ],
    });
    expect(fh.readFile(path)).toBe(TICKET);
    const to = "Projects/Pomade/docs/roadmap/moved.md";
    fh.failNextWrite(to, "already-exists");
    expect(f.errorOf("files.move", { from: path, to })).toBe("already-exists");
    expect(fh.readFile(path)).toBe(TICKET);
  });
});

describe("files.setBody", () => {
  it("replaces the body and keeps the frontmatter bytes (CRLF block included)", async () => {
    const host = await client(fake());
    const path = "Projects/Pomade/docs/roadmap/T-211-crlf.md";
    expect(await host.files.setBody({ path, body: "Rewritten [[E-030]].\r\n" })).toEqual({ changed: true });
    const after = await read(host, path);
    expect(after).toBe(TICKET_CRLF.slice(0, TICKET_CRLF.length - getBody(TICKET_CRLF).length) + "Rewritten [[E-030]].\r\n");
    expect(await host.files.setBody({ path, body: "Rewritten [[E-030]].\r\n" })).toEqual({ changed: false });
  });

  it("an unclosed block is unreadable-frontmatter", () => {
    const f = raw(fake({ files: { "a.md": "---\nid: 1\n\nno close\n" } }));
    expect(f.errorOf("files.setBody", { path: "a.md", body: "x" })).toBe("unreadable-frontmatter");
    expect(f.errorOf("files.setBody", { path: "a.md" })).toBe("invalid-params");
  });
});

describe("files.create / write", () => {
  it("create makes the file and its parent folders; already-exists when the path exists", async () => {
    const fh = fake();
    const host = await client(fh);
    const batches: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade", recursive: true }, (c) => batches.push(c));
    await host.files.create({ path: "Projects/Pomade/docs/roadmap/done/T-300.md", content: "---\nid: T-300\n---\n" });
    await host.files.create({ path: "Projects/Pomade/empty.md" });
    expect(await read(host, "Projects/Pomade/docs/roadmap/done/T-300.md")).toBe("---\nid: T-300\n---\n");
    expect(await read(host, "Projects/Pomade/empty.md")).toBe("");
    await flush();
    expect(batches.flat()).toEqual([
      { kind: "create", path: "Projects/Pomade/docs/roadmap/done" },
      { kind: "create", path: "Projects/Pomade/docs/roadmap/done/T-300.md" },
      { kind: "create", path: "Projects/Pomade/empty.md" },
    ]);
    await expect(host.files.create({ path: "Projects/Pomade/empty.md" })).rejects.toMatchObject({ code: "already-exists" });
    await expect(host.files.create({ path: "Projects/Pomade/docs" })).rejects.toMatchObject({ code: "already-exists" });
    await expect(host.files.create({ path: "Projects/Pomade/notes/plain.txt/x.md" })).rejects.toMatchObject({ code: "io-error" });
    await expect(host.files.create({ path: "../x.md" })).rejects.toBeInstanceOf(HostError);
  });

  it("write replaces an existing file's text; a missing file is not-found, a folder io-error", async () => {
    const host = await client(fake());
    await host.files.write({ path: "Projects/Pomade/notes/plain.txt", content: "new\n" });
    expect(await read(host, "Projects/Pomade/notes/plain.txt")).toBe("new\n");
    await expect(host.files.write({ path: "Projects/Pomade/nope.txt", content: "" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host.files.write({ path: "Projects/Pomade/notes", content: "" })).rejects.toMatchObject({ code: "io-error" });
    const f = raw(fake());
    expect(f.errorOf("files.write", { path: "Projects/Pomade/notes/plain.txt" })).toBe("invalid-params");
    expect(f.errorOf("files.create", { path: "x.md", content: 3 })).toBe("invalid-params");
  });
});

describe("files.move", () => {
  it("moves a file into a new folder (rename event); renames a folder with its contents", async () => {
    const fh = fake();
    const host = await client(fh);
    const batches: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade/docs/roadmap", recursive: true }, (c) => batches.push(c));
    await host.files.move({ from: "Projects/Pomade/docs/roadmap/T-210.md", to: "Projects/Pomade/docs/roadmap/done/T-210.md" });
    expect(await read(host, "Projects/Pomade/docs/roadmap/done/T-210.md")).toBe(TICKET);
    await host.files.move({ from: "Projects/Pomade/docs/roadmap/done", to: "Projects/Pomade/docs/roadmap/archive" });
    expect(await read(host, "Projects/Pomade/docs/roadmap/archive/T-210.md")).toBe(TICKET);
    await flush();
    expect(batches.flat()).toEqual([
      { kind: "create", path: "Projects/Pomade/docs/roadmap/done" },
      { kind: "rename", path: "Projects/Pomade/docs/roadmap/done/T-210.md", oldPath: "Projects/Pomade/docs/roadmap/T-210.md" },
      { kind: "rename", path: "Projects/Pomade/docs/roadmap/archive", oldPath: "Projects/Pomade/docs/roadmap/done" },
    ]);
  });

  it("errors: missing source, existing target, into itself, the root, escapes", () => {
    const f = raw(fake());
    expect(f.errorOf("files.move", { from: "nope.md", to: "x.md" })).toBe("not-found");
    expect(f.errorOf("files.move", { from: "Projects/Pomade/docs/roadmap/T-210.md", to: "Projects/Pomade/docs/roadmap/broken.md" })).toBe("already-exists");
    expect(f.errorOf("files.move", { from: "Projects/Pomade/docs", to: "Projects/Pomade/docs/sub" })).toBe("invalid-params");
    expect(f.errorOf("files.move", { from: "", to: "x" })).toBe("invalid-params");
    expect(f.errorOf("files.move", { from: "Projects/Pomade/notes/plain.txt", to: "../plain.txt" })).toBe("outside-workspace");
    expect(f.errorOf("files.move", { from: "Projects/Pomade/notes/plain.txt" })).toBe("invalid-params");
    expect(f.errorOf("files.move", { from: "Projects/Pomade/notes/plain.txt", to: "Projects/Pomade/notes/plain.txt" })).toBeNull();
  });
});

describe("files.delete", () => {
  it("deletes files; each path is reported on its own, in order; the watch hears every delete in one batch", async () => {
    const fh = fake();
    const host = await client(fh);
    const batches: FileChange[][] = [];
    await host.files.watch({ path: "Projects/Pomade", recursive: true }, (c) => batches.push(c));
    const results = await host.files.delete([
      "Projects/Pomade/docs/roadmap/T-210.md",
      "Projects/Pomade/docs/roadmap/nope.md",
      "./Projects/Pomade/notes/plain.txt",
    ]);
    expect(results).toEqual([
      { path: "Projects/Pomade/docs/roadmap/T-210.md", ok: true },
      { path: "Projects/Pomade/docs/roadmap/nope.md", ok: false, error: { code: "not-found", message: '"Projects/Pomade/docs/roadmap/nope.md" does not exist' } },
      { path: "./Projects/Pomade/notes/plain.txt", ok: true },
    ]);
    await expect(read(host, "Projects/Pomade/docs/roadmap/T-210.md")).rejects.toMatchObject({ code: "not-found" });
    await flush();
    expect(batches).toEqual([
      [
        { kind: "delete", path: "Projects/Pomade/docs/roadmap/T-210.md" },
        { kind: "delete", path: "Projects/Pomade/notes/plain.txt" },
      ],
    ]);
  });

  it("a folder, the root and an escape fail their own entry; the other paths still go", async () => {
    const fh = fake();
    const host = await client(fh);
    const results = await host.files.delete(["Projects/Pomade/docs", "", "../x.md", "Projects/Pomade/docs/roadmap/broken.md"]);
    expect(results.map((r) => (r.ok ? "ok" : r.error?.code))).toEqual(["invalid-params", "invalid-params", "outside-workspace", "ok"]);
    expect(fh.readFile("Projects/Pomade/docs/roadmap/T-210.md")).toBe(TICKET);
  });

  it("a symlinked file goes as the link itself; its target stays", async () => {
    const fh = fake();
    fh.symlink("Projects/Pomade/link.md", "Projects/Pomade/docs/roadmap/T-210.md");
    const host = await client(fh);
    expect(await host.files.delete(["Projects/Pomade/link.md"])).toEqual([{ path: "Projects/Pomade/link.md", ok: true }]);
    expect(fh.isSymlink("Projects/Pomade/link.md")).toBe(false);
    expect(fh.readFile("Projects/Pomade/docs/roadmap/T-210.md")).toBe(TICKET);
  });

  it("an empty list answers no results; a malformed list or too many paths refuses the call", () => {
    const f = raw(fake());
    expect(f.call("files.delete", { paths: [] })).toMatchObject({ ok: true, value: { results: [] } });
    expect(f.errorOf("files.delete", {})).toBe("invalid-params");
    expect(f.errorOf("files.delete", { paths: "a.md" })).toBe("invalid-params");
    expect(f.errorOf("files.delete", { paths: ["a.md", 1] })).toBe("invalid-params");
    expect(f.errorOf("files.delete", { paths: Array.from({ length: FILES_DELETE_MAX_PATHS + 1 }, (_, i) => `f${i}.md`) })).toBe("invalid-params");
  });
});

describe("capabilities", () => {
  it("every write needs files.write; readFile needs files.read", () => {
    const f = raw(fake({ manifest: { id: "ro", name: "RO", version: "1.0.0", hostApi: 0, capabilities: ["files.read"] } }));
    expect(f.errorOf("files.readFile", { path: "Projects/Pomade/notes/plain.txt" })).toBeNull();
    for (const m of ["files.create", "files.write", "files.setBody", "files.setField", "files.removeField", "files.setKeyLines", "files.move", "files.delete"]) {
      expect(f.errorOf(m, {})).toBe("capability-denied");
    }
    const wo = raw(fake({ manifest: { id: "wo", name: "WO", version: "1.0.0", hostApi: 0, capabilities: ["files.write"] } }));
    expect(wo.errorOf("files.readFile", { path: "Projects/Pomade/notes/plain.txt" })).toBe("capability-denied");
  });
});

describe("tabs.openFile / tabs.openTerminal", () => {
  const PROJECTS = [
    { id: "pomade", name: "Pomade", root: "Projects/Pomade" },
    { id: "kit", name: "pomade-kit", root: "Projects/pomade-kit" },
  ];

  it("records the tab in the target project (default: the active one) and switches to it", async () => {
    const fh = fake({ projects: PROJECTS, activeProject: "pomade", files: { ...FILES, "Projects/pomade-kit/README.md": "# kit\n" } });
    const host = await client(fh);
    const seen: string[] = [];
    host.project.onChange((p) => seen.push(p.id));
    await host.tabs.openFile({ path: "Projects/Pomade/docs/roadmap/T-210.md" });
    await host.tabs.openFile({ path: "Projects/pomade-kit/README.md", projectId: "kit" });
    await host.tabs.openTerminal({ cwd: "Projects/Pomade", command: "npm run dev", title: " Dev server " });
    await host.tabs.openTerminal({ cwd: "", projectId: "__workspace__" });
    await flush();
    expect(fh.openedTabs).toEqual([
      { kind: "file", projectId: "pomade", path: "Projects/Pomade/docs/roadmap/T-210.md" },
      { kind: "file", projectId: "kit", path: "Projects/pomade-kit/README.md" },
      { kind: "terminal", projectId: "kit", cwd: "Projects/Pomade", command: "npm run dev", title: "Dev server" },
      { kind: "terminal", projectId: "__workspace__", cwd: "" },
    ]);
    expect(seen).toEqual(["kit", "__workspace__"]);
  });

  it("errors: a missing or folder path, a missing or file cwd, an unknown project, a multi-line command", () => {
    const f = raw(fake({ projects: PROJECTS }));
    expect(f.errorOf("tabs.openFile", { path: "Projects/Pomade/nope.md" })).toBe("not-found");
    expect(f.errorOf("tabs.openFile", { path: "Projects/Pomade/docs" })).toBe("io-error");
    expect(f.errorOf("tabs.openFile", { path: "../x" })).toBe("outside-workspace");
    expect(f.errorOf("tabs.openFile", { path: "Projects/Pomade/notes/plain.txt", projectId: "ghost" })).toBe("not-found");
    expect(f.errorOf("tabs.openFile", { path: "Projects/Pomade/notes/plain.txt", projectId: 3 })).toBe("invalid-params");
    expect(f.errorOf("tabs.openTerminal", { cwd: "Projects/nope" })).toBe("not-found");
    expect(f.errorOf("tabs.openTerminal", { cwd: "Projects/Pomade/notes/plain.txt" })).toBe("io-error");
    expect(f.errorOf("tabs.openTerminal", { cwd: "Projects/Pomade", command: "a\nb" })).toBe("invalid-params");
    expect(f.errorOf("tabs.openTerminal", { cwd: "Projects/Pomade", command: "  " })).toBe("invalid-params");
    expect(f.errorOf("tabs.openTerminal", { cwd: "Projects/Pomade", title: "" })).toBe("invalid-params");
    expect(f.errorOf("tabs.openTerminal", {})).toBe("invalid-params");
  });

  it("needs tabs.open", () => {
    const f = raw(fake({ manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["files.read"] } }));
    expect(f.errorOf("tabs.openFile", { path: "Projects/Pomade/notes/plain.txt" })).toBe("capability-denied");
    expect(f.errorOf("tabs.openTerminal", { cwd: "" })).toBe("capability-denied");
    expect(f.errorOf("tabs.openAttached", { session: { app: "hello", session: "s" } })).toBe("capability-denied");
  });
});

describe("tabs.openAttached", () => {
  const PROJECTS = [{ id: "pomade", name: "Pomade", root: "Projects/Pomade" }];

  it("records the attached tab — any app's session, by reference — in the target project and switches to it", async () => {
    const fh = fake({ projects: PROJECTS });
    const host = await client(fh);
    await host.tabs.openAttached({ session: { app: "pomade-runner", session: "svc:coda-web" }, title: " Coda web ", projectId: "pomade" });
    await host.tabs.openAttached({ session: { app: "hello", session: "ticker" } });
    await flush();
    expect(fh.openedTabs).toEqual([
      { kind: "attached", projectId: "pomade", session: { app: "pomade-runner", session: "svc:coda-web" }, title: "Coda web" },
      { kind: "attached", projectId: "pomade", session: { app: "hello", session: "ticker" } },
    ]);
  });

  it("errors: a malformed reference, an empty title, an unknown project", () => {
    const f = raw(fake({ projects: PROJECTS }));
    expect(f.errorOf("tabs.openAttached", {})).toBe("invalid-params");
    expect(f.errorOf("tabs.openAttached", { session: { app: "hello" } })).toBe("invalid-params");
    expect(f.errorOf("tabs.openAttached", { session: { app: "Hello", session: "s" } })).toBe("invalid-params");
    expect(f.errorOf("tabs.openAttached", { session: { app: "hello", session: "s" }, title: " " })).toBe("invalid-params");
    expect(f.errorOf("tabs.openAttached", { session: { app: "hello", session: "s" }, projectId: "ghost" })).toBe("not-found");
  });
});

describe("project.list and project ids", () => {
  const GROUPS = [
    { id: "g-build", name: "Building tools" },
    { id: "g-tools", name: "Tools", parent: "g-build" },
    { id: "g-life", name: "Life" },
  ];
  const TREE_PROJECTS = [
    { id: "p-loose", name: "Loose", root: "Projects/loose" },
    { id: "p-pomade", name: "Pomade", root: "Projects/Pomade", group: "g-tools" },
    { id: "p-kit", name: "pomade-kit", root: "Projects/pomade-kit", group: "g-build" },
    { id: "p-home", name: "Home", root: "Projects/home", group: "g-life" },
  ];

  it("lists groups and projects in sidebar order, each project with its nested group path", async () => {
    const host = await client(fake({ groups: GROUPS, projects: TREE_PROJECTS }));
    expect(await host.project.list()).toEqual({
      workspace: { id: "__workspace__", kind: "workspace", name: "Workspace", root: "" },
      groups: [
        { id: "g-build", name: "Building tools", parentId: null, path: ["Building tools"] },
        { id: "g-tools", name: "Tools", parentId: "g-build", path: ["Building tools", "Tools"] },
        { id: "g-life", name: "Life", parentId: null, path: ["Life"] },
      ],
      projects: [
        { id: "p-kit", kind: "project", name: "pomade-kit", root: "Projects/pomade-kit", groupId: "g-build", groupPath: ["Building tools"] },
        { id: "p-pomade", kind: "project", name: "Pomade", root: "Projects/Pomade", groupId: "g-tools", groupPath: ["Building tools", "Tools"] },
        { id: "p-home", kind: "project", name: "Home", root: "Projects/home", groupId: "g-life", groupPath: ["Life"] },
        { id: "p-loose", kind: "project", name: "Loose", root: "Projects/loose", groupId: null, groupPath: [] },
      ],
    });
  });

  it("a rename or move keeps the id: a stored reference still resolves; the active project's change is an event", async () => {
    const fh = fake({ groups: GROUPS, projects: TREE_PROJECTS, activeProject: "p-pomade" });
    const host = await client(fh);
    const stored = "p-pomade";
    const seen: ProjectRefLike[] = [];
    host.project.onChange((p) => seen.push(p));
    fh.updateProject("p-pomade", { name: "Pomade 2", root: "Projects/Pomade2", group: null });
    fh.updateProject("p-kit", { name: "Kit" });
    await flush();
    const after = (await host.project.list()).projects.find((p) => p.id === stored);
    expect(after).toMatchObject({ name: "Pomade 2", root: "Projects/Pomade2", groupId: null, groupPath: [] });
    expect(seen).toEqual([{ id: "p-pomade", kind: "project", name: "Pomade 2", root: "Projects/Pomade2" }]);
    expect(await host.project.getActive()).toEqual(seen[0]);
  });

  it("the Workspace scope is a project.changed like any switch", async () => {
    const fh = fake({ groups: GROUPS, projects: TREE_PROJECTS, activeProject: "p-home" });
    const host = await client(fh);
    const seen: string[] = [];
    host.project.onChange((p) => seen.push(`${p.kind}:${p.id}`));
    fh.setActiveProject(null);
    await flush();
    expect(seen).toEqual(["workspace:__workspace__"]);
  });

  it("needs project.read; bad groups are construction errors", () => {
    const f = raw(fake({ manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["files.read"] } }));
    expect(f.errorOf("project.list")).toBe("capability-denied");
    expect(() => fake({ groups: [{ id: "a", name: "A", parent: "nope" }] })).toThrow(/unknown parent/);
    expect(() => fake({ projects: [{ id: "p", name: "P", root: "P", group: "nope" }] })).toThrow(/unknown group/);
    expect(() => fake({ projects: TREE_PROJECTS, groups: GROUPS }).updateProject("ghost", { name: "x" })).toThrow(/no project/);
  });
});

type ProjectRefLike = { id: string; kind: string; name: string; root: string };

describe("project settings and visible agents", () => {
  const PROJECTS = [
    { id: "pomade", name: "Pomade", root: "Projects/Pomade", settings: { backlog: "docs/roadmap" }, visibleAgents: ["claude", "claude-coder"] },
    { id: "kit", name: "pomade-kit", root: "Projects/pomade-kit" },
  ];

  it("settings: the app's own, per project; merge; null removes; the result is returned", async () => {
    const host = await client(fake({ projects: PROJECTS }));
    expect(await host.project.getSettings({ projectId: "pomade" })).toEqual({ settings: { backlog: "docs/roadmap" } });
    expect(await host.project.getSettings({ projectId: "kit" })).toEqual({ settings: {} });
    expect(await host.project.setSettings({ projectId: "pomade", settings: { columns: ["Signals", "Problems"], backlog: null } })).toEqual({
      settings: { columns: ["Signals", "Problems"] },
    });
    expect(await host.project.getSettings({ projectId: "pomade" })).toEqual({ settings: { columns: ["Signals", "Problems"] } });
    expect(await host.project.getSettings({ projectId: "kit" })).toEqual({ settings: {} });
  });

  it("agents: read and replace the visible list; the Workspace scope sees every agent", async () => {
    const host = await client(fake({ projects: PROJECTS }));
    expect(await host.project.getAgents({ projectId: "pomade" })).toEqual({ visibleAgents: ["claude", "claude-coder"] });
    expect(await host.project.getAgents({ projectId: "kit" })).toEqual({ visibleAgents: ["*"] });
    expect(await host.project.getAgents({ projectId: "__workspace__" })).toEqual({ visibleAgents: ["*"] });
    await host.project.setAgents({ projectId: "kit", visibleAgents: ["codex", " codex"] });
    expect(await host.project.getAgents({ projectId: "kit" })).toEqual({ visibleAgents: ["codex"] });
  });

  it("errors", () => {
    const f = raw(fake({ projects: PROJECTS }));
    expect(f.errorOf("project.getSettings", { projectId: "ghost" })).toBe("not-found");
    expect(f.errorOf("project.getSettings", {})).toBe("invalid-params");
    expect(f.errorOf("project.getSettings", { projectId: "__workspace__" })).toBe("invalid-params");
    expect(f.errorOf("project.setSettings", { projectId: "pomade", settings: [] })).toBe("invalid-params");
    expect(f.errorOf("project.setSettings", { projectId: "pomade", settings: { n: Infinity } })).toBe("invalid-params");
    expect(f.errorOf("project.setSettings", { projectId: "pomade", settings: { big: "x".repeat(70000) } })).toBe("invalid-params");
    expect(f.errorOf("project.setAgents", { projectId: "pomade", visibleAgents: ["*", "claude"] })).toBe("invalid-params");
    expect(f.errorOf("project.setAgents", { projectId: "__workspace__", visibleAgents: [] })).toBe("invalid-params");
    expect(f.errorOf("project.getAgents", { projectId: "ghost" })).toBe("not-found");
  });

  it("reads need project.read, writes project.write", () => {
    const ro = raw(fake({ projects: PROJECTS, manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["project.read"] } }));
    expect(ro.errorOf("project.getSettings", { projectId: "pomade" })).toBeNull();
    expect(ro.errorOf("project.getAgents", { projectId: "pomade" })).toBeNull();
    expect(ro.errorOf("project.setSettings", { projectId: "pomade", settings: {} })).toBe("capability-denied");
    expect(ro.errorOf("project.setAgents", { projectId: "pomade", visibleAgents: [] })).toBe("capability-denied");
  });
});

describe("project.updated — a project's group, visible agents or the app's settings changed", () => {
  const GROUPS = [
    { id: "g-build", name: "Building tools" },
    { id: "g-life", name: "Life" },
  ];
  const PROJECTS = [
    { id: "pomade", name: "Pomade", root: "Projects/Pomade", group: "g-build" },
    { id: "kit", name: "pomade-kit", root: "Projects/pomade-kit" },
  ];
  const manifest = (id: string, subscribe: string[]) => ({
    id,
    name: "X",
    version: "1.0.0",
    hostApi: 0,
    capabilities: ["project.read", "project.write"],
    events: { publish: [], subscribe },
  });
  const updated = (r: ReturnType<typeof raw>) =>
    r.got.flatMap((m) => (m.type === "event" && m.name === "project.updated" ? [m.payload] : []));

  it("a regroup, an agent-list change and a settings write each reach the subscribed frames, with the project as it is now", async () => {
    const fh = fake({ groups: GROUPS, projects: PROJECTS, manifest: manifest("hello", ["project.updated"]) });
    const a = raw(fh);
    const b = raw(fh);
    const other = raw(fh);
    expect(a.call("events.subscribe", { name: "project.updated" }).ok).toBe(true);
    expect(b.call("events.subscribe", { name: "project.updated" }).ok).toBe(true);

    fh.updateProject("pomade", { group: "g-life" });
    const moved = { id: "pomade", kind: "project", name: "Pomade", root: "Projects/Pomade", groupId: "g-life", groupPath: ["Life"] };
    fh.updateProject("pomade", { visibleAgents: ["claude", " claude"] });
    a.call("project.setAgents", { projectId: "kit", visibleAgents: ["codex"] });
    a.call("project.setSettings", { projectId: "kit", settings: { folder: "done" } });
    const kit = { id: "kit", kind: "project", name: "pomade-kit", root: "Projects/pomade-kit", groupId: null, groupPath: [] };
    const expected = [
      { project: moved, changes: ["group"] },
      { project: moved, changes: ["agents"] },
      { project: kit, changes: ["agents"] },
      { project: kit, changes: ["settings"] },
    ];
    expect(updated(a)).toEqual(expected);
    expect(updated(b)).toEqual(expected);
    expect(updated(other)).toEqual([]);

    // Through the SDK, typed.
    const host = await client(fh);
    const seen: string[] = [];
    await host.events.subscribe("project.updated", ({ project, changes }) => seen.push(`${project.id}:${project.groupPath.join("/")}:${changes.join(",")}`));
    fh.updateProject("kit", { group: "g-build", visibleAgents: ["*"] });
    await flush();
    expect(seen).toEqual(["kit:Building tools:group,agents"]);
  });

  it("nothing is sent when nothing changed; a rename is project.renamed, not project.updated", () => {
    const fh = fake({ groups: GROUPS, projects: PROJECTS, manifest: manifest("hello", ["project.updated"]) });
    const a = raw(fh);
    a.call("events.subscribe", { name: "project.updated" });
    fh.updateProject("pomade", { group: "g-build", visibleAgents: ["*"] });
    fh.updateProject("pomade", { name: "Pomade 2" });
    a.call("project.setAgents", { projectId: "kit", visibleAgents: ["*"] });
    a.call("project.setSettings", { projectId: "kit", settings: { gone: null } });
    a.call("project.setSettings", { projectId: "kit", settings: { folder: "x" } });
    a.call("project.setSettings", { projectId: "kit", settings: { folder: "x" } });
    expect(updated(a)).toEqual([expect.objectContaining({ changes: ["settings"] })]);
  });

  it("a settings change reaches only the app whose settings changed", () => {
    const fh = fake({ groups: GROUPS, projects: PROJECTS, manifest: manifest("hello", ["project.updated"]) });
    const a = raw(fh);
    a.call("events.subscribe", { name: "project.updated" });
    const otherApp: unknown[] = [];
    // Another app on the same bus (the fake host's own, reached for this check) subscribed to
    // project.updated hears the group change but not this app's settings.
    const bus = (fh as unknown as { bus: { open(c: unknown): { subscribe(n: string): void; close(): void } } }).bus;
    const member = bus.open({ appId: "pomade-planner", deliver: (_n: string, p: unknown) => otherApp.push(p) });
    member.subscribe("project.updated");
    a.call("project.setSettings", { projectId: "kit", settings: { folder: "done" } });
    fh.updateProject("kit", { group: "g-life" });
    member.close();
    expect(updated(a).map((p) => (p as { changes: string[] }).changes)).toEqual([["settings"], ["group"]]);
    expect(otherApp.map((p) => (p as { changes: string[] }).changes)).toEqual([["group"]]);
  });

  it("subscribing needs the manifest's events.subscribe", () => {
    const a = raw(fake({ projects: PROJECTS, groups: GROUPS, manifest: manifest("hello", []) }));
    expect(a.errorOf("events.subscribe", { name: "project.updated" })).toBe("capability-denied");
  });
});

describe("files.symlink / removeSymlink — scoped by the manifest", () => {
  const MANIFEST = {
    id: "pomade-agents",
    name: "Agents",
    version: "0.1.0",
    hostApi: 0,
    capabilities: ["files.read", "files.symlink"],
    symlinks: ["Agents/*/skills"],
  };
  const SKILL_FILES = {
    ...FILES,
    "Apps/pomade-agents/skill/SKILL.md": "---\nname: sessions\n---\n",
    "Agents/claude-coder/CLAUDE.md": "# coder\n",
    "Agents/claude-coder/skills/own/SKILL.md": "own\n",
  };

  it("creates a link the listing shows as what it points to, and removes only the link", async () => {
    const fh = fake({ manifest: MANIFEST, files: SKILL_FILES });
    const host = await client(fh);
    const batches: FileChange[][] = [];
    await host.files.watch({ path: "Agents", recursive: true }, (c) => batches.push(c));
    await host.files.symlink({ path: "Agents/claude-coder/skills/sessions", target: "Apps/pomade-agents/skill" });
    await host.files.symlink({ path: "Agents/claude-pm/skills/sessions", target: "Apps/pomade-agents/skill" });
    expect(fh.isSymlink("Agents/claude-coder/skills/sessions")).toBe(true);
    const { entries } = await host.files.readFolder({ path: "Agents/claude-coder/skills", recursive: true });
    expect(entries.map((e) => [e.path, e.kind])).toEqual([
      ["Agents/claude-coder/skills/own", "dir"],
      ["Agents/claude-coder/skills/own/SKILL.md", "file"],
      ["Agents/claude-coder/skills/sessions", "dir"],
    ]);
    await host.files.removeSymlink({ path: "Agents/claude-coder/skills/sessions" });
    expect(fh.isSymlink("Agents/claude-coder/skills/sessions")).toBe(false);
    expect(fh.readFile("Apps/pomade-agents/skill/SKILL.md")).toBe("---\nname: sessions\n---\n");
    await flush();
    expect(batches.flat()).toEqual([
      { kind: "create", path: "Agents/claude-coder/skills/sessions" },
      { kind: "create", path: "Agents/claude-pm" },
      { kind: "create", path: "Agents/claude-pm/skills" },
      { kind: "create", path: "Agents/claude-pm/skills/sessions" },
      { kind: "delete", path: "Agents/claude-coder/skills/sessions" },
    ]);
  });

  it("refuses: outside the declared folders, through a symlinked folder, taken, missing target, removing a real file", () => {
    const fh = fake({ manifest: MANIFEST, files: SKILL_FILES });
    fh.symlink("Agents/linked", "Agents/claude-coder");
    const f = raw(fh);
    const target = "Apps/pomade-agents/skill";
    expect(f.errorOf("files.symlink", { path: "Agents/claude-coder/x", target })).toBe("capability-denied");
    expect(f.errorOf("files.symlink", { path: "Agents/claude-coder/skills/a/b", target })).toBe("capability-denied");
    expect(f.errorOf("files.symlink", { path: "Agents/linked/skills/x", target })).toBe("capability-denied");
    expect(f.errorOf("files.symlink", { path: "Agents/claude-coder/skills/own", target })).toBe("already-exists");
    expect(f.errorOf("files.symlink", { path: "Agents/claude-coder/skills/x", target: "Apps/nope" })).toBe("not-found");
    expect(f.errorOf("files.symlink", { path: "Agents/claude-coder/skills/x", target: "../outside" })).toBe("outside-workspace");
    expect(f.errorOf("files.removeSymlink", { path: "Agents/claude-coder/skills/own" })).toBe("invalid-params");
    expect(f.errorOf("files.removeSymlink", { path: "Agents/claude-coder/skills/nope" })).toBe("not-found");
    expect(f.errorOf("files.removeSymlink", { path: "Agents/claude-coder/CLAUDE.md" })).toBe("capability-denied");
    expect(fh.readFile("Agents/claude-coder/skills/own/SKILL.md")).toBe("own\n");
  });

  it("needs files.symlink; without declared folders every link is refused", () => {
    const noCap = raw(fake({ manifest: { ...MANIFEST, capabilities: ["files.read", "files.write"] }, files: SKILL_FILES }));
    expect(noCap.errorOf("files.symlink", { path: "Agents/claude-coder/skills/x", target: "Apps/pomade-agents/skill" })).toBe("capability-denied");
    const noScopes = raw(fake({ manifest: { ...MANIFEST, symlinks: [] }, files: SKILL_FILES }));
    expect(noScopes.errorOf("files.symlink", { path: "Agents/claude-coder/skills/x", target: "Apps/pomade-agents/skill" })).toBe("capability-denied");
  });

  it("writing through a link writes its target; the link stays", async () => {
    const fh = fake({ manifest: { ...MANIFEST, capabilities: ["files.read", "files.write", "files.symlink"] }, files: SKILL_FILES });
    fh.symlink("Agents/claude-coder/skills/doc.md", "Apps/pomade-agents/skill/SKILL.md");
    const host = await client(fh);
    await host.files.setField({ path: "Agents/claude-coder/skills/doc.md", key: "name", value: "renamed" });
    expect(fh.isSymlink("Agents/claude-coder/skills/doc.md")).toBe(true);
    expect(fh.readFile("Apps/pomade-agents/skill/SKILL.md")).toBe("---\nname: renamed\n---\n");
  });
});

describe("files.pickFolder", () => {
  const PROJECTS = [{ id: "pomade", name: "Pomade", root: "Projects/Pomade" }];

  it("returns the scripted folder, bounded by the root; starts at initial when it is inside", async () => {
    const fh = fake({ projects: PROJECTS });
    const host = await client(fh);
    fh.answerPick("Projects/Pomade/docs/roadmap");
    expect(await host.files.pickFolder({ root: "pomade", initial: "Projects/Pomade/docs" })).toEqual({ path: "Projects/Pomade/docs/roadmap" });
    fh.answerPick("Projects/Pomade/notes/");
    expect(await host.files.pickFolder()).toEqual({ path: "Projects/Pomade/notes" });
    expect(fh.pickRequests).toEqual([
      { root: "Projects/Pomade", initial: "Projects/Pomade/docs" },
      { root: "", initial: "" },
    ]);
  });

  it("a folder outside the root (or a file) is refused and the picker asks again; no answer = cancelled", async () => {
    const fh = fake({ projects: PROJECTS });
    const host = await client(fh);
    fh.answerPick("Projects");
    fh.answerPick("Projects/Pomade/notes/plain.txt");
    fh.answerPick("Projects/Pomade/notes");
    expect(await host.files.pickFolder({ root: "pomade" })).toEqual({ path: "Projects/Pomade/notes" });
    expect(await host.files.pickFolder({ root: "pomade" })).toEqual({ path: null });
    fh.answerPick(null);
    fh.answerPick("Projects/Pomade/notes");
    expect(await host.files.pickFolder({ root: "pomade" })).toEqual({ path: null });
  });

  it("an initial outside the root or missing starts at the root; errors", async () => {
    const fh = fake({ projects: PROJECTS });
    const f = raw(fh);
    f.call("files.pickFolder", { root: "pomade", initial: "Projects" });
    f.call("files.pickFolder", { root: "pomade", initial: "Projects/Pomade/nope" });
    expect(fh.pickRequests.map((r) => r.initial)).toEqual(["Projects/Pomade", "Projects/Pomade"]);
    expect(f.errorOf("files.pickFolder", { root: "ghost" })).toBe("not-found");
    expect(f.errorOf("files.pickFolder", { root: 3 })).toBe("invalid-params");
    expect(f.errorOf("files.pickFolder", { initial: "../x" })).toBe("outside-workspace");
    const noRead = raw(fake({ manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["project.read"] } }));
    expect(noRead.errorOf("files.pickFolder", {})).toBe("capability-denied");
  });
});
