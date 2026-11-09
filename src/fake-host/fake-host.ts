// The fake host: the whole Host API v0 in memory, speaking the same messages as Pomade, so an
// app runs unchanged against it — in-process (unit tests, `dev:fake`) or as the parent window
// of the app's frame (browser e2e).

import {
  CHANNEL,
  CAPABILITIES,
  HOST_API_VERSION,
  METHOD_CAPABILITY,
  WORKSPACE_PROJECT_ID,
  normalizeWorkspacePath,
  parseAppMessage,
  parseManifest,
  type ErrorCode,
  type FileChange,
  type HostToAppMessage,
  type IncomingCall,
  type KeyMessage,
  type Manifest,
  type MethodName,
  type ProjectRef,
} from "../protocol/index.js";
import type { Transport } from "../sdk/transport.js";
import { controlPath, Workspace } from "./workspace.js";

/** Pomade's default tree ignore list. */
export const DEFAULT_IGNORE: readonly string[] = [".git", "node_modules", ".DS_Store"];

/** The scope `project.getActive` reports when no project is active. */
export const WORKSPACE_SCOPE: Readonly<ProjectRef> = {
  id: WORKSPACE_PROJECT_ID,
  kind: "workspace",
  name: "Workspace",
  root: "",
};

export interface FakeProject {
  id: string;
  name: string;
  /** Workspace-relative. */
  root: string;
}

export interface FakeHostOptions {
  /** Workspace files, path → content. Folders are created as needed. */
  files?: Record<string, string>;
  projects?: FakeProject[];
  /** The active project's id; `null`/absent = the Workspace scope. */
  activeProject?: string | null;
  /** The app's manifest (parsed `manifest.json`); it sets the app id and the granted capabilities. Default: an app with every capability. */
  manifest?: unknown;
  /** Default "0.0.0-fake". */
  pomadeVersion?: string;
  /** The Host API version this host speaks. Default `HOST_API_VERSION`. */
  hostApi?: number;
  /** Entry names hidden from `readFolder` and watches. Default Pomade's tree ignore list. */
  ignore?: readonly string[];
  /** Clock for `mtimeMs`. Default `Date.now`. */
  now?: () => number;
}

/** One app frame attached to the host. */
export interface FrameConnection {
  /** Hand the host a message the frame sent. */
  receive(data: unknown): void;
  /** The frame is gone: drop its watches, stop sending to it. */
  detach(): void;
}

class CallError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Watch {
  path: string;
  recursive: boolean;
}

interface Frame {
  post(message: HostToAppMessage): void;
  welcomed: boolean;
  watches: Map<string, Watch>;
}

type Obj = Record<string, unknown>;

function paramsObject(params: unknown): Obj {
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new CallError("invalid-params", "params must be an object");
  }
  return params as Obj;
}

function stringParam(p: Obj, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new CallError("invalid-params", `"${key}" must be a string`);
  return v;
}

