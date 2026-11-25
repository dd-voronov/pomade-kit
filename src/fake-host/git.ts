// The fake host's git state (pomade:E-030 "git state read"): scripted repos, served and watched
// per scope with the same scope rule as Pomade (`gitReposInScope`).

import { gitReposInScope, isGitRepoState, normalizeWorkspacePath, type GitRepoState } from "../protocol/index.js";

/** Validate and copy scripted repos, sorted by root as Pomade serves them. */
export function scriptedRepos(repos: readonly GitRepoState[]): GitRepoState[] {
  const out = repos.map((r) => {
    if (!isGitRepoState(r)) throw new Error(`fake host: invalid git repo ${JSON.stringify(r)}`);
    const root = normalizeWorkspacePath(r.root);
    if (!root.ok || root.path !== r.root) throw new Error(`fake host: invalid git repo root ${JSON.stringify(r.root)}`);
    return structuredClone(r);
  });
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

/** The repos of a scope (`""` = the workspace), as fresh copies. */
export function reposInScope(repos: readonly GitRepoState[], scopeRoot: string): GitRepoState[] {
  return structuredClone(gitReposInScope(repos, scopeRoot));
}

/** One frame's `git.watch`: its scope and what it last saw (to report changes only). */
export interface GitWatchState {
  /** The project id the watch is scoped to; absent = the workspace. */
  projectId?: string;
  /** The scope's repos as last delivered, serialized. */
  seen: string;
}

/** A `git.reveal` as the fake host records it: the project whose Git panel shows the repo, and the repo's
 *  working-tree root (absolute) as the app passed it. */
export interface FakeGitReveal {
  projectId: string;
  path: string;
}

/** The scripted repo whose working-tree root is `path` (absolute; a trailing `/` is ignored), or null. */
export function repoAt(repos: readonly GitRepoState[], path: string): GitRepoState | null {
  const bare = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return repos.find((r) => bare(r.absPath) === bare(path)) ?? null;
}
