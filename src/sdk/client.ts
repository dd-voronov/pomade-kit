// The typed Host API client an app gets from `connect()` once the host said `welcome`.

import {
  CHANNEL,
  parseHostMessage,
  type ErrorCode,
  type FileChange,
  type HostInfo,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ProjectRef,
  type ReadFolderParams,
  type ReadFolderResult,
  type SetBadgeParams,
  type FrameTarget,
  type JsonValue,
  type OpenAppParams,
  type WatchParams,
  type CreateFileParams,
  type EditResult,
  type MoveParams,
  type ReadFileParams,
  type ReadFileResult,
  type RemoveFieldParams,
  type SetBodyParams,
  type SetFieldParams,
  type WriteFileParams,
  type OpenFileParams,
  type OpenTerminalParams,
  type ProjectListResult,
  type ProjectAgentsResult,
  type ProjectIdParams,
  type ProjectSettingsResult,
  type SetProjectAgentsParams,
  type SetProjectSettingsParams,
  type RemoveSymlinkParams,
  type SymlinkParams,
  type PickFolderParams,
  type PickFolderResult,
} from "../protocol/index.js";
import type { Transport } from "./transport.js";

/** A call the host answered with an error. */
export class HostError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/** What the host said in `welcome`: versions, app id, what the frame was opened for (`surface`,
 *  `icon`, `route`) and the project it was opened in. */
export interface Welcome extends FrameTarget {
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  /** The project the frame was opened in. */
  project: ProjectRef;
}

export interface FileWatch {
  readonly watchId: string;
  /** Stop delivering changes (immediately) and unwatch on the host. Idempotent. */
  close(): Promise<void>;
}

export interface HostClient {
  readonly welcome: Welcome;
  info(): Promise<HostInfo>;
  readonly project: {
    getActive(): Promise<ProjectRef>;
    /** Called on every `project.changed`; returns an unsubscribe function. */
    onChange(callback: (project: ProjectRef) => void): () => void;
    /** Groups and projects in sidebar order, each project with its group path. */
    list(): Promise<ProjectListResult>;
    /** This app's own settings for a project (`{}` when none). */
    getSettings(params: ProjectIdParams): Promise<ProjectSettingsResult>;
    /** Merge into this app's settings for a project (`null` removes a key); returns the result. */
    setSettings(params: SetProjectSettingsParams): Promise<ProjectSettingsResult>;
    /** The agents shown in the project's "+" menu (`["*"]` = every agent). */
    getAgents(params: ProjectIdParams): Promise<ProjectAgentsResult>;
    /** Replace the project's visible agents. */
    setAgents(params: SetProjectAgentsParams): Promise<void>;
  };
  readonly files: {
    readFolder(params: ReadFolderParams): Promise<ReadFolderResult>;
    /** Resolves once the host accepted the watch; `onChanges` receives each batch. */
    watch(params: WatchParams, onChanges: (changes: FileChange[]) => void): Promise<FileWatch>;
    /** The file's text (UTF-8), size and mtime. */
    readFile(params: ReadFileParams): Promise<ReadFileResult>;
    /** A new file (parent folders created); `already-exists` when the path exists. */
    create(params: CreateFileParams): Promise<void>;
    /** Replace an existing file's whole text. */
    write(params: WriteFileParams): Promise<void>;
    /** Replace the body after the frontmatter block; the block's bytes stay. */
    setBody(params: SetBodyParams): Promise<EditResult>;
    /** Set one frontmatter field; every other byte of the file stays. */
    setField(params: SetFieldParams): Promise<EditResult>;
    /** Remove one frontmatter field; every other byte of the file stays. */
    removeField(params: RemoveFieldParams): Promise<EditResult>;
    /** Move or rename a file or folder (parent folders created); `already-exists` when `to` exists. */
    move(params: MoveParams): Promise<void>;
    /** Create a relative symlink inside a manifest `symlinks` folder. */
    symlink(params: SymlinkParams): Promise<void>;
    /** Remove a symlink inside a manifest `symlinks` folder (never its target). */
    removeSymlink(params: RemoveSymlinkParams): Promise<void>;
    /** Ask the user for a folder inside a project (or the workspace); `path: null` = cancelled. */
    pickFolder(params?: PickFolderParams): Promise<PickFolderResult>;
  };
  readonly strip: {
    /** Badge one of the app's own strip icons; `count: 0` clears it, `urgent: true` paints it red. */
    setBadge(params: SetBadgeParams): Promise<void>;
  };
  readonly tabs: {
    /** Open (or focus) a file in an editor tab, right of the active tab. */
    openFile(params: OpenFileParams): Promise<void>;
    /** Open a terminal tab in a folder, right of the active tab, optionally running a command. */
    openTerminal(params: OpenTerminalParams): Promise<void>;
    /** Open or focus this app's own tab at `route` (default ""), in `projectId` (default the active project). */
    openApp(params?: OpenAppParams): Promise<void>;
  };
  readonly state: {
    /** The value stored under `key`, or `null` when it is not set. Shared by all of the app's frames. */
    get<T extends JsonValue = JsonValue>(key: string): Promise<T | null>;
    /** Store `value` under `key` (`null` removes it); the app's other frames get `state.changed`. */
    set(key: string, value: JsonValue): Promise<void>;
    /** Called when another frame of the app sets a key; returns an unsubscribe function. */
    onChange(callback: (key: string, value: JsonValue | null) => void): () => void;
  };
  readonly overlay: {
    /** Close this overlay frame; focus returns where it was. Only for `welcome.surface === "overlay"`. */
    close(): Promise<void>;
  };
  /** Called with the new route when Pomade navigates this frame's tab (`welcome.route` is the first); returns an unsubscribe function. */
  onRouteChange(callback: (route: string) => void): () => void;
  /** Detach from the transport: no more events, pending calls reject. */
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** `onClose` runs once when the client is closed. */
export function createClient(transport: Transport, welcome: Welcome, onClose?: () => void): HostClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<string, Pending>();
  const watches = new Map<string, (changes: FileChange[]) => void>();
  const projectListeners = new Set<(project: ProjectRef) => void>();
  const stateListeners = new Set<(key: string, value: JsonValue | null) => void>();
  const routeListeners = new Set<(route: string) => void>();

