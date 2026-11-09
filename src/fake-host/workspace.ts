// The fake host's in-memory workspace: files (path → text) and the folders that hold them.

import {
  baseName,
  isMarkdownPath,
  normalizeWorkspacePath,
  parentPath,
  readFrontmatter,
  type FileChange,
  type FileEntry,
} from "../protocol/index.js";

interface Node {
  kind: "file" | "dir";
  content: string;
  size: number;
  mtimeMs: number;
}

const encoder = new TextEncoder();

/** A path a test control was given: normalized, inside the workspace, not the root. */
export function controlPath(path: string): string {
  const n = normalizeWorkspacePath(path);
  if (!n.ok || n.path === "") throw new Error(`fake host: invalid workspace path ${JSON.stringify(path)}`);
  return n.path;
}

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(folder + "/");
}

/** `path` relative to `folder` (`path` is under `folder`). */
function relativeTo(path: string, folder: string): string {
  if (path === folder) return "";
  return folder === "" ? path : path.slice(folder.length + 1);
}

export class Workspace {
  private readonly nodes = new Map<string, Node>();
  private readonly ignore: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(files: Record<string, string>, ignore: readonly string[], now: () => number) {
    this.ignore = new Set(ignore);
    this.now = now;
    this.nodes.set("", { kind: "dir", content: "", size: 0, mtimeMs: now() });
    for (const [path, content] of Object.entries(files)) this.writeFile(controlPath(path), content);
  }

  kindOf(path: string): "file" | "dir" | null {
    return this.nodes.get(path)?.kind ?? null;
  }

  /** True when a segment of `rel` (relative to some folder) is on the ignore list. */
  isIgnored(rel: string): boolean {
    return rel !== "" && rel.split("/").some((seg) => this.ignore.has(seg));
  }

  /** Whether a change at `path` concerns a watch on `folder`. */
  concerns(folder: string, recursive: boolean, path: string): boolean {
    if (!isUnder(path, folder)) return false;
    const rel = relativeTo(path, folder);
    if (rel === "") return true;
    if (!recursive && rel.includes("/")) return false;
    return !this.isIgnored(rel);
  }

  list(folder: string, recursive: boolean, withFrontmatter: boolean): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const [path, node] of this.nodes) {
      if (path === folder || !isUnder(path, folder)) continue;
      const rel = relativeTo(path, folder);
      if ((!recursive && rel.includes("/")) || this.isIgnored(rel)) continue;
      const entry: FileEntry = { path, name: baseName(path), kind: node.kind, size: node.size, mtimeMs: node.mtimeMs };
      if (withFrontmatter && node.kind === "file" && isMarkdownPath(path)) {
        Object.assign(entry, readFrontmatter(node.content));
      }
      entries.push(entry);
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Create or overwrite a file, creating missing parent folders. Returns the changes. */
  writeFile(path: string, content: string): FileChange[] {
    const existing = this.nodes.get(path);
    if (existing?.kind === "dir") throw new Error(`fake host: ${path} is a folder`);
    const changes = this.ensureFolder(parentPath(path));
    const time = this.now();
    this.nodes.set(path, { kind: "file", content, size: encoder.encode(content).length, mtimeMs: time });
    if (!existing) this.touch(parentPath(path), time);
    changes.push({ kind: existing ? "change" : "create", path });
    return changes;
  }

  deleteFile(path: string): FileChange[] {
    if (this.nodes.get(path)?.kind !== "file") throw new Error(`fake host: no file at ${path}`);
    this.nodes.delete(path);
    this.touch(parentPath(path), this.now());
    return [{ kind: "delete", path }];
  }

  /** Move a file or a folder (with everything under it). */
  rename(from: string, to: string): FileChange[] {
    if (!this.nodes.has(from)) throw new Error(`fake host: nothing at ${from}`);
    if (this.nodes.has(to)) throw new Error(`fake host: ${to} already exists`);
    if (isUnder(to, from)) throw new Error(`fake host: cannot move ${from} into itself`);
    const changes = this.ensureFolder(parentPath(to));
    const moved = [...this.nodes].filter(([p]) => isUnder(p, from));
    for (const [p] of moved) this.nodes.delete(p);
    for (const [p, node] of moved) this.nodes.set(to + p.slice(from.length), node);
    const time = this.now();
    this.touch(parentPath(from), time);
    this.touch(parentPath(to), time);
    changes.push({ kind: "rename", path: to, oldPath: from });
    return changes;
  }

  private ensureFolder(folder: string): FileChange[] {
    const node = this.nodes.get(folder);
    if (node?.kind === "dir") return [];
    if (node) throw new Error(`fake host: ${folder} is a file`);
    const changes = this.ensureFolder(parentPath(folder));
    const time = this.now();
    this.nodes.set(folder, { kind: "dir", content: "", size: 0, mtimeMs: time });
    this.touch(parentPath(folder), time);
    changes.push({ kind: "create", path: folder });
    return changes;
  }

  private touch(folder: string, time: number): void {
    const node = this.nodes.get(folder);
    if (node) node.mtimeMs = time;
  }
}
