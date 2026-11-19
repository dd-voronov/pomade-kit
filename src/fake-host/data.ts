// The fake host's workspace-data methods (pomade:E-030): file reads and writes. Same checks,
// same error codes and the same field-only frontmatter code as Pomade.

import { removeField, setBody, setField, setKeyLines, type FieldWriteResult } from "../frontmatter/index.js";
import {
  checkSessionRef,
  isInside,
  isMarkdownPath,
  readFrontmatter,
  jsonProblem,
  mergeProjectSettings,
  normalizeVisibleAgents,
  parentPath,
  settingsSizeProblem,
  symlinkScopeCovers,
  FILES_DELETE_MAX_PATHS,
  WORKSPACE_PROJECT_ID,
  type DeleteFileResult,
  type FileChange,
  type GroupInfo,
  type MethodName,
  type ProjectInfo,
  type ProjectChange,
  type ProjectListResult,
  type ProjectRef,
  type SessionRef,
  type JsonValue,
} from "../protocol/index.js";
import { booleanParam, CallError, entryParam, pathParam, requestPath, requireAllowedTarget, stringParam, type Obj } from "./params.js";
import type { Workspace } from "./workspace.js";

/** A tab an app opened (`tabs.openFile` / `tabs.openTerminal` / `tabs.openAttached` / `tabs.openApp`), as the fake host records it. */
export type FakeOpenedTab =
  | { kind: "file"; projectId: string; path: string }
  | { kind: "terminal"; projectId: string; cwd: string; command?: string; title?: string }
  | { kind: "attached"; projectId: string; session: SessionRef; title?: string }
  | { kind: "app"; projectId: string; route: string };

/** A sidebar group of the fake host (`FakeHostOptions.groups`). */
export interface FakeGroup {
  id: string;
  name: string;
  /** The containing group's id; absent = top level. */
  parent?: string;
}

/** What the data methods need from the fake host. */
export interface DataContext {
  readonly workspace: Workspace;
  emit(changes: FileChange[]): void;
  /** The project `id` names (the active one when absent); `not-found` for an unknown id. */
  project(id: string | undefined): ProjectRef;
  /** Make `id` the active project (emits `project.changed` when it changes). */
  activate(id: string): void;
  readonly openedTabs: FakeOpenedTab[];
  listProjects(): ProjectListResult;
  /** Per project: its visible agents and this app's settings. */
  readonly projectAgents: Map<string, string[]>;
  readonly projectSettings: Map<string, Record<string, JsonValue>>;
  /** A project's agents or this app's settings for it changed: `project.updated`. */
  projectUpdated(id: string, changes: ProjectChange[]): void;
  /** The manifest's `symlinks` folder patterns. */
  readonly symlinkScopes: readonly string[];
  /** The pickers' scripted answers (workspace-relative paths or `null` = cancel), in order. */
  readonly pickAnswers: (string | null)[];
  /** Every picker the app opened: its kind, its root and where it started. */
  readonly pickRequests: FakePickRequest[];
  /** Scripted write failures (`fake.failNextWrite`), in order; each fails the next write to its path once. */
  readonly writeFailures: { path: string; failure: FakeWriteFailure }[];
}

/** How a scripted write fails (`fake.failNextWrite`): what Pomade answers when the disk refuses a write
 *  (`permission`, an `io-error` with the OS's EACCES reason), the disk fails it (`io-error`), or the
 *  target was taken meanwhile (`already-exists`). */
export type FakeWriteFailure = "permission" | "io-error" | "already-exists";

/** Fail this write when a failure is scripted for `path` (once), with the error Pomade gives. */
function scriptedFailure(ctx: DataContext, path: string): void {
  const i = ctx.writeFailures.findIndex((f) => f.path === path);
  if (i < 0) return;
  const { failure } = ctx.writeFailures.splice(i, 1)[0]!;
  switch (failure) {
    case "permission":
      throw new CallError("io-error", `EACCES: permission denied, open '${path}'`);
    case "io-error":
      throw new CallError("io-error", `EIO: i/o error, write '${path}'`);
    case "already-exists":
      throw new CallError("already-exists", `${JSON.stringify(path)} already exists`);
  }
}

