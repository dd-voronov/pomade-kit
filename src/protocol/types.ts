// Host API v0 — the data types and messages of Pomade's docs/HOST-API.md, transcribed.

import type { GitChangedPayload, GitStateParams, GitStateResult } from "./git.js";
import type {
  AgentTabExitedPayload,
  HasSubscribersParams,
  HasSubscribersResult,
  ProjectRenamedPayload,
  ProjectUpdatedPayload,
  PublishParams,
  SubscribeParams,
  SubscribersChangedPayload,
} from "./events.js";
import type { NoticeParams } from "./notices.js";
import type { AttachedTabActionPayload, SessionRef } from "./attach.js";
import type {
  AgentTabChangedPayload,
  AgentTabsFocusParams,
  AgentTabsLaunchParams,
  AgentTabsListParams,
  AgentTabsListResult,
  AgentTabsOpenResult,
  AgentTabsResumeParams,
  AgentTabsSetTitleParams,
} from "./agent-tabs.js";

/** The Host API version this kit speaks (HOST-API "Version"). */
export const HOST_API_VERSION = 0;

/** Every protocol message carries this channel; anything else is ignored by both sides. */
export const CHANNEL = "pomade";
export type Channel = typeof CHANNEL;

/** How long an app waits for `welcome` before it treats itself as standalone (HOST-API §3). */
export const HANDSHAKE_TIMEOUT_MS = 1500;

/** Where a client lives: a frame in a main-area tab, the side panel, or the overlay a shortcut
 *  opens — or, over the local socket (pomade:E-028), the app's backend or one of its commands. */
export type Surface = "tab" | "panel" | "overlay" | ClientRole;

/** What an app's socket client is (HOST-API §3 "Socket"): its backend process or one of its commands. */
export type ClientRole = "backend" | "command";

export const CLIENT_ROLES: readonly ClientRole[] = ["backend", "command"];

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

/** What an app shortcut does when pressed: open or focus the app's tab at the shortcut's route,
 *  or open the app's overlay frame at it. */
export type ShortcutAction = "tab" | "overlay";

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["tab", "overlay"];

