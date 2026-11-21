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
  type Theme,
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
  type DeleteFileResult,
  type OpenOverlayParams,
  type ResizeOverlayParams,
  type ReadFileParams,
  type ReadFileResult,
  type RemoveFieldParams,
  type SetKeyLinesParams,
  type SetBodyParams,
  type SetFieldParams,
  type WriteFileParams,
  type OpenFileParams,
  type RevealParams,
  type OpenTerminalParams,
  type OpenAttachedParams,
  type ProjectListResult,
  type ProjectAgentsResult,
  type ProjectIdParams,
  type ProjectSettingsResult,
  type SetProjectAgentsParams,
  type SetProjectSettingsParams,
  type RemoveSymlinkParams,
  type SymlinkParams,
  type PickFileParams,
  type PickFileResult,
  type PickFolderParams,
  type PickFolderResult,
  type GitRepoState,
  type GitStateParams,
  type GitStateResult,
  type AppEventName,
  type PlatformEventName,
  type PlatformEvents,
  type NoticeParams,
  type ApiServeResult,
  type RequestMessage,
  type AgentsLiveInResult,
  type AgentTabInfo,
  type AgentTabsLaunchParams,
  type AgentTabsListParams,
  type AgentTabsOpenResult,
  type AgentTabsResumeParams,
} from "../protocol/index.js";
import type { Transport } from "./transport.js";

/** Focus moving into the overlay's frame clears this frame's focused element. Remember it now; once
 *  the call succeeded, the next time this frame gets focus back (the overlay closed) with nothing
 *  focused inside, focus it again. A no-op outside a browser. */
function rememberFocus(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
  const before = document.activeElement;
  if (!(before instanceof HTMLElement) || before === document.body) return () => undefined;
  return () => {
    window.addEventListener(
      "focus",
      () => {
        const now = document.activeElement;
        if (before.isConnected && (now === null || now === document.body)) before.focus({ preventScroll: true });
      },
      { once: true },
    );
  };
}

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
 *  `icon`, `route`; a keyed tab's `key` and `kind`), the project it was opened in and Pomade's theme then. */
export interface Welcome extends FrameTarget {
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  /** The project the frame was opened in. */
  project: ProjectRef;
  /** Pomade's theme at the handshake; `host.theme` follows it. */
  theme: Theme;
}

/** Serves one API method: `params` as the caller sent them; `from` is the calling app's id
 *  (`"pomade"` for the platform). Return plain JSON; throw `HostError` for a protocol error code
 *  (anything else answers `app-error`). */
export type ApiHandler = (params: JsonValue, context: { from: string }) => JsonValue | Promise<JsonValue>;

export interface AppCallOptions {
  /** How long to wait for the answer: 100–60000 ms, default 5000; then `app-not-responding`. */
  timeoutMs?: number;
}

export interface FileWatch {
  readonly watchId: string;
  /** Stop delivering changes (immediately) and unwatch on the host. Idempotent. */
  close(): Promise<void>;
}

export interface GitWatch {
  readonly watchId: string;
  /** Stop delivering changes (immediately) and unwatch on the host. Idempotent. */
  close(): Promise<void>;
}