/** A picker the app opened (`files.pickFolder` or `files.pickFile`), as the fake host records it. */
export interface FakePickRequest {
  kind: "folder" | "file";
  /** The root folder, workspace-relative (`""` = the workspace); a file picker's `under`. */
  root: string;
  /** Where it started, workspace-relative; a file picker starts at `under`. */
  initial: string;
  /** A file picker's extensions (lowercase, no dot); absent = any file. */
  extensions?: string[];
}

function optionalString(p: Obj, key: string): string | undefined {
  return p[key] === undefined ? undefined : stringParam(p, key);
}

function existingFile(ctx: DataContext, path: string): { content: string; size: number; mtimeMs: number } {
  requireAllowedTarget(ctx.workspace, path);
  const file = ctx.workspace.file(path);
  if (file) return file;
  if (ctx.workspace.kindOf(path) === "dir") throw new CallError("io-error", `EISDIR: ${JSON.stringify(path)} is a folder`);
  throw new CallError("not-found", `${JSON.stringify(path)} does not exist`);
}

/** The optional `ifMtime` param: the `mtimeMs` the app read. */
function ifMtimeParam(p: Obj): number | undefined {
  const v = p.ifMtime;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CallError("invalid-params", '"ifMtime" must be a finite number');
  return v;
}

/** Refuse a conditional write when the file's mtime is not the one the app read. */
function requireMtime(path: string, mtimeMs: number, ifMtime: number | undefined): void {
  if (ifMtime !== undefined && mtimeMs !== ifMtime) {
    throw new CallError("changed-on-disk", `${JSON.stringify(path)} changed on disk since it was read; nothing was written`);
  }
}

function frontmatterValue(v: unknown): string | number | boolean | null | string[] {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new CallError("invalid-params", '"value" must be a string, a number, a boolean, null or a list of strings');
}

/** Apply a kit edit to a file and write it when the bytes changed — refused first when the file
 *  is not the one read at `ifMtime`. */
function edit(ctx: DataContext, path: string, p: Obj, run: (text: string) => FieldWriteResult): { changed: boolean } {
  const ifMtime = ifMtimeParam(p);
  const file = existingFile(ctx, path);
  requireMtime(path, file.mtimeMs, ifMtime);
  scriptedFailure(ctx, path);
  const r = run(file.content);
  if (!r.ok) {
    throw new CallError(r.reason === "invalid-value" ? "invalid-params" : r.reason, `${JSON.stringify(path)}: ${r.message}`);
  }
  if (r.changed) ctx.emit(ctx.workspace.writeFile(path, r.text));
  return { changed: r.changed };
}

function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The file methods of pomade:E-030 (`files.readFile` and the `files.write` group). */
export type FileDataMethod = Extract<
  MethodName,
  "files.readFile" | "files.create" | "files.write" | "files.setBody" | "files.setField" | "files.removeField" | "files.setKeyLines" | "files.move" | "files.delete"
>;

