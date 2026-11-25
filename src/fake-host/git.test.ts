import { describe, expect, it } from "vitest";
import type { GitRepoState, HostToAppMessage } from "../protocol/index.js";
import { connect, HostError, type HostClient } from "../sdk/index.js";
import { createFakeHost, type FakeHost, type FakeHostOptions } from "./fake-host.js";

const repo = (root: string, extra: Partial<GitRepoState> = {}): GitRepoState => ({
  name: root === "" ? "workspace" : root.slice(root.lastIndexOf("/") + 1),
  root,
  absPath: `/ws/${root}`,
  remoteUrl: "git@github.com:dd/x.git",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  hasCommits: true,
  changes: [],
  ...extra,
});

const REPOS = [repo("Projects/Pomade", { ahead: 2 }), repo(""), repo("Knowledge", { changes: [{ path: "Knowledge/a.md", status: "modified" }] })];

const PROJECTS = [
  { id: "pomade", name: "Pomade", root: "Projects/Pomade" },
  { id: "notes", name: "Notes", root: "Apps/notes" },
];

function fake(options: FakeHostOptions = {}): FakeHost {
  return createFakeHost({ projects: PROJECTS, git: REPOS, ...options });
}

async function client(host: FakeHost): Promise<HostClient> {
  const r = await connect({ transport: host.createTransport(), keySource: null });
  if (r.status !== "connected") throw new Error(`not connected: ${r.status}`);
  return r.host;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

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
  return { got, frame, call, errorOf };
}

describe("git.getState", () => {
  it("serves every repo sorted by root, or a project's repos plus the repo holding it", async () => {
    const host = await client(fake());
    expect((await host.git.getState()).repos.map((r) => r.root)).toEqual(["", "Knowledge", "Projects/Pomade"]);
    expect((await host.git.getState({ projectId: "__workspace__" })).repos).toHaveLength(3);
    expect(await host.git.getState({ projectId: "pomade" })).toEqual({ repos: [repo("Projects/Pomade", { ahead: 2 })] });
    expect((await host.git.getState({ projectId: "notes" })).repos.map((r) => r.root)).toEqual([""]);
  });

  it("answers copies: changing a result never changes the host's state", async () => {
    const host = await client(fake());
    const first = await host.git.getState();
    first.repos[0]!.changes.push({ path: "x", status: "new" });
    expect((await host.git.getState()).repos[0]!.changes).toEqual([]);
  });

  it("refuses an unknown project, a malformed id and an app without git.read", async () => {
    const f = raw(fake());
    expect(f.errorOf("git.getState", { projectId: "nope" })).toBe("not-found");
    expect(f.errorOf("git.getState", { projectId: 7 })).toBe("invalid-params");
    expect(f.errorOf("git.watch", { projectId: "nope" })).toBe("not-found");
    expect(f.errorOf("git.unwatch", {})).toBe("invalid-params");
    const noGit = raw(fake({ manifest: { id: "no-git", name: "No git", version: "0.0.0", hostApi: 0, capabilities: ["files.read"] } }));
    for (const m of ["git.getState", "git.watch", "git.unwatch"]) expect(noGit.errorOf(m, { watchId: "w1" })).toBe("capability-denied");
    const host = await client(fake({ manifest: { id: "no-git", name: "No git", version: "0.0.0", hostApi: 0, capabilities: [] } }));
    await expect(host.git.getState()).rejects.toBeInstanceOf(HostError);
  });

  it("serves no repos when none are scripted", async () => {
    const host = await client(createFakeHost());
    expect(await host.git.getState()).toEqual({ repos: [] });
  });

  it("refuses an invalid scripted repo", () => {
    expect(() => createFakeHost({ git: [{ ...repo("a"), ahead: -1 }] })).toThrow(/invalid git repo/);
    expect(() => createFakeHost({ git: [repo("../a")] })).toThrow(/invalid git repo root/);
  });
});

