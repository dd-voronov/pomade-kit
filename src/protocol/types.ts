// Host API v0 — the data types and messages of Pomade's docs/HOST-API.md, transcribed.

/** The Host API version this kit speaks (HOST-API "Version"). */
export const HOST_API_VERSION = 0;

/** Every protocol message carries this channel; anything else is ignored by both sides. */
export const CHANNEL = "pomade";
export type Channel = typeof CHANNEL;

/** How long an app waits for `welcome` before it treats itself as standalone (HOST-API §3). */
export const HANDSHAKE_TIMEOUT_MS = 1500;

export type Surface = "tab";

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
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export const CAPABILITIES = ["project.read", "files.read"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// ── Methods ─────────────────────────────────────────────────────────────────

export interface HostInfo {
  pomadeVersion: string;
  hostApi: number;
  appId: string;
  surface: Surface;
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

/** Method name → params and result. Methods without params take `{}`. */
export interface HostMethods {
  "host.info": { params: Record<string, never>; result: HostInfo };
  "project.getActive": { params: Record<string, never>; result: ProjectRef };
  "files.readFolder": { params: ReadFolderParams; result: ReadFolderResult };
  "files.watch": { params: WatchParams; result: WatchResult };
  "files.unwatch": { params: UnwatchParams; result: Record<string, never> };
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

export interface WelcomeMessage {
  channel: Channel;
  type: "welcome";
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  surface: Surface;
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