export function dispatchFileWrite(ctx: DataContext, method: FileDataMethod, p: Obj): unknown {
  const ws = ctx.workspace;
  switch (method) {
    case "files.readFile": {
      const path = entryParam(p, "path");
      const withFrontmatter = booleanParam(p, "frontmatter");
      const file = existingFile(ctx, path);
      return withFrontmatter && isMarkdownPath(path) ? { ...file, ...readFrontmatter(file.content) } : file;
    }
    case "files.create": {
      const path = entryParam(p, "path");
      const content = p.content === undefined ? "" : stringParam(p, "content");
      if (ws.kindOf(path) !== null) throw new CallError("already-exists", `${JSON.stringify(path)} already exists`);
      if (ancestorIsFile(ws, path)) {
        throw new CallError("io-error", `ENOTDIR: a parent of ${JSON.stringify(path)} is a file`);
      }
      scriptedFailure(ctx, path);
      ctx.emit(ws.writeFile(path, content));
      return {};
    }
    case "files.write": {
      const path = entryParam(p, "path");
      const content = stringParam(p, "content");
      const ifMtime = ifMtimeParam(p);
      requireMtime(path, existingFile(ctx, path).mtimeMs, ifMtime);
      scriptedFailure(ctx, path);
      ctx.emit(ws.writeFile(path, content));
      return {};
    }
    case "files.setBody": {
      const path = entryParam(p, "path");
      const body = stringParam(p, "body");
      return edit(ctx, path, p, (text) => setBody(text, body));
    }
    case "files.setField": {
      const path = entryParam(p, "path");
      const key = stringParam(p, "key");
      if (!("value" in p)) throw new CallError("invalid-params", '"value" is required');
      const value = frontmatterValue(p.value);
      return edit(ctx, path, p, (text) => setField(text, key, value));
    }
    case "files.removeField": {
      const path = entryParam(p, "path");
      const key = stringParam(p, "key");
      return edit(ctx, path, p, (text) => removeField(text, key));
    }
    case "files.setKeyLines": {
      const path = entryParam(p, "path");
      const key = stringParam(p, "key");
      const lines = stringParam(p, "text");
      return edit(ctx, path, p, (text) => setKeyLines(text, key, lines));
    }
    case "files.move": {
      const from = entryParam(p, "from");
      const to = entryParam(p, "to");
      if (ws.kindOf(from) === null) throw new CallError("not-found", `${JSON.stringify(from)} does not exist`);
      if (from === to) return {};
      if (isUnder(to, from)) throw new CallError("invalid-params", `cannot move ${JSON.stringify(from)} into itself`);
      if (ws.kindOf(to) !== null) throw new CallError("already-exists", `${JSON.stringify(to)} already exists`);
      if (ancestorIsFile(ws, to)) throw new CallError("io-error", `ENOTDIR: a parent of ${JSON.stringify(to)} is a file`);
      scriptedFailure(ctx, from);
      scriptedFailure(ctx, to);
      ctx.emit(ws.rename(from, to));
      return {};
    }
    case "files.delete": {
      const paths = deletePaths(p);
      const changes: FileChange[] = [];
      const results = paths.map((raw): DeleteFileResult => {
        try {
          changes.push(...deleteOne(ctx, raw));
          return { path: raw, ok: true };
        } catch (err) {
          if (!(err instanceof CallError)) throw err;
          return { path: raw, ok: false, error: { code: err.code, message: err.message } };
        }
      });
      ctx.emit(changes);
      return { results };
    }
  }
}

/** `files.delete`'s `paths`: a list of strings, at most `FILES_DELETE_MAX_PATHS`. Each path's own rule is checked per entry. */
function deletePaths(p: Obj): string[] {
  const v = p.paths;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new CallError("invalid-params", '"paths" must be a list of strings');
  if (v.length > FILES_DELETE_MAX_PATHS) throw new CallError("invalid-params", `"paths" takes at most ${FILES_DELETE_MAX_PATHS} paths`);
  return v as string[];
}

/** Delete one file as Pomade moves it to the Trash: a symlink goes as the link itself. */
function deleteOne(ctx: DataContext, raw: string): FileChange[] {
  const ws = ctx.workspace;
  const path = requestPath(raw);
  if (path === "") throw new CallError("invalid-params", "the workspace root is a folder, not a file");
  if (!ws.exists(path)) throw new CallError("not-found", `${JSON.stringify(raw)} does not exist`);
  requireAllowedTarget(ws, path);
  if (ws.kindOf(path) === "dir") throw new CallError("invalid-params", `${JSON.stringify(raw)} is a folder; files.delete deletes files only`);
  scriptedFailure(ctx, path);
  return ws.isLink(path) ? ws.removeLink(path) : ws.deleteFile(path);
}

