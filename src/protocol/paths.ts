// Workspace-relative POSIX paths (HOST-API §4): `""` is the workspace root; `..` escapes and
// absolute paths are outside the workspace.

export type NormalizedPath = { ok: true; path: string } | { ok: false };

/**
 * Normalize a workspace-relative path: drop `.` and empty segments, resolve `..` inside the
 * workspace. Absolute paths and `..` escapes give `{ ok: false }` (`outside-workspace`).
 */
export function normalizeWorkspacePath(path: string): NormalizedPath {
  if (path.startsWith("/")) return { ok: false };
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { ok: false };
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return { ok: true, path: out.join("/") };
}

/** Join workspace-relative segments, e.g. a `ProjectRef.root` with an app's own relative path. */
export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/** The last segment of a workspace-relative path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The parent of a workspace-relative path; `""` for a top-level entry. */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