/** One Pomade-wide shortcut an app declares (manifest `shortcuts[]`, HOST-API §1). */
export interface AppShortcut {
  /** `SHORTCUT_ID_RE`, unique within the app. */
  id: string;
  /** What it does, for people: shown in the install summary. Trimmed. */
  title: string;
  /** The chord in its canonical spelling (`formatChord`): `Cmd+Shift+K`. */
  key: string;
  action: ShortcutAction;
  /** The route the opened surface renders; "" = the app's default view. */
  route: string;
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
  "app-absent",
  "app-not-responding",
  "app-error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export const CAPABILITIES = [
  "project.read",
  "files.read",
  "files.write",
  "tabs.open",
  "project.write",
  "files.symlink",
  "git.read",
  "agentTabs.read",
  "agentTabs.write",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// ── Methods ─────────────────────────────────────────────────────────────────

/** `host.info` — the `welcome` values, and where the app's shipped skills are. */
export interface HostInfo extends FrameTarget {
  pomadeVersion: string;
  hostApi: number;
  appId: string;
  /** Each manifest `skills` folder: its name and the absolute path of the folder in the installed
   *  (or dev-linked) build; `path: null` for a dev-server link (no local folder). `[]` when none. */
  skills: SkillLocation[];
}

/** Where one shipped skill is (`host.info`). */
export interface SkillLocation {
  name: string;
  path: string | null;
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

/** `files.delete` — move files to the Trash (macOS), each path on its own; a folder is refused. At most `FILES_DELETE_MAX_PATHS` paths. */
export interface DeleteFilesParams {
  /** Workspace-relative files. */
  paths: string[];
}

/** One path of a `files.delete` call: `ok: false` carries why that file stayed (`not-found`, `invalid-params` for a folder, …). */
export interface DeleteFileResult {
  /** The path as the app passed it. */
  path: string;
  ok: boolean;
  error?: ErrorPayload;
}

/** `files.delete` — one result per path, in the order given. */
export interface DeleteFilesResult {
  results: DeleteFileResult[];
}

/** The most paths one `files.delete` call takes. */
export const FILES_DELETE_MAX_PATHS = 1000;

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

/** `tabs.openAttached` — open (or focus) a terminal tab attached to a session an app's keeper
 *  holds (pomade:E-034). Any app may open any app's session by reference; the owner is not called. */
export interface OpenAttachedParams {
  /** The session: the app whose keeper holds it, and its id there. */
  session: SessionRef;
  /** The tab's title; default the session's own title from its keeper. */
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

// ── App state, own tab, overlay (pomade:E-027) ─────────────────────────────

/** `state.get` — one key of the app's machine-local state. */
export interface StateGetParams {
  key: string;
}

/** `null` = the key is not set. */
export interface StateGetResult {
  value: JsonValue | null;
}

/** `state.set` — `value: null` removes the key. */
export interface StateSetParams {
  key: string;
  value: JsonValue;
}

/** `tabs.openApp` — open or focus the calling app's tab at a route. */
export interface OpenAppParams {
  /** What the tab renders; default "" (the app's default view). */
  route?: string;
  /** The project whose tab strip gets the tab (a `ProjectRef.id`, the Workspace scope included); default the active project. Pomade switches to it. */
  projectId?: string;
}

/** Where an overlay opens when the user has not moved it: `"center"` of the pane area, or
 *  `"panel"` — beside the side panel. */
export type OverlayAnchor = "center" | "panel";

export const OVERLAY_ANCHORS: readonly OverlayAnchor[] = ["center", "panel"];

/** `overlay.open` — open the calling app's overlay frame at a route, from a visible tab or panel frame. */
export interface OpenOverlayParams {
  /** What the overlay renders; default "". */
  route?: string;
  /** The frame's height in px, a positive number; Pomade rounds it and clamps it to its limits (at most 60% of the
   *  pane area). Default 220. The width is always 420. */
  height?: number;
  /** Where it opens; default `"center"`. A position the user left it at wins over the anchor. */
  anchor?: OverlayAnchor;
}

/** `overlay.resize` — the overlay frame asks for a new height; same rules as `OpenOverlayParams.height`. */
export interface ResizeOverlayParams {
  height: number;
}

// ── Broker (pomade:E-028) ──────────────────────────────────────────────────

/** `apps.call` — call a method another app (or this app's own backend) offers through Pomade. */
export interface AppsCallParams {
  /** The app whose API to call. */
  app: string;
  /** One of the methods its manifest's `api` declares. */
  method: string;
  /** Plain JSON; default `{}`. */
  params?: JsonValue;
  /** How long to wait for the answer: 100–60000 ms, default 5000; then `app-not-responding`. */
  timeoutMs?: number;
}

/** `api.serve` — this client serves the app's API from now on. */
export interface ApiServeResult {
  /** The methods the manifest's `api` declares. */
  methods: string[];
}

// ── Platform (pomade:E-028) ────────────────────────────────────────────────

/** A method only Pomade's own commands may call (`PLATFORM_CLIENT_ID`); no manifest can declare it. */
export const PLATFORM_CAPABILITY = "platform";
export type MethodCapability = Capability | typeof PLATFORM_CAPABILITY | null;

/** `agents.liveIn` — is an agent running in a Pomade terminal inside this folder? */
export interface AgentsLiveInParams {
  /** An absolute folder (a repo root). */
  folder: string;
}

export interface AgentsLiveInResult {
  live: boolean;
  /** Each agent running with its working directory at or below `folder`. */
  agents: { agentId: string; cwd: string }[];
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
  "files.delete": { params: DeleteFilesParams; result: DeleteFilesResult };
  "tabs.openFile": { params: OpenFileParams; result: Record<string, never> };
  "tabs.openTerminal": { params: OpenTerminalParams; result: Record<string, never> };
  "tabs.openAttached": { params: OpenAttachedParams; result: Record<string, never> };
  "project.list": { params: Record<string, never>; result: ProjectListResult };
  "project.getSettings": { params: ProjectIdParams; result: ProjectSettingsResult };
  "project.setSettings": { params: SetProjectSettingsParams; result: ProjectSettingsResult };
  "project.getAgents": { params: ProjectIdParams; result: ProjectAgentsResult };
  "project.setAgents": { params: SetProjectAgentsParams; result: Record<string, never> };
  "files.symlink": { params: SymlinkParams; result: Record<string, never> };
  "files.removeSymlink": { params: RemoveSymlinkParams; result: Record<string, never> };
  "files.pickFolder": { params: PickFolderParams; result: PickFolderResult };
  "state.get": { params: StateGetParams; result: StateGetResult };
  "state.set": { params: StateSetParams; result: Record<string, never> };
  "tabs.openApp": { params: OpenAppParams; result: Record<string, never> };
  "overlay.open": { params: OpenOverlayParams; result: Record<string, never> };
  "overlay.resize": { params: ResizeOverlayParams; result: Record<string, never> };
  "overlay.close": { params: Record<string, never>; result: Record<string, never> };
  "git.getState": { params: GitStateParams; result: GitStateResult };
  "git.watch": { params: GitStateParams; result: WatchResult };
  "git.unwatch": { params: UnwatchParams; result: Record<string, never> };
  "events.publish": { params: PublishParams; result: Record<string, never> };
  "events.subscribe": { params: SubscribeParams; result: Record<string, never> };
  "events.unsubscribe": { params: SubscribeParams; result: Record<string, never> };
  "events.hasSubscribers": { params: HasSubscribersParams; result: HasSubscribersResult };
  "notices.post": { params: NoticeParams; result: Record<string, never> };
  "apps.call": { params: AppsCallParams; result: JsonValue };
  "api.serve": { params: Record<string, never>; result: ApiServeResult };
  "agents.liveIn": { params: AgentsLiveInParams; result: AgentsLiveInResult };
  "agentTabs.list": { params: AgentTabsListParams; result: AgentTabsListResult };
  "agentTabs.setTitle": { params: AgentTabsSetTitleParams; result: Record<string, never> };
  "agentTabs.focus": { params: AgentTabsFocusParams; result: Record<string, never> };
  "agentTabs.launch": { params: AgentTabsLaunchParams; result: AgentTabsOpenResult };
  "agentTabs.resume": { params: AgentTabsResumeParams; result: AgentTabsOpenResult };
}
export type MethodName = keyof HostMethods;
export type MethodParams<M extends MethodName> = HostMethods[M]["params"];
export type MethodResult<M extends MethodName> = HostMethods[M]["result"];

/** The capability each method needs; `null` = no capability (HOST-API §4). */
export const METHOD_CAPABILITY: Readonly<Record<MethodName, MethodCapability>> = {
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
  "files.delete": "files.write",
  "tabs.openFile": "tabs.open",
  "tabs.openTerminal": "tabs.open",
  "tabs.openAttached": "tabs.open",
  "project.list": "project.read",
  "project.getSettings": "project.read",
  "project.setSettings": "project.write",
  "project.getAgents": "project.read",
  "project.setAgents": "project.write",
  "files.symlink": "files.symlink",
  "files.removeSymlink": "files.symlink",
  "files.pickFolder": "files.read",
  "state.get": null,
  "state.set": null,
  "tabs.openApp": null,
  "overlay.open": null,
  "overlay.resize": null,
  "overlay.close": null,
  "git.getState": "git.read",
  "git.watch": "git.read",
  "git.unwatch": "git.read",
  "events.publish": null,
  "events.subscribe": null,
  "events.unsubscribe": null,
  "events.hasSubscribers": null,
  "notices.post": null,
  "apps.call": null,
  "api.serve": null,
  "agents.liveIn": PLATFORM_CAPABILITY,
  "agentTabs.list": "agentTabs.read",
  "agentTabs.setTitle": "agentTabs.write",
  "agentTabs.focus": "tabs.open",
  "agentTabs.launch": "tabs.open",
  "agentTabs.resume": "tabs.open",
};

export const METHOD_NAMES = Object.keys(METHOD_CAPABILITY) as MethodName[];

// ── Events ──────────────────────────────────────────────────────────────────

export interface FilesChangedPayload {
  watchId: string;
  changes: FileChange[];
}

/** `state.changed` — another frame of the same app set a key (`value: null` = removed). */
export interface StateChangedPayload {
  key: string;
  value: JsonValue | null;
}

/** `route.changed` — Pomade navigated this frame's tab to a new route (`tabs.openApp`, a shortcut). */
export interface RouteChangedPayload {
  route: string;
}

/** Event name → payload. */
export interface HostEvents {
  "project.changed": ProjectRef;
  "files.changed": FilesChangedPayload;
  "state.changed": StateChangedPayload;
  "route.changed": RouteChangedPayload;
  "git.changed": GitChangedPayload;
  // The event bus (pomade:E-031): platform events a frame subscribed to, and the publisher's news.
  "pomade.ready": Record<string, never>;
  "project.created": ProjectRef;
  "project.renamed": ProjectRenamedPayload;
  "project.opened": ProjectRef;
  "project.updated": ProjectUpdatedPayload;
  "agentTab.exited": AgentTabExitedPayload;
  "agentTab.changed": AgentTabChangedPayload;
  "attachedTab.action": AttachedTabActionPayload;
  "events.subscribersChanged": SubscribersChangedPayload;
}
export type EventName = keyof HostEvents;

// ── Messages ────────────────────────────────────────────────────────────────

export interface HelloMessage {
  channel: Channel;
  type: "hello";
  hostApi: number;
  /** Socket only: who is calling. A frame never sends it (Pomade knows a frame by the frame itself). */
  client?: SocketClient;
}

/** The identity a socket client presents in `hello` (HOST-API §3 "Socket"). */
export interface SocketClient {
  /** The app's id, or `PLATFORM_CLIENT_ID` for one of Pomade's own commands. */
  appId: string;
  /** The app's key: the contents of the key file Pomade issued for it (`POMADE_APP_KEY_FILE`). */
  key: string;
  role: ClientRole;
}

export interface WelcomeMessage extends FrameTarget {
  channel: Channel;
  type: "welcome";
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  project: ProjectRef;
}

/** `unauthorized` — socket only: the app id, key or role is not one Pomade issued (HOST-API §3 "Socket"). */
export type RejectReason = "needs-newer-pomade" | "app-too-old" | "unauthorized";

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

/** Another app's event a frame subscribed to (`events.subscribe`): `<appId>:<event>`. */
export type AppEventName = `${string}:${string}`;

export interface AppEventMessage {
  channel: Channel;
  type: "event";
  name: AppEventName;
  payload: JsonValue;
}

export type EventMessage =
  | {
      [E in EventName]: { channel: Channel; type: "event"; name: E; payload: HostEvents[E] };
    }[EventName]
  | AppEventMessage;

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

/** host → app: another app's call to an API method this client serves (`api.serve`). */
export interface RequestMessage {
  channel: Channel;
  type: "request";
  /** Unique per connection, chosen by Pomade; the response names it. */
  id: string;
  /** The calling app's id (`"pomade"` for the platform). */
  from: string;
  method: string;
  params: JsonValue;
}

/** app → host: the answer to a `request`. */
export type ResponseMessage =
  | { channel: Channel; type: "response"; id: string; ok: true; value: JsonValue }
  | { channel: Channel; type: "response"; id: string; ok: false; error: ErrorPayload };

export type AppToHostMessage = HelloMessage | CallMessage | KeyMessage | ResponseMessage;
export type HostToAppMessage = WelcomeMessage | RejectMessage | ResultMessage | EventMessage | RequestMessage;