function ancestorIsFile(ws: Workspace, path: string): boolean {
  for (let dir = parentPath(path); dir !== ""; dir = parentPath(dir)) {
    if (ws.kindOf(dir) === "file") return true;
  }
  return false;
}

/** The tab methods of pomade:E-030. */
export type TabDataMethod = Extract<MethodName, "tabs.openFile" | "tabs.openTerminal" | "tabs.openAttached" | "tabs.openApp">;

export function dispatchTabs(ctx: DataContext, method: TabDataMethod, p: Obj): unknown {
  const ws = ctx.workspace;
  switch (method) {
    case "tabs.openFile": {
      const path = entryParam(p, "path");
      existingFile(ctx, path);
      const project = ctx.project(optionalString(p, "projectId"));
      ctx.activate(project.id);
      ctx.openedTabs.push({ kind: "file", projectId: project.id, path });
      return {};
    }
    case "tabs.openAttached": {
      const ref = checkSessionRef(p.session);
      if (!ref.ok) throw new CallError("invalid-params", ref.message);
      const title = optionalString(p, "title");
      if (title !== undefined && title.trim() === "") throw new CallError("invalid-params", '"title" must not be empty');
      const project = ctx.project(optionalString(p, "projectId"));
      ctx.activate(project.id);
      ctx.openedTabs.push({
        kind: "attached",
        projectId: project.id,
        session: ref.value,
        ...(title !== undefined ? { title: title.trim() } : {}),
      });
      return {};
    }
    case "tabs.openTerminal": {
      const cwd = pathParam(p, "cwd");
      const command = optionalString(p, "command");
      const title = optionalString(p, "title");
      if (command !== undefined && (command.trim() === "" || /[\r\n]/.test(command))) {
        throw new CallError("invalid-params", '"command" must be one non-empty line');
      }
      if (title !== undefined && title.trim() === "") throw new CallError("invalid-params", '"title" must not be empty');
      const kind = ws.kindOf(cwd);
      if (kind === null) throw new CallError("not-found", `${JSON.stringify(cwd)} does not exist`);
      requireAllowedTarget(ws, cwd);
      if (kind !== "dir") throw new CallError("io-error", `${JSON.stringify(cwd)} is not a folder`);
      const project = ctx.project(optionalString(p, "projectId"));
      ctx.activate(project.id);
      ctx.openedTabs.push({
        kind: "terminal",
        projectId: project.id,
        cwd,
        ...(command !== undefined ? { command } : {}),
        ...(title !== undefined ? { title: title.trim() } : {}),
      });
      return {};
    }
    case "tabs.openApp": {
      const route = optionalString(p, "route") ?? "";
      const project = ctx.project(optionalString(p, "projectId"));
      ctx.activate(project.id);
      ctx.openedTabs.push({ kind: "app", projectId: project.id, route });
      return {};
    }
  }
}

/** Groups and projects in sidebar order, as Pomade lists them: each group (siblings in their
 *  given order) with its projects, then its sub-groups; ungrouped projects last. */
