// The fake host's workspace-data methods (pomade:E-030): file reads and writes. Same checks,
// same error codes and the same field-only frontmatter code as Pomade.

import { removeField, setBody, setField, type FieldWriteResult } from "../frontmatter/index.js";
import {
  isInside,
  jsonProblem,
  mergeProjectSettings,
  normalizeVisibleAgents,
  parentPath,
  settingsSizeProblem,
  symlinkScopeCovers,
  WORKSPACE_PROJECT_ID,
  type FileChange,
  type GroupInfo,
  type MethodName,
  type ProjectInfo,
  type ProjectListResult,
  type ProjectRef,
  type JsonValue,
} from "../protocol/index.js";
import { CallError, entryParam, pathParam, requireAllowedTarget, stringParam, type Obj } from "./params.js";
import type { Workspace } from "./workspace.js";

/** A tab an app opened (`tabs.openFile` / `tabs.openTerminal` / `tabs.openApp`), as the fake host records it. */
export type FakeOpenedTab =
  | { kind: "file"; projectId: string; path: string }
  | { kind: "terminal"; projectId: string; cwd: string; command?: string; title?: string }
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
  /** The manifest's `symlinks` folder patterns. */
  readonly symlinkScopes: readonly string[];
  /** The folder picker's scripted answers (workspace-relative paths or `null` = cancel), in order. */
  readonly pickAnswers: (string | null)[];
  /** Every picker the app opened: its root and where it started. */
  readonly pickRequests: FakePickRequest[];
}

/** A folder picker the app opened (`files.pickFolder`), as the fake host records it. */
export interface FakePickRequest {
  /** The root folder, workspace-relative (`""` = the workspace). */
  root: string;
  /** Where it started, workspace-relative. */
  initial: string;
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

function frontmatterValue(v: unknown): string | number | boolean | null | string[] {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new CallError("invalid-params", '"value" must be a string, a number, a boolean, null or a list of strings');
}

/** Apply a kit edit to a file and write it when the bytes changed. */
function edit(ctx: DataContext, path: string, run: (text: string) => FieldWriteResult): { changed: boolean } {
  const r = run(existingFile(ctx, path).content);
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
  "files.readFile" | "files.create" | "files.write" | "files.setBody" | "files.setField" | "files.removeField" | "files.move"
>;

export function dispatchFileWrite(ctx: DataContext, method: FileDataMethod, p: Obj): unknown {
  const ws = ctx.workspace;
  switch (method) {
    case "files.readFile":
      return existingFile(ctx, entryParam(p, "path"));
    case "files.create": {
      const path = entryParam(p, "path");
      const content = p.content === undefined ? "" : stringParam(p, "content");
      if (ws.kindOf(path) !== null) throw new CallError("already-exists", `${JSON.stringify(path)} already exists`);
      if (ancestorIsFile(ws, path)) {
        throw new CallError("io-error", `ENOTDIR: a parent of ${JSON.stringify(path)} is a file`);
      }
      ctx.emit(ws.writeFile(path, content));
      return {};
    }
    case "files.write": {
      const path = entryParam(p, "path");
      const content = stringParam(p, "content");
      existingFile(ctx, path);
      ctx.emit(ws.writeFile(path, content));
      return {};
    }
    case "files.setBody": {
      const path = entryParam(p, "path");
      const body = stringParam(p, "body");
      return edit(ctx, path, (text) => setBody(text, body));
    }
    case "files.setField": {
      const path = entryParam(p, "path");
      const key = stringParam(p, "key");
      if (!("value" in p)) throw new CallError("invalid-params", '"value" is required');
      const value = frontmatterValue(p.value);
      return edit(ctx, path, (text) => setField(text, key, value));
    }
    case "files.removeField": {
      const path = entryParam(p, "path");
      const key = stringParam(p, "key");
      return edit(ctx, path, (text) => removeField(text, key));
    }
    case "files.move": {
      const from = entryParam(p, "from");
      const to = entryParam(p, "to");
      if (ws.kindOf(from) === null) throw new CallError("not-found", `${JSON.stringify(from)} does not exist`);
      if (from === to) return {};
      if (isUnder(to, from)) throw new CallError("invalid-params", `cannot move ${JSON.stringify(from)} into itself`);
      if (ws.kindOf(to) !== null) throw new CallError("already-exists", `${JSON.stringify(to)} already exists`);
      if (ancestorIsFile(ws, to)) throw new CallError("io-error", `ENOTDIR: a parent of ${JSON.stringify(to)} is a file`);
      ctx.emit(ws.rename(from, to));
      return {};
    }
  }
}

function ancestorIsFile(ws: Workspace, path: string): boolean {
  for (let dir = parentPath(path); dir !== ""; dir = parentPath(dir)) {
    if (ws.kindOf(dir) === "file") return true;
  }
  return false;
}

/** The tab methods of pomade:E-030. */
export type TabDataMethod = Extract<MethodName, "tabs.openFile" | "tabs.openTerminal" | "tabs.openApp">;

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
      ctx.projectSettings.set(id, merged);
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
      ctx.projectAgents.set(id, agents);
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

/** The folder picker of pomade:E-030. */
export type PickDataMethod = Extract<MethodName, "files.pickFolder">;

/** `files.pickFolder` against scripted answers: an answer that is not a folder inside the root is
 *  refused like Pomade's dialog refuses it (the picker asks again: the next answer). No answer
 *  left = the user cancelled. */
export function dispatchPick(ctx: DataContext, _method: PickDataMethod, p: Obj): unknown {
  const rootId = optionalString(p, "root");
  const root = rootId === undefined || rootId === WORKSPACE_PROJECT_ID ? "" : ctx.project(rootId).root;
  const wanted = p.initial === undefined ? root : pathParam(p, "initial");
  const initial = isInside(wanted, root) && ctx.workspace.kindOf(wanted) === "dir" ? wanted : root;
  ctx.pickRequests.push({ root, initial });
  for (;;) {
    const answer = ctx.pickAnswers.shift();
    if (answer === undefined || answer === null) return { path: null };
    if (isInside(answer, root) && ctx.workspace.kindOf(answer) === "dir" && ctx.workspace.isVisible(answer)) return { path: answer };
  }
}