  const unlisten = transport.listen((data) => {
    const msg = parseHostMessage(data);
    if (!msg) return;
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new HostError(msg.error.code, msg.error.message));
    } else if (msg.type === "event") {
      switch (msg.name) {
        case "project.changed":
          for (const cb of [...projectListeners]) cb(msg.payload);
          break;
        case "files.changed":
          watches.get(msg.payload.watchId)?.(msg.payload.changes);
          break;
        case "state.changed":
          for (const cb of [...stateListeners]) cb(msg.payload.key, msg.payload.value);
          break;
        case "route.changed":
          for (const cb of [...routeListeners]) cb(msg.payload.route);
          break;
      }
    }
  });

  // `onValue` runs synchronously when the result arrives, before any later message is handled.
  function call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    onValue?: (value: MethodResult<M>) => void,
  ): Promise<MethodResult<M>> {
    if (closed) return Promise.reject(new Error("pomade-kit: client is closed"));
    const id = String(nextId++);
    return new Promise<MethodResult<M>>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => {
          onValue?.(v as MethodResult<M>);
          resolve(v as MethodResult<M>);
        },
        reject,
      });
      transport.send({ channel: CHANNEL, type: "call", id, method, params });
    });
  }

  function dispose(): void {
    if (closed) return;
    closed = true;
    unlisten();
    onClose?.();
    watches.clear();
    projectListeners.clear();
    stateListeners.clear();
    routeListeners.clear();
    const error = new Error("pomade-kit: client is closed");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  }

  return {
    welcome,
    info: () => call("host.info", {}),
    project: {
      getActive: () => call("project.getActive", {}),
      onChange(callback) {
        projectListeners.add(callback);
        return () => projectListeners.delete(callback);
      },
      list: () => call("project.list", {}),
      getSettings: (params) => call("project.getSettings", params),
      setSettings: (params) => call("project.setSettings", params),
      getAgents: (params) => call("project.getAgents", params),
      async setAgents(params) {
        await call("project.setAgents", params);
      },
    },
    files: {
      readFolder: (params) => call("files.readFolder", params),
      async watch(params, onChanges) {
        const { watchId } = await call("files.watch", params, (v) => watches.set(v.watchId, onChanges));
        let unwatched: Promise<void> | null = null;
        return {
          watchId,
          close() {
            unwatched ??= (async () => {
              watches.delete(watchId);
              if (!closed) await call("files.unwatch", { watchId });
            })();
            return unwatched;
          },
        };
      },
      readFile: (params) => call("files.readFile", params),
      async create(params) {
        await call("files.create", params);
      },
      async write(params) {
        await call("files.write", params);
      },
      setBody: (params) => call("files.setBody", params),
      setField: (params) => call("files.setField", params),
      removeField: (params) => call("files.removeField", params),
      async move(params) {
        await call("files.move", params);
      },
      async symlink(params) {
        await call("files.symlink", params);
      },
      async removeSymlink(params) {
        await call("files.removeSymlink", params);
      },
      pickFolder: (params = {}) => call("files.pickFolder", params),
    },
    strip: {
      async setBadge(params) {
        await call("strip.setBadge", params);
      },
    },
    tabs: {
      async openFile(params) {
        await call("tabs.openFile", params);
      },
      async openTerminal(params) {
        await call("tabs.openTerminal", params);
      },
      async openApp(params = {}) {
        await call("tabs.openApp", params);
      },
    },
    state: {
      async get<T extends JsonValue = JsonValue>(key: string) {
        const { value } = await call("state.get", { key });
        return value as T | null;
      },
      async set(key, value) {
        await call("state.set", { key, value });
      },
      onChange(callback) {
        stateListeners.add(callback);
        return () => stateListeners.delete(callback);
      },
    },
    overlay: {
      async close() {
        await call("overlay.close", {});
      },
    },
    onRouteChange(callback) {
      routeListeners.add(callback);
      return () => routeListeners.delete(callback);
    },
    close: dispose,
  };
}