export function listProjects(
  groups: readonly FakeGroup[],
  projects: readonly ProjectRef[],
  projectGroup: ReadonlyMap<string, string>,
): ProjectListResult {
  const outGroups: GroupInfo[] = [];
  const outProjects: ProjectInfo[] = [];
  const project = (p: ProjectRef, groupId: string | null, groupPath: string[]): ProjectInfo => ({
    id: p.id,
    kind: "project",
    name: p.name,
    root: p.root,
    groupId,
    groupPath: [...groupPath],
  });
  const walk = (parent: string | undefined, parentPath: string[]): void => {
    for (const g of groups.filter((x) => x.parent === parent)) {
      const path = [...parentPath, g.name];
      outGroups.push({ id: g.id, name: g.name, parentId: g.parent ?? null, path });
      for (const p of projects) if (projectGroup.get(p.id) === g.id) outProjects.push(project(p, g.id, path));
      walk(g.id, path);
    }
  };
  walk(undefined, []);
  for (const p of projects) if (!projectGroup.has(p.id)) outProjects.push(project(p, null, []));
  return {
    workspace: { id: WORKSPACE_PROJECT_ID, kind: "workspace", name: "Workspace", root: "" },
    groups: outGroups,
    projects: outProjects,
  };
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The project methods of pomade:E-030. */
export type ProjectDataMethod = Extract<
  MethodName,
  "project.list" | "project.getSettings" | "project.setSettings" | "project.getAgents" | "project.setAgents"
>;

/** A real project's id from params; the Workspace scope has no settings or agent list to write. */
function projectParam(ctx: DataContext, p: Obj, what: string): string {
  const id = stringParam(p, "projectId");
  if (id === WORKSPACE_PROJECT_ID) throw new CallError("invalid-params", `The Workspace scope has no ${what}`);
  return ctx.project(id).id;
}

export function dispatchProjects(ctx: DataContext, method: ProjectDataMethod, p: Obj): unknown {
  switch (method) {
    case "project.list":
      return ctx.listProjects();
    case "project.getSettings":
      return { settings: structuredClone(ctx.projectSettings.get(projectParam(ctx, p, "project settings")) ?? {}) };
    case "project.setSettings": {
      const id = projectParam(ctx, p, "project settings");
      const patch = p.settings;
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new CallError("invalid-params", '"settings" must be an object');
      }
      const problem = jsonProblem(patch);
      if (problem) throw new CallError("invalid-params", `"settings": ${problem}`);
      const merged = mergeProjectSettings(ctx.projectSettings.get(id) ?? {}, structuredClone(patch as Record<string, JsonValue>));
      const tooBig = settingsSizeProblem(merged);
      if (tooBig) throw new CallError("invalid-params", tooBig);
      const before = JSON.stringify(ctx.projectSettings.get(id) ?? {});
      ctx.projectSettings.set(id, merged);
      if (JSON.stringify(merged) !== before) ctx.projectUpdated(id, ["settings"]);
      return { settings: structuredClone(merged) };
    }
    case "project.getAgents": {
      const id = stringParam(p, "projectId");
      if (id === WORKSPACE_PROJECT_ID) return { visibleAgents: ["*"] };
      return { visibleAgents: [...(ctx.projectAgents.get(ctx.project(id).id) ?? ["*"])] };
    }
    case "project.setAgents": {
      const id = projectParam(ctx, p, "agent list");
      const agents = normalizeVisibleAgents(p.visibleAgents);
      if (typeof agents === "string") throw new CallError("invalid-params", agents);
      const before = ctx.projectAgents.get(id) ?? ["*"];
      ctx.projectAgents.set(id, agents);
      if (!sameList(before, agents)) ctx.projectUpdated(id, ["agents"]);
      return {};
    }
  }
}

/** The symlink methods of pomade:E-030. */
export type SymlinkDataMethod = Extract<MethodName, "files.symlink" | "files.removeSymlink">;

/** A link path the manifest grants: directly in a `symlinks` folder, reached without any symlink. */
function grantedLinkPath(ctx: DataContext, p: Obj): string {
  const path = entryParam(p, "path");
  if (!symlinkScopeCovers(ctx.symlinkScopes, path)) {
    throw new CallError("capability-denied", `${JSON.stringify(path)} is not in a folder the manifest's "symlinks" declares`);
  }
  for (let dir = parentPath(path); dir !== ""; dir = parentPath(dir)) {
    if (ctx.workspace.isLink(dir)) {
      throw new CallError("capability-denied", `${JSON.stringify(path)}: the folder ${JSON.stringify(dir)} is a symlink`);
    }
  }
  return path;
}

