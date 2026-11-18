import { describe, expect, it } from "vitest";
import type { HostToAppMessage } from "../protocol/index.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

const FILES = {
  ".pomade/workspace.json": "{}\n",
  ".pomade/notes.md": "---\nid: X\n---\n",
  "Projects/a/README.md": "# A\n",
  "Projects/a/.pomade/own.md": "a project's own .pomade is not the workspace's\n",
  ".pomaderc": "x\n",
};

function fake(): FakeHost {
  const host = createFakeHost({
    files: FILES,
    projects: [{ id: "a", name: "A", root: "Projects/a" }],
    manifest: {
      id: "app",
      name: "App",
      version: "0.0.0",
      hostApi: 0,
      capabilities: ["project.read", "files.read", "files.write", "files.symlink", "tabs.open"],
      symlinks: ["Projects/a/links", ".pomade"],
    },
  });
  host.symlink("Projects/a/cfg.json", ".pomade/workspace.json");
  host.symlink("Projects/a/cfg-dir", ".pomade");
  return host;
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

const LEXICAL = [".pomade", ".pomade/workspace.json", "./.pomade/x.md", "Projects/../.pomade/notes.md", ".Pomade/workspace.json"];

describe("the workspace's .pomade folder is out of reach", () => {
  // Every path-taking method × every spelling of a path at or inside .pomade.
  const calls: [string, (p: string) => Record<string, unknown>][] = [
    ["files.readFolder", (path) => ({ path })],
    ["files.watch", (path) => ({ path })],
    ["files.readFile", (path) => ({ path })],
    ["files.create", (path) => ({ path: `${path}/new.md` })],
    ["files.write", (path) => ({ path, content: "x" })],
    ["files.setBody", (path) => ({ path, body: "x" })],
    ["files.setField", (path) => ({ path, key: "k", value: "v" })],
    ["files.removeField", (path) => ({ path, key: "k" })],
    ["files.setKeyLines", (path) => ({ path, key: "k", text: "k:\n  a: 1" })],
    ["files.move", (path) => ({ from: path, to: "Projects/a/moved" })],
    ["files.move", (path) => ({ from: "Projects/a/README.md", to: `${path}/README.md` })],
    ["files.symlink", (path) => ({ path: "Projects/a/links/l", target: path })],
    ["files.symlink", (path) => ({ path: `${path}/l`, target: "Projects/a/README.md" })],
    ["files.removeSymlink", (path) => ({ path })],
    ["files.pickFolder", (path) => ({ initial: path })],
    ["tabs.openFile", (path) => ({ path })],
    ["tabs.openTerminal", (path) => ({ cwd: path })],
  ];
  for (const [method, params] of calls) {
    it.each(LEXICAL)(`${method} refuses %j with capability-denied`, (path) => {
      expect(raw(fake()).errorOf(method, params(path))).toBe("capability-denied");
    });
  }

  it("refuses by real path: a symlink into .pomade cannot be read, written, listed, watched, opened or linked to", () => {
    const f = raw(fake());
    for (const [method, params] of [
      ["files.readFile", { path: "Projects/a/cfg.json" }],
      ["files.write", { path: "Projects/a/cfg.json", content: "{}" }],
      ["files.setField", { path: "Projects/a/cfg.json", key: "k", value: 1 }],
      ["files.readFolder", { path: "Projects/a/cfg-dir" }],
      ["files.watch", { path: "Projects/a/cfg-dir" }],
      ["tabs.openFile", { path: "Projects/a/cfg.json" }],
      ["tabs.openTerminal", { cwd: "Projects/a/cfg-dir" }],
      ["files.symlink", { path: "Projects/a/links/l", target: "Projects/a/cfg.json" }],
    ] as const) {
      expect(f.errorOf(method, params), method).toBe("capability-denied");
    }
  });

  it("files.delete refuses each path at or inside .pomade (and a link into it) on its own entry; the file stays", () => {
    const host = fake();
    const r = raw(host).call("files.delete", { paths: [...LEXICAL, "Projects/a/cfg.json", "Projects/a/README.md"] });
    if (!r.ok) throw new Error(r.error.message);
    const results = (r.value as { results: { path: string; ok: boolean; error?: { code: string } }[] }).results;
    expect(results.map((e) => [e.path, e.ok ? "ok" : e.error?.code])).toEqual([
      ...LEXICAL.map((p) => [p, "capability-denied"]),
      ["Projects/a/cfg.json", "capability-denied"],
      ["Projects/a/README.md", "ok"],
    ]);
    expect(host.isSymlink("Projects/a/cfg.json")).toBe(true);
    expect(host.readFile(".pomade/workspace.json")).toBe("{}\n");
  });

  it("listings leave .pomade and links into it out; a project's own .pomade and .pomaderc stay", () => {
    const r = raw(fake()).call("files.readFolder", { path: "", recursive: true });
    if (!r.ok) throw new Error(r.error.message);
    const paths = (r.value as { entries: { path: string }[] }).entries.map((e) => e.path);
    expect(paths.filter((p) => p.toLowerCase().startsWith(".pomade/") || p === ".pomade")).toEqual([]);
    expect(paths).not.toContain("Projects/a/cfg.json");
    expect(paths).not.toContain("Projects/a/cfg-dir");
    expect(paths).toContain("Projects/a/.pomade/own.md");
    expect(paths).toContain(".pomaderc");
  });

  it("watch events for .pomade paths are not delivered", () => {
    const host = fake();
    const f = raw(host);
    f.call("files.watch", { path: "", recursive: true });
    host.writeFile(".pomade/workspace.json", "{ }\n");
    host.writeFile("Projects/a/README.md", "# A2\n");
    const events = f.got.filter((m) => m.type === "event");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(".pomade");
  });

  it("a picked folder inside .pomade is refused like one outside the root", () => {
    const host = fake();
    host.answerPick(".pomade");
    host.answerPick("Projects/a");
    expect(raw(host).call("files.pickFolder", {})).toMatchObject({ ok: true, value: { path: "Projects/a" } });
  });
});