describe("git.watch", () => {
  it("delivers the scope's repos when they change, and only then", async () => {
    const fh = fake();
    const host = await client(fh);
    const all: GitRepoState[][] = [];
    const pomade: GitRepoState[][] = [];
    await host.git.watch({}, (repos) => all.push(repos));
    await host.git.watch({ projectId: "pomade" }, (repos) => pomade.push(repos));

    // Knowledge changes: the workspace watch hears it, the Pomade watch does not.
    fh.setGitRepos([...REPOS.slice(0, 2), repo("Knowledge")]);
    await flush();
    expect(all).toHaveLength(1);
    expect(all[0]!.find((r) => r.root === "Knowledge")?.changes).toEqual([]);
    expect(pomade).toEqual([]);

    // The same state again: nothing.
    fh.setGitRepos([...REPOS.slice(0, 2), repo("Knowledge")]);
    await flush();
    expect(all).toHaveLength(1);

    // Pomade is pushed: both hear it.
    fh.setGitRepos([repo("Projects/Pomade"), repo(""), repo("Knowledge")]);
    await flush();
    expect(all).toHaveLength(2);
    expect(pomade).toEqual([[repo("Projects/Pomade")]]);
  });

  it("follows a project that moves", async () => {
    const fh = fake();
    const host = await client(fh);
    const seen: GitRepoState[][] = [];
    await host.git.watch({ projectId: "notes" }, (repos) => seen.push(repos));
    fh.updateProject("notes", { root: "Knowledge/notes" });
    await flush();
    expect(seen.map((repos) => repos.map((r) => r.root))).toEqual([["Knowledge"]]);
  });

  it("close() stops delivery; a new hello drops the frame's git watches", async () => {
    const fh = fake();
    const host = await client(fh);
    const seen: GitRepoState[][] = [];
    const w = await host.git.watch({}, (repos) => seen.push(repos));
    await w.close();
    await w.close();
    fh.setGitRepos([]);
    await flush();
    expect(seen).toEqual([]);

    const f = raw(fh);
    f.call("git.watch", {});
    f.frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    fh.setGitRepos(REPOS);
    expect(f.got.filter((m) => m.type === "event")).toEqual([]);
    expect(f.call("git.unwatch", { watchId: "nope" })).toMatchObject({ ok: true, value: {} });
  });
});

describe("git.reveal", () => {
  it("records the project whose Git panel shows the repo and switches to it; a repo outside the project's scope goes to the Workspace scope", async () => {
    const fh = fake({ activeProject: "pomade" });
    const host = await client(fh);
    const seen: string[] = [];
    host.project.onChange((p) => seen.push(p.id));
    await host.git.reveal("/ws/Projects/Pomade");
    await host.git.reveal("/ws/Projects/Pomade/", "pomade");
    // The repo holding the project's folder is in its scope.
    await host.git.reveal("/ws/", "notes");
    await host.git.reveal("/ws/Knowledge", "pomade");
    await host.git.reveal("/ws/Projects/Pomade", "__workspace__");
    await flush();
    expect(fh.gitReveals).toEqual([
      { projectId: "pomade", path: "/ws/Projects/Pomade" },
      { projectId: "pomade", path: "/ws/Projects/Pomade/" },
      { projectId: "notes", path: "/ws/" },
      { projectId: "__workspace__", path: "/ws/Knowledge" },
      { projectId: "__workspace__", path: "/ws/Projects/Pomade" },
    ]);
    expect(seen).toEqual(["notes", "__workspace__"]);
  });

  it("errors: no repo at the path, a relative path, a bad or unknown project, no git.read", () => {
    const f = raw(fake());
    expect(f.errorOf("git.reveal", { path: "/ws/Apps" })).toBe("not-found");
    expect(f.errorOf("git.reveal", { path: "/ws/Projects/Pomade", projectId: "ghost" })).toBe("not-found");
    expect(f.errorOf("git.reveal", { path: "Projects/Pomade" })).toBe("invalid-params");
    expect(f.errorOf("git.reveal", {})).toBe("invalid-params");
    expect(f.errorOf("git.reveal", { path: "/ws/Projects/Pomade", projectId: 3 })).toBe("invalid-params");
    expect(f.errorOf("git.reveal", { path: "/ws/Projects/Pomade" })).toBeNull();
    const denied = raw(fake({ manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["files.read"] } }));
    expect(denied.errorOf("git.reveal", { path: "/ws/Projects/Pomade" })).toBe("capability-denied");
  });

  it("answers a socket client too; its project defaults to the Workspace scope", () => {
    const fh = fake({
      activeProject: "pomade",
      manifest: { id: "b1", name: "B", version: "1.0.0", hostApi: 0, capabilities: ["git.read"], backend: { entry: "b.mjs", mode: "with-pomade" } },
    });
    const got: HostToAppMessage[] = [];
    const backend = fh.attach((m) => got.push(m), { surface: "backend" });
    backend.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    backend.receive({ channel: "pomade", type: "call", id: "1", method: "git.reveal", params: { path: "/ws/Projects/Pomade" } });
    expect(got.at(-1)).toMatchObject({ ok: true });
    expect(fh.gitReveals).toEqual([{ projectId: "__workspace__", path: "/ws/Projects/Pomade" }]);
  });
});