export function dispatchSymlinks(ctx: DataContext, method: SymlinkDataMethod, p: Obj): unknown {
  const ws = ctx.workspace;
  switch (method) {
    case "files.symlink": {
      const path = grantedLinkPath(ctx, p);
      const target = entryParam(p, "target");
      if (ws.exists(path)) throw new CallError("already-exists", `${JSON.stringify(path)} already exists`);
      if (ws.kindOf(target) === null) throw new CallError("not-found", `${JSON.stringify(target)} does not exist`);
      requireAllowedTarget(ws, target);
      if (ancestorIsFile(ws, path)) throw new CallError("io-error", `ENOTDIR: a parent of ${JSON.stringify(path)} is a file`);
      ctx.emit(ws.symlink(path, target));
      return {};
    }
    case "files.removeSymlink": {
      const path = grantedLinkPath(ctx, p);
      if (!ws.exists(path)) throw new CallError("not-found", `${JSON.stringify(path)} does not exist`);
      if (!ws.isLink(path)) throw new CallError("invalid-params", `${JSON.stringify(path)} is not a symlink; only links are removed`);
      ctx.emit(ws.removeLink(path));
      return {};
    }
  }
}

/** The pickers of pomade:E-030 and pomade:T-245. */
export type PickDataMethod = Extract<MethodName, "files.pickFolder" | "files.pickFile">;

/** A picker against scripted answers: an answer outside the root, of the wrong kind (a file for a
 *  folder picker and the reverse) or, for a file picker, of another extension is refused like
 *  Pomade's dialog refuses it (the picker asks again: the next answer). No answer left = the
 *  user cancelled. */
export function dispatchPick(ctx: DataContext, method: PickDataMethod, p: Obj): unknown {
  return method === "files.pickFile" ? pickFile(ctx, p) : pickFolder(ctx, p);
}

function pickFile(ctx: DataContext, p: Obj): unknown {
  const under = p.under === undefined ? "" : pathParam(p, "under");
  const extensions = extensionsParam(p);
  if (ctx.workspace.kindOf(under) !== "dir") throw new CallError("not-found", `${JSON.stringify(under)} is not a folder`);
  ctx.pickRequests.push({ kind: "file", root: under, initial: under, ...(extensions ? { extensions } : {}) });
  for (;;) {
    const answer = ctx.pickAnswers.shift();
    if (answer === undefined || answer === null) return { path: null };
    if (!isInside(answer, under) || ctx.workspace.kindOf(answer) !== "file" || !ctx.workspace.isVisible(answer)) continue;
    if (extensions && !extensions.includes(extensionOf(answer))) continue;
    return { path: answer };
  }
}

/** A file's extension, lowercase, without the dot; `""` when it has none (a leading dot is not one). */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `extensions`: absent, or a non-empty list of bare extensions (letters and digits); lowercased. */
function extensionsParam(p: Obj): string[] | undefined {
  const v = p.extensions;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && /^[A-Za-z0-9]+$/.test(x))) {
    throw new CallError("invalid-params", '"extensions" must be a non-empty list of extensions without the dot');
  }
  return (v as string[]).map((x) => x.toLowerCase());
}

function pickFolder(ctx: DataContext, p: Obj): unknown {
  const rootId = optionalString(p, "root");
  const root = rootId === undefined || rootId === WORKSPACE_PROJECT_ID ? "" : ctx.project(rootId).root;
  const wanted = p.initial === undefined ? root : pathParam(p, "initial");
  const initial = isInside(wanted, root) && ctx.workspace.kindOf(wanted) === "dir" ? wanted : root;
  ctx.pickRequests.push({ kind: "folder", root, initial });
  for (;;) {
    const answer = ctx.pickAnswers.shift();
    if (answer === undefined || answer === null) return { path: null };
    if (isInside(answer, root) && ctx.workspace.kindOf(answer) === "dir" && ctx.workspace.isVisible(answer)) return { path: answer };
  }
}
