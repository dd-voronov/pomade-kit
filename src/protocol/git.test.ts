import { describe, expect, it } from "vitest";
import { gitReposInScope, isGitFileChange, isGitRepoState, type GitRepoState } from "./git.js";
import { parseHostMessage } from "./guards.js";

const repo = (root: string, extra: Partial<GitRepoState> = {}): GitRepoState => ({
  name: root === "" ? "git-base" : root.slice(root.lastIndexOf("/") + 1),
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

describe("gitReposInScope", () => {
  const roots = ["", "Knowledge", "Projects/Pomade", "Projects/Pomade/vendor/lib", "Projects/pomade-kit"];
  const repos = roots.map((r) => repo(r));
  it.each([
    ["", roots],
    ["Projects/Pomade", ["Projects/Pomade", "Projects/Pomade/vendor/lib"]],
    ["Projects/Pomade/docs", ["Projects/Pomade"]],
    ["Projects/Pomade/vendor/lib/src", ["Projects/Pomade/vendor/lib"]],
    ["Projects", ["", "Projects/Pomade", "Projects/Pomade/vendor/lib", "Projects/pomade-kit"]],
    ["Projects/Pom", [""]],
    ["Apps/notes", [""]],
  ])("scope %j → %j", (scope, expected) => {
    expect(gitReposInScope(repos, scope).map((r) => r.root)).toEqual(expected);
  });

  it("a folder outside every repo has none", () => {
    const nested = [repo("Projects/Pomade"), repo("Knowledge")];
    expect(gitReposInScope(nested, "Apps")).toEqual([]);
    expect(gitReposInScope(nested, "").map((r) => r.root)).toEqual(["Projects/Pomade", "Knowledge"]);
  });
});

describe("git guards", () => {
  it("accepts every file status, a rename's `from`, an untracked folder", () => {
    for (const status of ["modified", "new", "conflict", "renamed", "deleted"]) {
      expect(isGitFileChange({ path: "a", status })).toBe(true);
    }
    expect(isGitFileChange({ path: "b", status: "renamed", from: "a" })).toBe(true);
    expect(isGitFileChange({ path: "d", status: "new", dir: true })).toBe(true);
  });

  it.each([
    [{ path: "a", status: "staged" }],
    [{ path: 1, status: "new" }],
    [{ path: "a", status: "modified", from: "b" }],
    [{ path: "a", status: "new", dir: false }],
    [null],
  ])("rejects the change %j", (v) => {
    expect(isGitFileChange(v)).toBe(false);
  });

  it("accepts a repo, a detached one, a failed one", () => {
    expect(isGitRepoState(repo("", { changes: [{ path: "x", status: "new" }] }))).toBe(true);
    expect(isGitRepoState(repo("a", { branch: null, upstream: null, remoteUrl: null }))).toBe(true);
    expect(isGitRepoState(repo("a", { error: "not a git repository", hasCommits: false }))).toBe(true);
  });

  it.each([
    ["ahead", -1],
    ["behind", 1.5],
    ["branch", 3],
    ["hasCommits", "yes"],
    ["changes", [{ path: "a" }]],
    ["error", null],
    ["name", undefined],
    ["absPath", undefined],
    ["remoteUrl", undefined],
    ["remoteUrl", 3],
  ])("rejects a repo whose %s is %j", (key, value) => {
    expect(isGitRepoState({ ...repo("a"), [key]: value })).toBe(false);
  });

  it("parses git.changed and ignores a malformed one", () => {
    const payload = { watchId: "w1", repos: [repo("Projects/Pomade")] };
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "git.changed", payload })).toEqual({
      channel: "pomade",
      type: "event",
      name: "git.changed",
      payload,
    });
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "git.changed", payload: { watchId: "w1", repos: [{}] } })).toBeNull();
    expect(parseHostMessage({ channel: "pomade", type: "event", name: "git.changed", payload: { repos: [] } })).toBeNull();
  });
});
