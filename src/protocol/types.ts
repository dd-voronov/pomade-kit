// Host API v0 — the data types and messages of Pomade's docs/HOST-API.md, transcribed.

/** The Host API version this kit speaks (HOST-API "Version"). */
export const HOST_API_VERSION = 0;

/** Every protocol message carries this channel; anything else is ignored by both sides. */
export const CHANNEL = "pomade";
export type Channel = typeof CHANNEL;

/** How long an app waits for `welcome` before it treats itself as standalone (HOST-API §3). */
export const HANDSHAKE_TIMEOUT_MS = 1500;

/** Where a frame lives: a main-area tab or the side panel. */
export type Surface = "tab" | "panel";

/** What a frame was opened for — carried by `welcome` and `host.info` (HOST-API §3). */
export interface FrameTarget {
  surface: Surface;
  /** The strip icon id the frame was opened for; absent for a tab opened from the new-tab menu. */
  icon?: string;
  /** The route the app renders on this surface; "" = the app's default view. */
  route: string;
}

/** What clicking a strip icon does: fill the side panel, open (or focus) a tab, or both. */
export type StripAction = "panel" | "tab" | "both";

export const STRIP_ACTIONS: readonly StripAction[] = ["panel", "tab", "both"];

/** One icon an app contributes to Pomade's left strip (manifest `strip[]`, HOST-API §1). */
export interface StripIcon {
  /** `STRIP_ICON_ID_RE`, unique within the app. */
  id: string;
  /** Tooltip, panel header, and the title of the tab it opens. Trimmed. */
  title: string;
  /** Path inside the build folder; falls back to the app's icon. */
  icon?: string;
  action: StripAction;
  /** The route of the surface(s) the icon opens; "" = the app's default view. */
  route: string;
  /** `both` only: the panel's route when it differs from the tab's (`route`). */
  panelRoute?: string;
}

/** `ProjectRef.id` of the Workspace scope (Pomade's pseudo-project). */
export const WORKSPACE_PROJECT_ID = "__workspace__";

export interface ProjectRef {
  /** Stable: survives project renames and moves. */
  id: string;
  kind: "project" | "workspace";
  /** "Workspace" for the workspace scope. */
  name: string;
  /** Workspace-relative; "" for the workspace scope. */
  root: string;
}

export interface FileEntry {
  /** Workspace-relative. */
  path: string;
  name: string;
  kind: "file" | "dir";
  /** Bytes; 0 for dirs. */
  size: number;
  mtimeMs: number;
  /** Only with `frontmatter: true`, only for Markdown files. `null` = no frontmatter block. */
  frontmatter?: Record<string, unknown> | null;
  /** The block exists but is not valid YAML (or the file is unreadable); the entry is still returned. */
  frontmatterError?: string;
}

export interface FileChange {
  kind: "create" | "change" | "delete" | "rename";
  /** Workspace-relative; the new path for a rename. */
  path: string;
  /** Rename only. */
  oldPath?: string;
}

