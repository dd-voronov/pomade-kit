// The fake host's in-memory workspace: files (path → text) and the folders that hold them.

import {
  baseName,
  isMarkdownPath,
  isPomadeFolderPath,
  normalizeWorkspacePath,
  parentPath,
  readFrontmatter,
  type FileChange,
  type FileEntry,
} from "../protocol/index.js";

interface Node {
  kind: "file" | "dir" | "link";
  content: string;
  size: number;
  mtimeMs: number;
  /** A link's target (workspace-relative). */
  target?: string;
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

  /** What is at `path`, following symlinks (a broken link is `null`). */
  kindOf(path: string): "file" | "dir" | null {
    const node = this.resolve(path);
    return node === null ? null : (node.kind as "file" | "dir");
  }

  /** True when something — a broken symlink included — is at `path` itself. */
  exists(path: string): boolean {
    return this.nodes.has(path);
  }

  /** True when `path` itself is a symlink. */
  isLink(path: string): boolean {
    return this.nodes.get(path)?.kind === "link";
  }

  /** A file's text, size and mtime (symlinks followed); `null` when `path` is not a file. */
  file(path: string): { content: string; size: number; mtimeMs: number } | null {
    const node = this.resolve(path);
    return node?.kind === "file" ? { content: node.content, size: node.size, mtimeMs: node.mtimeMs } : null;
  }

  /** Create a symlink at `path` to `target` (both workspace-relative), making missing parent folders. */
  symlink(path: string, target: string): FileChange[] {
    if (this.nodes.has(path)) throw new Error(`fake host: ${path} already exists`);
    const changes = this.ensureFolder(parentPath(path));
    const time = this.now();
    this.nodes.set(path, { kind: "link", content: "", size: 0, mtimeMs: time, target });
    this.touch(parentPath(path), time);
    changes.push({ kind: "create", path });
    return changes;
  }

  /** Remove the symlink at `path` (never its target). */
  removeLink(path: string): FileChange[] {
    if (!this.isLink(path)) throw new Error(`fake host: no symlink at ${path}`);
    this.nodes.delete(path);
    this.touch(parentPath(path), this.now());
    return [{ kind: "delete", path }];
  }

  /** The path `path` resolves to: a symlink's chain of targets followed (cycle-safe); `path` itself otherwise. */
  realPath(path: string): string {
    let current = path;
    for (let hops = 0; hops < 40; hops++) {
      const node = this.nodes.get(current);
      if (node?.kind !== "link" || node.target === undefined) return current;
      current = node.target;
    }
    return current;
  }

  /** True when an app may see `path`: neither it nor what it points to is in the workspace's `.pomade` folder. */
  isVisible(path: string): boolean {
    return !isPomadeFolderPath(path) && !isPomadeFolderPath(this.realPath(path));
  }

  /** The node at `path` with symlinks followed (cycle-safe); `null` when missing or broken. */
  private resolve(path: string): Node | null {
    let node = this.nodes.get(path);
    for (let hops = 0; node?.kind === "link" && hops < 40; hops++) node = this.nodes.get(node.target ?? "");
    return node && node.kind !== "link" ? node : null;
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
    return !this.isIgnored(rel) && !isPomadeFolderPath(path);
  }

  list(folder: string, recursive: boolean, withFrontmatter: boolean): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const [path, node] of this.nodes) {
      if (path === folder || !isUnder(path, folder)) continue;
      const rel = relativeTo(path, folder);
      if ((!recursive && rel.includes("/")) || this.isIgnored(rel) || !this.isVisible(path)) continue;
      // A symlink reports what it points to (a broken one as a file), and is never descended into.
      const shown = node.kind === "link" ? (this.resolve(path) ?? { ...node, kind: "file" as const }) : node;
      const kind = shown.kind === "dir" ? "dir" : "file";
      const entry: FileEntry = { path, name: baseName(path), kind, size: kind === "dir" ? 0 : shown.size, mtimeMs: shown.mtimeMs };
      if (withFrontmatter && kind === "file" && isMarkdownPath(path)) {
        Object.assign(entry, readFrontmatter(shown.content));
      }
      entries.push(entry);
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Create or overwrite a file, creating missing parent folders. Returns the changes. */
  writeFile(path: string, content: string): FileChange[] {
    // Writing through a symlink writes its target; the link stays a link.
    const link = this.nodes.get(path);
    if (link?.kind === "link" && link.target !== undefined && this.resolve(path)) return this.writeFile(link.target, content);
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