/** A subscription to one bus event (`host.events.subscribe`). */
export interface EventSubscription {
  readonly name: string;
  /** Stop calling this handler (immediately); the host subscription ends with the last handler. Idempotent. */
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
    /** The file's text (UTF-8), size and mtime; with `frontmatter: true` also its frontmatter record (Markdown files). */
    readFile(params: ReadFileParams): Promise<ReadFileResult>;
    /** A new file (parent folders created); `already-exists` when the path exists. */
    create(params: CreateFileParams): Promise<void>;
    /** Replace an existing file's whole text. Every write takes `ifMtime` (the `mtimeMs` read):
     *  `changed-on-disk` and nothing written when the file changed since. */
    write(params: WriteFileParams): Promise<void>;
    /** Replace the body after the frontmatter block; the block's bytes stay. */
    setBody(params: SetBodyParams): Promise<EditResult>;
    /** Set one frontmatter field; every other byte of the file stays. */
    setField(params: SetFieldParams): Promise<EditResult>;
    /** Remove one frontmatter field; every other byte of the file stays. */
    removeField(params: RemoveFieldParams): Promise<EditResult>;
    /** Set one frontmatter key to its own YAML lines, verbatim (a mapping, a list of mappings); every other byte stays. */
    setKeyLines(params: SetKeyLinesParams): Promise<EditResult>;
    /** Move or rename a file or folder (parent folders created); `already-exists` when `to` exists. */
    move(params: MoveParams): Promise<void>;
    /** Move files to the Trash (`files.write`); one result per path, in order — a missing file or a folder fails only its own entry. */
    delete(paths: string[]): Promise<DeleteFileResult[]>;
    /** Create a relative symlink inside a manifest `symlinks` folder. */
    symlink(params: SymlinkParams): Promise<void>;
    /** Remove a symlink inside a manifest `symlinks` folder (never its target). */
    removeSymlink(params: RemoveSymlinkParams): Promise<void>;
    /** Show a file or folder in Pomade's Files panel: the panel opens, the tree expands to `path` and selects it
     *  (`files.read`). `projectId` default: the active project; a path outside that project's folder is shown in the
     *  Workspace scope's panel. A missing path is `not-found`. */
    reveal(params: RevealParams): Promise<void>;
    /** Ask the user for a folder inside a project (or the workspace); `path: null` = cancelled. */
    pickFolder(params?: PickFolderParams): Promise<PickFolderResult>;
    /** Ask the user for a file, optionally under a folder and of given extensions; `path: null` = cancelled. */
    pickFile(params?: PickFileParams): Promise<PickFileResult>;
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
    /** Open (or focus) a terminal tab attached to a session an app's keeper holds (`tabs.open`). */
    openAttached(params: OpenAttachedParams): Promise<void>;
    /** Open or focus this app's own tab at `route` (default ""), in `projectId` (default the active project).
     *  With `key`: the keyed tab for that key — opened right of the active tab, or focused and navigated to `route`;
     *  `title` and `kind` give it its title and app tab kind (manifest `tabKinds`). */
    openApp(params?: OpenAppParams): Promise<void>;
    /** Tell Pomade the route this frame's own tab is at after navigating by itself: Pomade records it (no
     *  `route.changed` back), so a later `openApp`, notice or shortcut to another route navigates the tab, and
     *  `host.info`, a reload and a restart use it. Only for `welcome.surface === "tab"`. */
    setRoute(route: string): Promise<void>;
    /** Retitle this frame's own tab (any of the app's tabs) — unless the user renamed it. Only for `welcome.surface === "tab"`. */
    setTitle(title: string): Promise<void>;
    /** Close this frame's own tab, as the user's close does. Only for `welcome.surface === "tab"`. */
    close(): Promise<void>;
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
    /** Open this app's overlay at `route` (default ""), as its overlay shortcut does. Only from a visible tab or panel frame.
     *  When the overlay closes, Pomade gives focus back to this frame and the element that had it (the button) is focused again. */
    open(params?: OpenOverlayParams): Promise<void>;
    /** Ask for a new frame height (the width stays 420). Pomade rounds it and clamps it to its limits (at most 60% of the pane
     *  area); read `window.innerHeight` for what the frame got. Only for `welcome.surface === "overlay"`. */
    resize(params: ResizeOverlayParams): Promise<void>;
    /** Close this overlay frame; focus returns where it was. Only for `welcome.surface === "overlay"`. */
    close(): Promise<void>;
  };
  readonly apps: {
    /** Call a method another app (or this app's own backend) offers. Rejects with `HostError`:
     *  `app-absent` (not installed or not running), `app-not-responding` (no answer in time) —
     *  both the caller's cue to fall back — or the serving app's own error. */
    call<T extends JsonValue = JsonValue>(app: string, method: string, params?: JsonValue, options?: AppCallOptions): Promise<T>;
  };
  readonly agents: {
    /** Platform commands only (`pomade-git`): agents running in Pomade terminals inside `folder`. */
    liveIn(folder: string): Promise<AgentsLiveInResult>;
  };
  readonly agentTabs: {
    /** Every agent tab — bound to a session or not yet — or one project's (`agentTabs.read`). */
    list(params?: AgentTabsListParams): Promise<AgentTabInfo[]>;
    /** Name a tab, or mark its session unnamed with `null` (`agentTabs.write`). */
    setTitle(tabId: string, title: string | null): Promise<void>;
    /** Bring a tab to the front; its project becomes active (`tabs.open`). */
    focus(tabId: string): Promise<void>;
    /** Start an agent in a new tab (`tabs.open`); resolves with the tab's id. */
    launch(params: AgentTabsLaunchParams): Promise<AgentTabsOpenResult>;
    /** Resume a session in a new tab, or focus the tab it is bound to (`tabs.open`); resolves with the tab's id. */
    resume(params: AgentTabsResumeParams): Promise<AgentTabsOpenResult>;
  };
  readonly api: {
    /** Serve this app's API (the manifest's `api` methods) from this client; resolves with the
     *  declared methods. A method without a handler answers `unknown-method`. */
    serve(handlers: Record<string, ApiHandler>): Promise<ApiServeResult>;
  };
  readonly theme: {
    /** Pomade's theme now: the welcome's, then each `theme.changed`. */
    get(): Theme;
    /** Called with the new theme on every `theme.changed`; returns an unsubscribe function. */
    onChange(callback: (theme: Theme) => void): () => void;
  };
  /** Called with the new route when Pomade navigates this frame's tab (`welcome.route` is the first); returns an unsubscribe function. */
  onRouteChange(callback: (route: string) => void): () => void;
  readonly git: {
    /** Every repo's state, or one project's repos (`projectId`). */
    getState(params?: GitStateParams): Promise<GitStateResult>;
    /** Resolves once the host accepted the watch; `onChange` receives the scope's repos after each change. */
    watch(params: GitStateParams, onChange: (repos: GitRepoState[]) => void): Promise<GitWatch>;
  };
  readonly events: {
    /** Publish one of this app's own events (declared in the manifest's `events.publish`) to its subscribers. */
    publish(name: string, payload?: JsonValue): Promise<void>;
    /** Listen to a platform event (declared in the manifest's `events.subscribe`); resolves once the host accepted. */
    subscribe<E extends PlatformEventName>(name: E, handler: (payload: PlatformEvents[E]) => void): Promise<EventSubscription>;
    /** Listen to another app's event, `<appId>:<event>` (declared in the manifest's `events.subscribe`). */
    subscribe(name: AppEventName, handler: (payload: JsonValue) => void): Promise<EventSubscription>;
    /** Whether one of this app's own events has subscribers now. */
    hasSubscribers(name: string): Promise<boolean>;
    /** Called when one of this app's own events gains its first subscriber or loses its last; returns an unsubscribe function. */
    onSubscribersChange(callback: (name: string, subscribed: boolean) => void): () => void;
  };
  readonly notices: {
    /** Show a notice in Pomade (a toast that also stays in the Notices list); `action` is what a click does. */
    post(notice: NoticeParams): Promise<void>;
  };
  /** Detach from the transport: no more events, pending calls reject. */
  close(): void;
  /** Called once when the client closes — `close()`, or the channel ended (Pomade quit, for a
   *  socket client); returns an unsubscribe function. */
  onClose(callback: () => void): () => void;
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
  const themeListeners = new Set<(theme: Theme) => void>();
  let theme = welcome.theme;
  const gitWatches = new Map<string, (repos: GitRepoState[]) => void>();
  // Bus subscriptions: handlers by event name, and the host subscription each name rides.
  const busHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const busSubscriptions = new Map<string, Promise<unknown>>();
  const subscriberListeners = new Set<(name: string, subscribed: boolean) => void>();
  const closeListeners = new Set<() => void>();
  let apiHandlers: Record<string, ApiHandler> | null = null;

  function respond(id: string, outcome: { ok: true; value: JsonValue } | { ok: false; code: ErrorCode; message: string }): void {
    if (closed) return;
    transport.send(
      outcome.ok
        ? { channel: CHANNEL, type: "response", id, ok: true, value: outcome.value }
        : { channel: CHANNEL, type: "response", id, ok: false, error: { code: outcome.code, message: outcome.message } },
    );
  }

  async function serveRequest(msg: RequestMessage): Promise<void> {
    const handler = apiHandlers && Object.hasOwn(apiHandlers, msg.method) ? apiHandlers[msg.method] : undefined;
    if (!handler) {
      respond(msg.id, { ok: false, code: "unknown-method", message: `No handler for ${JSON.stringify(msg.method)}` });
      return;
    }
    try {
      respond(msg.id, { ok: true, value: await handler(msg.params, { from: msg.from }) });
    } catch (err) {
      if (err instanceof HostError) respond(msg.id, { ok: false, code: err.code, message: err.message });
      else respond(msg.id, { ok: false, code: "app-error", message: err instanceof Error ? err.message : String(err) });
    }
  }

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
      for (const handler of [...(busHandlers.get(msg.name) ?? [])]) handler(msg.payload);
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
        case "theme.changed":
          theme = msg.payload.theme;
          for (const cb of [...themeListeners]) cb(theme);
          break;
        case "git.changed":
          gitWatches.get(msg.payload.watchId)?.(msg.payload.repos);
          break;
        case "events.subscribersChanged":
          for (const cb of [...subscriberListeners]) cb(msg.payload.name, msg.payload.subscribed);
          break;
        // Bus events reach their `events.subscribe` handlers above.
        case "pomade.ready":
        case "project.created":
        case "project.renamed":
        case "project.removed":
        case "project.opened":
        case "project.updated":
        case "agentTab.exited":
        case "agentTab.changed":
        case "attachedTab.action":
          break;
        default:
          break;
      }
    } else if (msg.type === "request") {
      void serveRequest(msg);
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
    unlistenEnd?.();
    onClose?.();
    watches.clear();
    gitWatches.clear();
    projectListeners.clear();
    busHandlers.clear();
    busSubscriptions.clear();
    subscriberListeners.clear();
    stateListeners.clear();
    routeListeners.clear();
    themeListeners.clear();
    const error = new Error("pomade-kit: client is closed");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    const listeners = [...closeListeners];
    closeListeners.clear();
    for (const cb of listeners) cb();
  }
  const unlistenEnd = transport.onEnd?.(dispose);

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
      setKeyLines: (params) => call("files.setKeyLines", params),
      async move(params) {
        await call("files.move", params);
      },
      async delete(paths) {
        const { results } = await call("files.delete", { paths });
        return results;
      },
      async symlink(params) {
        await call("files.symlink", params);
      },
      async removeSymlink(params) {
        await call("files.removeSymlink", params);
      },
      async reveal(params) {
        await call("files.reveal", params);
      },
      pickFolder: (params = {}) => call("files.pickFolder", params),
      pickFile: (params = {}) => call("files.pickFile", params),
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
      async openAttached(params) {
        await call("tabs.openAttached", params);
      },
      async openTerminal(params) {
        await call("tabs.openTerminal", params);
      },
      async openApp(params = {}) {
        await call("tabs.openApp", params);
      },
      async setRoute(route) {
        await call("tabs.setRoute", { route });
      },
      async setTitle(title) {
        await call("tabs.setTitle", { title });
      },
      async close() {
        await call("tabs.close", {});
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
      async open(params = {}) {
        const restore = rememberFocus();
        await call("overlay.open", params);
        restore();
      },
      async resize(params) {
        await call("overlay.resize", params);
      },
      async close() {
        await call("overlay.close", {});
      },
    },
    apps: {
      async call<T extends JsonValue = JsonValue>(app: string, method: string, params?: JsonValue, options: AppCallOptions = {}) {
        const value = await call("apps.call", {
          app,
          method,
          ...(params !== undefined ? { params } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        return value as T;
      },
    },
    agents: {
      liveIn: (folder) => call("agents.liveIn", { folder }),
    },
    agentTabs: {
      async list(params = {}) {
        return (await call("agentTabs.list", params)).tabs;
      },
      async setTitle(tabId, title) {
        await call("agentTabs.setTitle", { tabId, title });
      },
      async focus(tabId) {
        await call("agentTabs.focus", { tabId });
      },
      launch: (params) => call("agentTabs.launch", params),
      resume: (params) => call("agentTabs.resume", params),
    },
    api: {
      serve(handlers) {
        apiHandlers = { ...handlers };
        return call("api.serve", {});
      },
    },
    theme: {
      get: () => theme,
      onChange(callback) {
        themeListeners.add(callback);
        return () => themeListeners.delete(callback);
      },
    },
    onRouteChange(callback) {
      routeListeners.add(callback);
      return () => routeListeners.delete(callback);
    },
    git: {
      getState: (params = {}) => call("git.getState", params),
      async watch(params, onChange) {
        const { watchId } = await call("git.watch", params, (v) => gitWatches.set(v.watchId, onChange));
        let unwatched: Promise<void> | null = null;
        return {
          watchId,
          close() {
            unwatched ??= (async () => {
              gitWatches.delete(watchId);
              if (!closed) await call("git.unwatch", { watchId });
            })();
            return unwatched;
          },
        };
      },
    },
    events: {
      async publish(name, payload = null) {
        await call("events.publish", { name, payload });
      },
      async subscribe(name: string, handler: (payload: never) => void): Promise<EventSubscription> {
        const h = handler as (payload: unknown) => void;
        let handlers = busHandlers.get(name);
        if (!handlers) {
          handlers = new Set();
          busHandlers.set(name, handlers);
        }
        handlers.add(h);
        const own = handlers;
        let accepted = busSubscriptions.get(name);
        if (!accepted) {
          accepted = call("events.subscribe", { name });
          busSubscriptions.set(name, accepted);
        }
        const drop = (): boolean => {
          own.delete(h);
          if (own.size > 0 || busHandlers.get(name) !== own) return false;
          busHandlers.delete(name);
          busSubscriptions.delete(name);
          return true;
        };
        try {
          await accepted;
        } catch (err) {
          drop();
          throw err;
        }
        let closing: Promise<void> | null = null;
        return {
          name,
          close() {
            closing ??= (async () => {
              if (drop() && !closed) await call("events.unsubscribe", { name });
            })();
            return closing;
          },
        };
      },
      async hasSubscribers(name) {
        const { subscribed } = await call("events.hasSubscribers", { name });
        return subscribed;
      },
      onSubscribersChange(callback) {
        subscriberListeners.add(callback);
        return () => subscriberListeners.delete(callback);
      },
    },
    notices: {
      async post(notice) {
        await call("notices.post", notice);
      },
    },
    close: dispose,
    onClose(callback) {
      if (closed) {
        callback();
        return () => undefined;
      }
      closeListeners.add(callback);
      return () => closeListeners.delete(callback);
    },
  };
}