function booleanParam(p: Obj, key: string): boolean {
  const v = p[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new CallError("invalid-params", `"${key}" must be a boolean`);
  return v;
}

function isMethod(name: string): name is MethodName {
  return Object.hasOwn(METHOD_CAPABILITY, name);
}

export class FakeHost {
  readonly manifest: Manifest;
  readonly pomadeVersion: string;
  readonly hostApi: number;
  /** Every `key` message received, in order. */
  readonly keys: KeyMessage[] = [];

  private readonly workspace: Workspace;
  private readonly projects: ProjectRef[];
  private active: ProjectRef;
  private readonly frames = new Set<Frame>();
  private nextWatchId = 1;
  private batched: FileChange[] | null = null;
  private defaultTransport: Transport | null = null;

  constructor(options: FakeHostOptions = {}) {
    const parsed = parseManifest(
      options.manifest ?? { id: "fake-app", name: "Fake app", version: "0.0.0", hostApi: HOST_API_VERSION, capabilities: [...CAPABILITIES] },
    );
    if (!parsed.ok) throw new Error(`fake host: invalid manifest: ${parsed.message}`);
    this.manifest = parsed.manifest;
    this.pomadeVersion = options.pomadeVersion ?? "0.0.0-fake";
    this.hostApi = options.hostApi ?? HOST_API_VERSION;
    this.workspace = new Workspace(options.files ?? {}, options.ignore ?? DEFAULT_IGNORE, options.now ?? Date.now);
    this.projects = (options.projects ?? []).map((p) => ({ id: p.id, kind: "project", name: p.name, root: controlPath(p.root) }));
    this.active = this.findScope(options.activeProject ?? null);
  }

  // ── Frames and transports ────────────────────────────────────────────────

  /** Attach a frame; `post` delivers host → app messages to it. */
  attach(post: (message: HostToAppMessage) => void): FrameConnection {
    const frame: Frame = { post, welcomed: false, watches: new Map() };
    this.frames.add(frame);
    return {
      receive: (data) => {
        if (this.frames.has(frame)) this.handle(frame, data);
      },
      detach: () => {
        this.frames.delete(frame);
        frame.watches.clear();
      },
    };
  }

  /** A new in-memory frame: pass it to `connect({ transport })`. Messages are cloned and delivered asynchronously, like postMessage. */
  createTransport(): Transport {
    const listeners = new Set<(data: unknown) => void>();
    const frame = this.attach((message) => {
      const copy = structuredClone(message);
      setTimeout(() => {
        for (const listener of [...listeners]) listener(copy);
      }, 0);
    });
    return {
      send(message) {
        const copy = structuredClone(message);
        setTimeout(() => frame.receive(copy), 0);
      },
      listen(onMessage) {
        listeners.add(onMessage);
        return () => listeners.delete(onMessage);
      },
    };
  }

  /** The default in-memory frame. */
  get transport(): Transport {
    this.defaultTransport ??= this.createTransport();
    return this.defaultTransport;
  }

  // ── Test controls ────────────────────────────────────────────────────────

  /** Create or overwrite a file; emits `create` (with any new parent folders) or `change`. */
  writeFile(path: string, content: string): void {
    this.emit(this.workspace.writeFile(controlPath(path), content));
  }

  /** Delete a file; emits `delete`. */
  deleteFile(path: string): void {
    this.emit(this.workspace.deleteFile(controlPath(path)));
  }

  /** Move a file or folder; emits `rename` (with any new parent folders). */
  rename(from: string, to: string): void {
    this.emit(this.workspace.rename(controlPath(from), controlPath(to)));
  }

  /** Switch the active project (`null` = Workspace); emits `project.changed` when it changes. */
  setActiveProject(id: string | null): void {
    const next = this.findScope(id);
    if (next.id === this.active.id) return;
    this.active = next;
    for (const frame of this.frames) {
      if (frame.welcomed) frame.post({ channel: CHANNEL, type: "event", name: "project.changed", payload: { ...next } });
    }
  }

  /** Run several controls and deliver their file changes as one `files.changed` batch per watch. */
  batch(run: () => void): void {
    if (this.batched) {
      run();
      return;
    }
    this.batched = [];
    try {
      run();
    } finally {
      const changes = this.batched;
      this.batched = null;
      this.emit(changes);
    }
  }

  get activeProject(): ProjectRef {
    return { ...this.active };
  }

  // ── Protocol ─────────────────────────────────────────────────────────────

  private findScope(id: string | null): ProjectRef {
    if (id === null) return { ...WORKSPACE_SCOPE };
    const project = this.projects.find((p) => p.id === id);
    if (!project) throw new Error(`fake host: no project ${JSON.stringify(id)}`);
    return { ...project };
  }

  private handle(frame: Frame, data: unknown): void {
    const msg = parseAppMessage(data);
    if (!msg) return;
    switch (msg.type) {
      case "hello":
        this.handshake(frame, msg.hostApi);
        return;
      case "key":
        this.keys.push(msg);
        return;
      case "call":
        this.answer(frame, msg);
        return;
    }
  }

  private handshake(frame: Frame, appHostApi: number): void {
    frame.watches.clear();
    frame.welcomed = false;
    if (appHostApi !== this.hostApi) {
      const reason = appHostApi > this.hostApi ? "needs-newer-pomade" : "app-too-old";
      frame.post({ channel: CHANNEL, type: "reject", reason, hostApi: this.hostApi });
      return;
    }
    frame.welcomed = true;
    frame.post({
      channel: CHANNEL,
      type: "welcome",
      hostApi: this.hostApi,
      pomadeVersion: this.pomadeVersion,
      appId: this.manifest.id,
      surface: "tab",
      project: { ...this.active },
    });
  }

  private answer(frame: Frame, call: IncomingCall): void {
    try {
      const value = this.dispatch(frame, call);
      frame.post({ channel: CHANNEL, type: "result", id: call.id, ok: true, value });
    } catch (err) {
      if (!(err instanceof CallError)) throw err;
      frame.post({ channel: CHANNEL, type: "result", id: call.id, ok: false, error: { code: err.code, message: err.message } });
    }
  }

  private dispatch(frame: Frame, call: IncomingCall): unknown {
    if (!frame.welcomed) throw new CallError("not-ready", "call before welcome");
    const { method } = call;
    if (!isMethod(method)) throw new CallError("unknown-method", `no method ${JSON.stringify(method)} in Host API v${this.hostApi}`);
    const capability = METHOD_CAPABILITY[method];
    if (capability && !this.manifest.capabilities.includes(capability)) {
      throw new CallError("capability-denied", `${method} needs the "${capability}" capability`);
    }
    const params = paramsObject(call.params);
    switch (method) {
      case "host.info":
        return { pomadeVersion: this.pomadeVersion, hostApi: this.hostApi, appId: this.manifest.id, surface: "tab" };
      case "project.getActive":
        return { ...this.active };
      case "files.readFolder": {
        const path = stringParam(params, "path");
        const recursive = booleanParam(params, "recursive");
        const frontmatter = booleanParam(params, "frontmatter");
        const folder = this.existing(path);
        if (this.workspace.kindOf(folder) !== "dir") throw new CallError("io-error", `ENOTDIR: not a directory, scandir '${folder}'`);
        return { entries: this.workspace.list(folder, recursive, frontmatter) };
      }
      case "files.watch": {
        const path = stringParam(params, "path");
        const recursive = booleanParam(params, "recursive");
        const watchId = `w${this.nextWatchId++}`;
        frame.watches.set(watchId, { path: this.existing(path), recursive });
        return { watchId };
      }
      case "files.unwatch":
        frame.watches.delete(stringParam(params, "watchId"));
        return {};
    }
  }

  /** Normalize a request path and require it to exist. */
  private existing(path: string): string {
    const n = normalizeWorkspacePath(path);
    if (!n.ok) throw new CallError("outside-workspace", `${JSON.stringify(path)} is outside the workspace`);
    if (this.workspace.kindOf(n.path) === null) throw new CallError("not-found", `${JSON.stringify(path)} does not exist`);
    return n.path;
  }

  private emit(changes: FileChange[]): void {
    if (this.batched) {
      this.batched.push(...changes);
      return;
    }
    if (changes.length === 0) return;
    for (const frame of this.frames) {
      if (!frame.welcomed) continue;
      for (const [watchId, watch] of frame.watches) {
        const matching = changes.filter(
          (c) =>
            this.workspace.concerns(watch.path, watch.recursive, c.path) ||
            (c.oldPath !== undefined && this.workspace.concerns(watch.path, watch.recursive, c.oldPath)),
        );
        if (matching.length > 0) {
          frame.post({ channel: CHANNEL, type: "event", name: "files.changed", payload: { watchId, changes: matching.map((c) => ({ ...c })) } });
        }
      }
    }
  }
}

/** Create a fake host. */
export function createFakeHost(options?: FakeHostOptions): FakeHost {
  return new FakeHost(options);
}