export const ERROR_CODES = [
  "not-ready",
  "unknown-method",
  "capability-denied",
  "invalid-params",
  "outside-workspace",
  "not-found",
  "io-error",
  "already-exists",
  "unreadable-frontmatter",
  "unsupported-key",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export const CAPABILITIES = ["project.read", "files.read", "files.write", "tabs.open", "project.write", "files.symlink"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// ── Methods ─────────────────────────────────────────────────────────────────

/** `host.info` — the `welcome` values. */
export interface HostInfo extends FrameTarget {
  pomadeVersion: string;
  hostApi: number;
  appId: string;
}

export interface ReadFolderParams {
  path: string;
  recursive?: boolean;
  frontmatter?: boolean;
}

export interface ReadFolderResult {
  entries: FileEntry[];
}

export interface WatchParams {
  path: string;
  recursive?: boolean;
}

export interface WatchResult {
  watchId: string;
}

export interface UnwatchParams {
  watchId: string;
}

/** `strip.setBadge` — one of the app's own strip icons; `count` 0 clears the badge, `urgent` paints it red. */
export interface SetBadgeParams {
  icon: string;
  /** An integer ≥ 0. */
  count: number;
  urgent?: boolean;
}

// ── Workspace data: file writes (pomade:E-030) ─────────────────────────────

export interface ReadFileParams {
  path: string;
}

/** `files.readFile` — the file's text, decoded as UTF-8. */
export interface ReadFileResult {
  content: string;
  /** Bytes. */
  size: number;
  mtimeMs: number;
}

/** `files.create` — a new file; missing parent folders are created. Refused when the path exists. */
export interface CreateFileParams {
  path: string;
  /** Default `""`. */
  content?: string;
}

/** `files.write` — replace an existing file's whole text. */
export interface WriteFileParams {
  path: string;
  content: string;
}

/** `files.setBody` — replace everything after the frontmatter block; the block's bytes stay. */
export interface SetBodyParams {
  path: string;
  body: string;
}

/** A frontmatter value an app writes: text, a finite number, a boolean, a list of text, or `null` (`key:`). */
export type FrontmatterValue = string | number | boolean | null | string[];

/** `files.setField` — one frontmatter field; every other byte of the file stays. */
export interface SetFieldParams {
  path: string;
  key: string;
  value: FrontmatterValue;
}

/** `files.removeField` — remove one frontmatter field; every other byte of the file stays. */
export interface RemoveFieldParams {
  path: string;
  key: string;
}

/** Field and body writes: `changed: false` when the bytes were already identical (nothing is written). */
export interface EditResult {
  changed: boolean;
}

/** `files.move` — move or rename a file or folder; missing parent folders are created. Refused when `to` exists. */
export interface MoveParams {
  from: string;
  to: string;
}

// ── Workspace data: tabs (pomade:E-030) ────────────────────────────────────

/** `tabs.openFile` — open (or focus) a file in an editor tab. */
export interface OpenFileParams {
  /** A file, workspace-relative. */
  path: string;
  /** The project whose tab strip gets the tab; default the active project. Pomade switches to it. */
  projectId?: string;
}

/** `tabs.openTerminal` — open a terminal tab in a folder, optionally running a command. */
export interface OpenTerminalParams {
  /** A folder, workspace-relative; `""` = the workspace root. */
  cwd: string;
  /** Typed into the shell once it is ready, then run; one line. */
  command?: string;
  /** The tab's title; default the command, else the shell's own title. */
  title?: string;
  /** The project whose tab strip gets the tab; default the active project. Pomade switches to it. */
  projectId?: string;
}

// ── Workspace data: projects (pomade:E-030) ────────────────────────────────

/** A sidebar group (groups nest). */
export interface GroupInfo {
  /** Stable: survives renames and moves. */
  id: string;
  name: string;
  /** The containing group; `null` for a top-level group. */
  parentId: string | null;
  /** Group names from the top level down to this group, e.g. `["Building tools", "Tools"]`. */
  path: string[];
}

/** A project in the sidebar's tree. */
export interface ProjectInfo extends ProjectRef {
  kind: "project";
  /** The project's group; `null` when ungrouped. */
  groupId: string | null;
  /** Group names from the top level down to the project's group; `[]` when ungrouped. */
  groupPath: string[];
}

/** `project.list` — groups and projects in sidebar order (a group, then its projects, then its sub-groups). */
export interface ProjectListResult {
  /** The Workspace scope (Pomade's pseudo-project at the top of the sidebar). */
  workspace: ProjectRef;
  groups: GroupInfo[];
  projects: ProjectInfo[];
}

/** A plain JSON value (finite numbers only). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The most an app may store per project, as UTF-8 JSON (`project.setSettings`). */
export const PROJECT_SETTINGS_MAX_BYTES = 65536;

/** `project.getSettings` / `project.getAgents` — one project; `"__workspace__"` is not a project. */
export interface ProjectIdParams {
  projectId: string;
}

/** The calling app's own settings for one project. */
export interface ProjectSettingsResult {
  settings: Record<string, JsonValue>;
}

/** `project.setSettings` — merge into the app's settings for the project; a `null` value removes the key. */
export interface SetProjectSettingsParams {
  projectId: string;
  settings: Record<string, JsonValue>;
}

/** The agents shown in the project's "+" menu: roster ids, or `["*"]` for every agent. */
export interface ProjectAgentsResult {
  visibleAgents: string[];
}

/** `project.setAgents` — replace the project's visible agents (`["*"]` = every agent). */
export interface SetProjectAgentsParams {
  projectId: string;
  visibleAgents: string[];
}

// ── Workspace data: scoped symlinks (pomade:E-030) ─────────────────────────

/** `files.symlink` — create a symlink at `path` pointing to `target`, inside a manifest `symlinks` folder. */
export interface SymlinkParams {
  /** The link, workspace-relative; its folder must match one of the manifest's `symlinks` patterns. */
  path: string;
  /** What it points to: an existing workspace-relative path. The link is written relative. */
  target: string;
}

/** `files.removeSymlink` — remove the symlink at `path` (never what it points to). */
export interface RemoveSymlinkParams {
  path: string;
}

// ── Workspace data: folder picker (pomade:E-030) ───────────────────────────

/** `files.pickFolder` — ask the user for a folder inside a root. */
export interface PickFolderParams {
  /** A project id whose folder bounds the choice; absent or `"__workspace__"` = the whole workspace. */
  root?: string;
  /** Where the picker starts, workspace-relative; default (and when outside the root) the root. */
  initial?: string;
}

/** The chosen folder, workspace-relative; `null` when the user cancelled. */
export interface PickFolderResult {
  path: string | null;
}

/** Method name → params and result. Methods without params take `{}`. */
export interface HostMethods {
  "host.info": { params: Record<string, never>; result: HostInfo };
  "project.getActive": { params: Record<string, never>; result: ProjectRef };
  "files.readFolder": { params: ReadFolderParams; result: ReadFolderResult };
  "files.watch": { params: WatchParams; result: WatchResult };
  "files.unwatch": { params: UnwatchParams; result: Record<string, never> };
  "strip.setBadge": { params: SetBadgeParams; result: Record<string, never> };
  "files.readFile": { params: ReadFileParams; result: ReadFileResult };
  "files.create": { params: CreateFileParams; result: Record<string, never> };
  "files.write": { params: WriteFileParams; result: Record<string, never> };
  "files.setBody": { params: SetBodyParams; result: EditResult };
  "files.setField": { params: SetFieldParams; result: EditResult };
  "files.removeField": { params: RemoveFieldParams; result: EditResult };
  "files.move": { params: MoveParams; result: Record<string, never> };
  "tabs.openFile": { params: OpenFileParams; result: Record<string, never> };
  "tabs.openTerminal": { params: OpenTerminalParams; result: Record<string, never> };
  "project.list": { params: Record<string, never>; result: ProjectListResult };
  "project.getSettings": { params: ProjectIdParams; result: ProjectSettingsResult };
  "project.setSettings": { params: SetProjectSettingsParams; result: ProjectSettingsResult };
  "project.getAgents": { params: ProjectIdParams; result: ProjectAgentsResult };
  "project.setAgents": { params: SetProjectAgentsParams; result: Record<string, never> };
  "files.symlink": { params: SymlinkParams; result: Record<string, never> };
  "files.removeSymlink": { params: RemoveSymlinkParams; result: Record<string, never> };
  "files.pickFolder": { params: PickFolderParams; result: PickFolderResult };
}
export type MethodName = keyof HostMethods;
export type MethodParams<M extends MethodName> = HostMethods[M]["params"];
export type MethodResult<M extends MethodName> = HostMethods[M]["result"];

/** The capability each method needs; `null` = no capability (HOST-API §4). */
export const METHOD_CAPABILITY: Readonly<Record<MethodName, Capability | null>> = {
  "host.info": null,
  "project.getActive": "project.read",
  "files.readFolder": "files.read",
  "files.watch": "files.read",
  "files.unwatch": "files.read",
  "strip.setBadge": null,
  "files.readFile": "files.read",
  "files.create": "files.write",
  "files.write": "files.write",
  "files.setBody": "files.write",
  "files.setField": "files.write",
  "files.removeField": "files.write",
  "files.move": "files.write",
  "tabs.openFile": "tabs.open",
  "tabs.openTerminal": "tabs.open",
  "project.list": "project.read",
  "project.getSettings": "project.read",
  "project.setSettings": "project.write",
  "project.getAgents": "project.read",
  "project.setAgents": "project.write",
  "files.symlink": "files.symlink",
  "files.removeSymlink": "files.symlink",
  "files.pickFolder": "files.read",
};

export const METHOD_NAMES = Object.keys(METHOD_CAPABILITY) as MethodName[];

// ── Events ──────────────────────────────────────────────────────────────────

export interface FilesChangedPayload {
  watchId: string;
  changes: FileChange[];
}

/** Event name → payload. */
export interface HostEvents {
  "project.changed": ProjectRef;
  "files.changed": FilesChangedPayload;
}
export type EventName = keyof HostEvents;

// ── Messages ────────────────────────────────────────────────────────────────

export interface HelloMessage {
  channel: Channel;
  type: "hello";
  hostApi: number;
}

export interface WelcomeMessage extends FrameTarget {
  channel: Channel;
  type: "welcome";
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  project: ProjectRef;
}

export type RejectReason = "needs-newer-pomade" | "app-too-old";

export interface RejectMessage {
  channel: Channel;
  type: "reject";
  reason: RejectReason;
  /** What this Pomade speaks. */
  hostApi: number;
}

export interface CallMessage<M extends MethodName = MethodName> {
  channel: Channel;
  type: "call";
  /** Unique per frame, chosen by the app. */
  id: string;
  method: M;
  params: MethodParams<M>;
}

export type ResultMessage =
  | { channel: Channel; type: "result"; id: string; ok: true; value: unknown }
  | { channel: Channel; type: "result"; id: string; ok: false; error: ErrorPayload };

export type EventMessage = {
  [E in EventName]: { channel: Channel; type: "event"; name: E; payload: HostEvents[E] };
}[EventName];

export interface KeyMessage {
  channel: Channel;
  type: "key";
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type AppToHostMessage = HelloMessage | CallMessage | KeyMessage;
export type HostToAppMessage = WelcomeMessage | RejectMessage | ResultMessage | EventMessage;
