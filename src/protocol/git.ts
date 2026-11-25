// Git state for apps (pomade:E-030 "git state read", HOST-API §4 `git.read`): the per-repo shape
// Pomade serves from its git-state snapshot, the project-scope rule, and the payload guard.
// Shared by Pomade and the fake host.

import { isInside } from "./paths.js";

/** What changed about a path since the last commit. `new` covers untracked and newly added files;
 *  staged and unstaged edits are both `modified`. */
export type GitFileStatus = "modified" | "new" | "conflict" | "renamed" | "deleted";

export const GIT_FILE_STATUSES: readonly GitFileStatus[] = ["modified", "new", "conflict", "renamed", "deleted"];

/** One uncommitted entry of a repo. */
export interface GitFileChange {
  /** Workspace-relative. */
  path: string;
  status: GitFileStatus;
  /** `renamed` only: the path it was renamed from. */
  from?: string;
  /** An untracked folder reported as one entry: everything inside it is `new`. */
  dir?: true;
}

/** One repository in the workspace. */
export interface GitRepoState {
  /** The repo's folder name — what the Git panel shows and `pomade-git` accepts; the workspace-root
   *  repo is named after the workspace folder. */
  name: string;
  /** The repo's working-tree root, workspace-relative; `""` = the workspace root. */
  root: string;
  /** The working-tree root as an absolute path on this machine. */
  absPath: string;
  /** The remote's URL — the upstream's remote, else `origin`, else the first remote; `null` = local
   *  only (no remote: commits exist only on this machine). */
  remoteUrl: string | null;
  /** Current branch; `null` when detached. */
  branch: string | null;
  /** The upstream the branch tracks (`origin/main`); `null` when it tracks nothing. */
  upstream: string | null;
  /** Commits on the branch not on its upstream; 0 without an upstream. */
  ahead: number;
  /** Commits on the upstream not on the branch (as of the last fetch); 0 without an upstream. */
  behind: number;
  /** False until the repo has its first commit. */
  hasCommits: boolean;
  /** Uncommitted entries; a nested repo's files belong to the nested repo only. */
  changes: GitFileChange[];
  /** Set when Pomade could not read the repo's status; the other fields are then empty. */
  error?: string;
}

/** `git.getState` / `git.watch` — which repos: a project's, or (absent / `"__workspace__"`) every repo. */
export interface GitStateParams {
  projectId?: string;
}

/** `git.reveal` — show a repo in Pomade's Git panel. */
export interface GitRevealParams {
  /** The repo's working-tree root, absolute — `GitRepoState.absPath`, `GitRunResult.path`. */
  path: string;
  /** The project whose Git panel shows it; default the active project (the Workspace scope for a socket client).
   *  A repo outside that project's scope is shown in the Workspace scope's panel instead. Pomade switches to the project. */
  projectId?: string;
}

export interface GitStateResult {
  /** Sorted by root. */
  repos: GitRepoState[];
}

/** `git.changed` — the watched scope's repos after a change. */
export interface GitChangedPayload {
  watchId: string;
  repos: GitRepoState[];
}

/**
 * The repos of a scope (`scopeRoot` workspace-relative; `""` = the workspace): every repo at or
 * below the scope's folder, plus the nearest repo that holds the folder. Order is kept.
 */
export function gitReposInScope<T extends { root: string }>(repos: readonly T[], scopeRoot: string): T[] {
  let enclosing: string | null = null;
  for (const r of repos) {
    if (isInside(scopeRoot, r.root) && (enclosing === null || r.root.length > enclosing.length)) enclosing = r.root;
  }
  return repos.filter((r) => isInside(r.root, scopeRoot) || r.root === enclosing);
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export function isGitFileChange(v: unknown): v is GitFileChange {
  return (
    isObj(v) &&
    typeof v.path === "string" &&
    (GIT_FILE_STATUSES as readonly unknown[]).includes(v.status) &&
    (v.from === undefined || (v.status === "renamed" && typeof v.from === "string")) &&
    (v.dir === undefined || v.dir === true)
  );
}

export function isGitRepoState(v: unknown): v is GitRepoState {
  return (
    isObj(v) &&
    typeof v.name === "string" &&
    typeof v.root === "string" &&
    typeof v.absPath === "string" &&
    isNullableString(v.remoteUrl) &&
    isNullableString(v.branch) &&
    isNullableString(v.upstream) &&
    isCount(v.ahead) &&
    isCount(v.behind) &&
    typeof v.hasCommits === "boolean" &&
    Array.isArray(v.changes) &&
    v.changes.every(isGitFileChange) &&
    (v.error === undefined || typeof v.error === "string")
  );
}
