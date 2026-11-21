// The fake host: the whole Host API v0 in memory, speaking the same messages as Pomade, so an
// app runs unchanged against it — in-process (unit tests, `dev:fake`) or as the parent window
// of the app's frame (browser e2e).

import {
  CHANNEL,
  CAPABILITIES,
  EventBus,
  checkEventPayload,
  checkHasSubscribers,
  checkPublish,
  checkSubscribe,
  checkUnsubscribe,
  checkNotice,
  noticeActionCapability,
  isBusEventName,
  type NoticeParams,
  type BusMember,
  APP_CALL_TIMEOUT_MS,
  PLATFORM_CLIENT_ID,
  brokerErrors,
  isJsonValue,
  parseAppCall,
  type ErrorPayload,
  FRAME_ONLY_METHODS,
  isSocketSurface,
  HOST_API_VERSION,
  METHOD_CAPABILITY,
  WORKSPACE_PROJECT_ID,
  checkOverlayAnchor,
  checkTabRoute,
  checkTabTitle,
  type CheckedOpenAppParams,
  checkOverlayHeight,
  checkStateKey,
  normalizeVisibleAgents,
  checkStateValue,
  normalizeWorkspacePath,
  parseAppMessage,
  parseManifest,
  resolveFrameTarget,
  resolveOverlayTarget,
  type AppShortcut,
  type FileChange,
  type FrameTarget,
  type GitRepoState,
  type HostToAppMessage,
  type IncomingCall,
  type JsonValue,
  type KeyMessage,
  type Manifest,
  type MethodName,
  type OverlayAnchor,
  type ProjectChange,
  type ProjectRef,
  type Theme,
  type RosterAgent,
  type StripIcon,
  type Surface,
  type AgentTabInfo,
  type AgentTabState,
} from "../protocol/index.js";
import { isPlainEscape } from "../sdk/keys.js";
import { HostError, type ApiHandler } from "../sdk/client.js";
import type { Transport } from "../sdk/transport.js";
import {
  dispatchFileWrite,
  dispatchPick,
  dispatchProjects,
  dispatchSymlinks,
  dispatchTabs,
  listProjects,
  sameList,
  type DataContext,
  type FakeGroup,
  type FakeOpenedTab,
  type FakePickRequest,
  type FakeWriteFailure,
} from "./data.js";
import { reposInScope, scriptedRepos, type GitWatchState } from "./git.js";
import { DEFAULT_FAKE_ROSTER, FakeAgentTabs, type FakeAgentTabSeed, type FakeOpenedAgentTab, type FakeSession } from "./agent-tabs.js";
import { booleanParam, CallError, paramsObject, requestPath, requireAllowedTarget, stringParam } from "./params.js";
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
  /** The id of the project's group (`FakeHostOptions.groups`); absent = ungrouped. */
  group?: string;
  /** The project's visible agents; default `["*"]` (every agent). */
  visibleAgents?: string[];
  /** The app's own settings for this project; default `{}`. */
  settings?: Record<string, JsonValue>;
}

export interface FakeHostOptions {
  /** Workspace files, path → content. Folders are created as needed. */
  files?: Record<string, string>;
  projects?: FakeProject[];
  /** Sidebar groups, in sidebar order among siblings. */
  groups?: FakeGroup[];
  /** The active project's id; `null`/absent = the Workspace scope. */
  activeProject?: string | null;
  /** The app's manifest (parsed `manifest.json`); it sets the app id and the granted capabilities. Default: an app with every capability. */
  manifest?: unknown;
  /** Default "0.0.0-fake". */
  pomadeVersion?: string;
  /** Pomade's theme at start (`welcome.theme`). Default "light". */
  theme?: Theme;
  /** The Host API version this host speaks. Default `HOST_API_VERSION`. */
  hostApi?: number;
  /** Entry names hidden from `readFolder` and watches. Default Pomade's tree ignore list. */
  ignore?: readonly string[];
  /** Clock for `mtimeMs`. Default `Date.now`. */
  now?: () => number;
  /** The app's machine-local state at start (`state.get` / `state.set`), key → value. */
  state?: Record<string, JsonValue>;
  /** The workspace's repos as `git.getState` serves them (any order; served sorted by root). Default none. */
  git?: GitRepoState[];
  /** Where the app's build is, for `host.info` skill paths. Default `/fake/apps/<id>`. */
  appFolder?: string;
  /** Other apps that are installed and running, by id: the API methods each serves (`apps.call`), or
   *  `"not-responding"` for one that never answers. An app absent here is not installed. */
  apps?: Record<string, FakeApi>;
  /** Pomade's agent tabs at start (`agentTabs.list`), in tab order. Default none. */
  agentTabs?: FakeAgentTabSeed[];
  /** The roster `agentTabs.launch` / `resume` accept and the default titles come from. Default Pomade's built-ins (claude, codex). */
  roster?: RosterAgent[];
  /** The sessions `agentTabs.resume` finds. Default none. */
  sessions?: FakeSession[];
  /** The absolute folder the fake workspace stands for, in `AgentTabInfo.cwd`. Default `/fake/workspace`. */
  workspaceRoot?: string;
}

/** Another app as `apps.call` reaches it in the fake host. */
export type FakeApi = Record<string, ApiHandler> | "not-responding";

/** `fake.callApi` options. */
export interface CallApiOptions {
  /** The calling app's id; default `"pomade"` (the platform). */
  from?: string;
  /** Default 5000 ms. */
  timeoutMs?: number;
}

/** What a frame is opened for, as Pomade opens it from the new-tab menu or a strip icon. */
export interface FrameOptions {
  /** Default `"tab"`. */
  surface?: Surface;
  /** The strip icon id; an id the manifest does not declare opens the default view (no icon, route `""`). */
  icon?: string;
  /** `surface: "overlay"`: the shortcut that opened it; the frame renders its route. */
  shortcut?: string;
  /** Open at this route instead of the icon's or shortcut's — a tab Pomade opened for `tabs.openApp`. */
  route?: string;
  /** The app tab (`fake.appTabs`) the frame shows: it opens as that tab, at its icon and route, and
   *  follows the tab's route changes (`route.changed`). Unknown ids throw. */
  tabId?: string;
  /** An overlay frame asked to close (`overlay.close`, or a forwarded Escape), or a tab frame closed its tab
   *  (`tabs.close`): close it here, as Pomade does. */
  onClose?: () => void;
  /** A tab or panel frame opened its overlay (`overlay.open`, after its result): mount it here, as Pomade does. */
  onOverlayOpen?: (overlay: FakeOpenedOverlay) => void;
  /** An overlay frame asked for a height (`overlay.resize`, as given): size it here, as Pomade does. */
  onOverlayResize?: (height: number) => void;
  /** The frame starts hidden — a tab in the background, a panel not shown; `overlay.open` refuses a hidden frame. Default `false`. */
  hidden?: boolean;
}

/** An overlay the app opened (`overlay.open`), as the fake host records it. */
export interface FakeOpenedOverlay {
  route: string;
  /** The requested frame height, as given (absent when the call named none). */
  height?: number;
  /** The requested anchor; `"center"` when the call named none. */
  anchor: OverlayAnchor;
}

/** A strip icon's badge (`strip.setBadge`). */
export interface FakeBadge {
  /** ≥ 1; a count of 0 removes the badge. */
  count: number;
  urgent: boolean;
}

/** One of the app's own tabs in Pomade's tab strip (`tabs.openApp`, `fake.openAppTab`): one per
 *  strip icon per project, one icon-less tab per project, and one keyed tab per key per project. */
export interface FakeAppTab {
  tabId: string;
  projectId: string;
  /** The strip icon the tab is for; absent for the icon-less tab and keyed tabs. */
  icon?: string;
  /** The route the tab renders now. */
  route: string;
  /** A keyed tab's key; absent for other tabs. */
  key?: string;
  /** A keyed tab's app tab kind, when it has one. */
  kind?: string;
  /** A keyed tab's title: the app's (`tabs.openApp` `title`, `tabs.setTitle`), else its kind's title, else
   *  the app's name; the user's once they renamed it (`fake.renameAppTab`). Absent for other tabs. */
  title?: string;
  /** The user renamed the tab (`fake.renameAppTab`): the app's titles no longer change it. */
  renamed?: boolean;
}

/** What happened to an app tab: opened (and focused), focused, navigated to a new route, retitled, or closed. */
export interface FakeAppTabChange {
  change: "open" | "focus" | "route" | "title" | "close";
  tab: FakeAppTab;
}

/** One app frame attached to the host. */
export interface FrameConnection {
  /** Hand the host a message the frame sent. */
  receive(data: unknown): void;
  /** The frame is gone: drop its watches, stop sending to it. */
  detach(): void;
  /** Navigate the frame's tab to `route`, as Pomade does for `tabs.openApp`: `route.changed` when it differs (after welcome), and `host.info` answers it. A frame of an app tab (`tabId`) navigates that tab and every frame showing it. */
  navigate(route: string): void;
  /** Hide or show the frame, as Pomade does when the user switches tabs or panels. */
  setHidden(hidden: boolean): void;
}


interface Watch {
  path: string;
  recursive: boolean;
}

/** One event the app published (`events.publish`), as declared (unqualified). */
export interface FakePublishedEvent {
  name: string;
  payload: JsonValue;
}

interface Frame {
  /** Serves the app's API (`api.serve`). */
  serving: boolean;
  post(message: HostToAppMessage): void;
  /** The frame's place on the event bus, from its welcome on. */
  bus: BusMember | null;
  target: FrameTarget;
  onClose: (() => void) | undefined;
  onOverlayOpen: ((overlay: FakeOpenedOverlay) => void) | undefined;
  onOverlayResize: ((height: number) => void) | undefined;
  hidden: boolean;
  welcomed: boolean;
  /** The app tab the frame shows, if any. */
  tab: AppTabRecord | null;
  watches: Map<string, Watch>;
  gitWatches: Map<string, GitWatchState>;
}

interface AppTabRecord extends FakeAppTab {
  frames: Set<Frame>;
  /** A keyed tab's title came from the app (`title`, `tabs.setTitle`), not from its kind or the app's name. */
  appTitled?: boolean;
}

/** Calls whose project is optional and, for a socket client, defaults to the Workspace scope (HOST-API §3 "Socket"). */
const WORKSPACE_DEFAULT_METHODS: readonly string[] = [
  "tabs.openFile",
  "tabs.openTerminal",
  "tabs.openAttached",
  "tabs.openApp",
  "agentTabs.launch",
  "agentTabs.resume",
];

function isMethod(name: string): name is MethodName {
  return Object.hasOwn(METHOD_CAPABILITY, name);
}

export class FakeHost {
  readonly manifest: Manifest;
  readonly pomadeVersion: string;
  readonly hostApi: number;
  /** Every `key` message received, in order. */
  readonly keys: KeyMessage[] = [];
  /** Every tab the app opened (`tabs.openFile` / `tabs.openTerminal` / `tabs.openAttached` / `tabs.openApp`), in order. */
  readonly openedTabs: FakeOpenedTab[] = [];
  /** Every overlay the app opened (`overlay.open`), in order. */
  readonly overlays: FakeOpenedOverlay[] = [];
  /** Every height an overlay frame asked for with `overlay.resize`, in order, as given. */
  readonly overlayResizes: number[] = [];
  /** Every picker the app opened (`files.pickFolder`, `files.pickFile`), in order. */
  readonly pickRequests: FakePickRequest[] = [];
  private readonly pickAnswers: (string | null)[] = [];
  private readonly writeFailures: { path: string; failure: FakeWriteFailure }[] = [];

  private readonly workspace: Workspace;
  private readonly projects: ProjectRef[];
  private readonly groupList: FakeGroup[];
  private readonly projectGroup = new Map<string, string>();
  private readonly projectAgents = new Map<string, string[]>();
  private readonly projectSettings = new Map<string, Record<string, JsonValue>>();
  private active: ProjectRef;
  private themeNow: Theme;
  private readonly frames = new Set<Frame>();
  private nextWatchId = 1;
  private batched: FileChange[] | null = null;
  private defaultTransport: Transport | null = null;
  private readonly strip: readonly StripIcon[];
  private readonly shortcuts: readonly AppShortcut[];
  private readonly badgeMap = new Map<string, FakeBadge>();
  private readonly data: DataContext;
  private readonly stateMap = new Map<string, string>();
  private gitRepos: GitRepoState[];
  private readonly bus = new EventBus();
  /** Every event the app published (`events.publish`), in order. */
  readonly published: FakePublishedEvent[] = [];
  /** Every notice the app posted (`notices.post`), normalized as Pomade keeps it, in order. */
  readonly notices: NoticeParams[] = [];
  /** Per notice: the project it belongs to — the poster's (an app tab's frame: its tab's project; another frame: the active one then; a socket client: the Workspace). */
  private readonly noticeProjects: string[] = [];
  /** Every open, focus and route change of the app's own tabs, in order. */
  readonly appTabChanges: FakeAppTabChange[] = [];
  private readonly appTabList: AppTabRecord[] = [];
  private readonly appTabListeners = new Set<(change: FakeAppTabChange) => void>();
  private nextAppTab = 1;
  /** The absolute folder the fake workspace stands for (`FakeHostOptions.workspaceRoot`). */
  readonly workspaceRoot: string;
  private readonly apps: Record<string, FakeApi>;
  private readonly appFolder: string;
  private nextRequestId = 1;
  private readonly agentTabModel: FakeAgentTabs;
  private readonly requests = new Map<string, { frame: Frame; settle(outcome: { ok: true; value: JsonValue } | { ok: false; error: ErrorPayload }): void }>();

  constructor(options: FakeHostOptions = {}) {
    const parsed = parseManifest(
      options.manifest ?? { id: "fake-app", name: "Fake app", version: "0.0.0", hostApi: HOST_API_VERSION, capabilities: [...CAPABILITIES] },
    );
    if (!parsed.ok) throw new Error(`fake host: invalid manifest: ${parsed.errors.map((e) => e.message).join("; ")}`);
    this.manifest = parsed.manifest;
    this.strip = parsed.manifest.strip ?? [];
    this.shortcuts = parsed.manifest.shortcuts ?? [];
    this.pomadeVersion = options.pomadeVersion ?? "0.0.0-fake";
    this.themeNow = options.theme ?? "light";
    this.hostApi = options.hostApi ?? HOST_API_VERSION;
    this.workspace = new Workspace(options.files ?? {}, options.ignore ?? DEFAULT_IGNORE, options.now ?? Date.now);
    this.groupList = (options.groups ?? []).map((g) => ({ ...g }));
    for (const g of this.groupList) {
      if (g.parent !== undefined && !this.groupList.some((x) => x.id === g.parent)) {
        throw new Error(`fake host: group ${JSON.stringify(g.id)} has an unknown parent ${JSON.stringify(g.parent)}`);
      }
    }
    this.projects = (options.projects ?? []).map((p) => ({ id: p.id, kind: "project", name: p.name, root: controlPath(p.root) }));
    for (const p of options.projects ?? []) {
      if (p.group === undefined) continue;
      if (!this.groupList.some((g) => g.id === p.group)) {
        throw new Error(`fake host: project ${JSON.stringify(p.id)} is in an unknown group ${JSON.stringify(p.group)}`);
      }
      this.projectGroup.set(p.id, p.group);
    }
    for (const p of options.projects ?? []) {
      this.projectAgents.set(p.id, [...(p.visibleAgents ?? ["*"])]);
      this.projectSettings.set(p.id, structuredClone(p.settings ?? {}));
    }
    this.active = this.findScope(options.activeProject ?? null);
    this.gitRepos = scriptedRepos(options.git ?? []);
    this.apps = { ...(options.apps ?? {}) };
    this.appFolder = (options.appFolder ?? `/fake/apps/${parsed.manifest.id}`).replace(/\/+$/, "");
    this.data = {
      workspace: this.workspace,
      emit: (changes) => this.emit(changes),
      project: (id) => {
        if (id === undefined) return { ...this.active };
        if (id === WORKSPACE_PROJECT_ID) return { ...WORKSPACE_SCOPE };
        const project = this.projects.find((p) => p.id === id);
        if (!project) throw new CallError("not-found", `No project ${JSON.stringify(id)}`);
        return { ...project };
      },
      activate: (id) => this.setActiveProject(id === WORKSPACE_PROJECT_ID ? null : id),
      openApp: (projectId, params) => {
        if (params.key !== undefined) this.openKeyedTab(projectId, params.key, params);
        else this.openOwnTab(projectId, this.iconForRoute(params.route), params.route);
      },
      tabKinds: parsed.manifest.tabKinds,
      openedTabs: this.openedTabs,
      listProjects: () => listProjects(this.groupList, this.projects, this.projectGroup),
      projectAgents: this.projectAgents,
      projectSettings: this.projectSettings,
      projectUpdated: (id, changes) => this.publishProjectUpdated(id, changes),
      symlinkScopes: parsed.manifest.symlinks ?? [],
      pickAnswers: this.pickAnswers,
      pickRequests: this.pickRequests,
      writeFailures: this.writeFailures,
    };
    this.workspaceRoot = (options.workspaceRoot ?? "/fake/workspace").replace(/\/+$/, "");
    this.agentTabModel = new FakeAgentTabs(
      {
        workspace: this.workspace,
        workspaceRoot: this.workspaceRoot,
        project: (id) => this.data.project(id),
        activate: (id) => this.data.activate(id),
        publish: (payload) => this.bus.publish("agentTab.changed", structuredClone(payload) as unknown as JsonValue),
        now: options.now ?? Date.now,
      },
      options.roster ?? DEFAULT_FAKE_ROSTER,
      options.sessions ?? [],
      options.agentTabs ?? [],
    );
    for (const [key, value] of Object.entries(options.state ?? {})) {
      const bad = checkStateKey(key) ?? checkStateValue(value);
      if (bad) throw new Error(`fake host: invalid state ${JSON.stringify(key)}: ${bad}`);
      if (value !== null) this.stateMap.set(key, JSON.stringify(value));
    }
  }

  // ── Frames and transports ────────────────────────────────────────────────

  /** Attach a frame opened for `open` (default: a tab from the new-tab menu); `post` delivers host → app messages to it. */
  attach(post: (message: HostToAppMessage) => void, open: FrameOptions = {}): FrameConnection {
    const tab = open.tabId === undefined ? null : (this.appTabList.find((t) => t.tabId === open.tabId) ?? null);
    if (open.tabId !== undefined && !tab) throw new Error(`fake host: no app tab ${JSON.stringify(open.tabId)}`);
    const surface = tab ? "tab" : (open.surface ?? "tab");
    const target =
      surface === "overlay"
        ? resolveOverlayTarget(this.shortcuts, open.shortcut)
        : resolveFrameTarget(this.strip, surface, tab ? tab.icon : open.icon);
    if (tab) {
      target.route = tab.route;
      if (tab.key !== undefined) target.key = tab.key;
      if (tab.kind !== undefined) target.kind = tab.kind;
    } else if (open.route !== undefined) target.route = open.route;
    const frame: Frame = {
      post,
      target,
      onClose: open.onClose,
      onOverlayOpen: open.onOverlayOpen,
      onOverlayResize: open.onOverlayResize,
      hidden: open.hidden === true,
      welcomed: false,
      serving: false,
      tab,
      watches: new Map(),
      gitWatches: new Map(),
      bus: null,
    };
    this.frames.add(frame);
    tab?.frames.add(frame);
    return {
      receive: (data) => {
        if (this.frames.has(frame)) this.handle(frame, data);
      },
      detach: () => {
        this.frames.delete(frame);
        frame.tab?.frames.delete(frame);
        this.dropRequests(frame);
        frame.watches.clear();
        frame.gitWatches.clear();
        frame.bus?.close();
        frame.bus = null;
      },
      setHidden: (hidden) => {
        frame.hidden = hidden;
      },
      navigate: (route) => {
        if (frame.tab) this.navigateTab(frame.tab, route);
        else this.navigateFrame(frame, route);
      },
    };
  }

  /** A new in-memory frame opened for `open` (default: a tab from the new-tab menu): pass it to `connect({ transport })`. Messages are cloned and delivered asynchronously, like postMessage. */
  createTransport(open?: FrameOptions): Transport {
    const listeners = new Set<(data: unknown) => void>();
    const frame = this.attach((message) => {
      const copy = structuredClone(message);
      setTimeout(() => {
        for (const listener of [...listeners]) listener(copy);
      }, 0);
    }, open);
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

  /** Create or overwrite a file; emits `create` (with any new parent folders) or `change`. `silent`:
   *  the bytes and the mtime change but no watch hears it — a change the app finds only by reading
   *  (`ifMtime` writes then fail with `changed-on-disk`). */
  writeFile(path: string, content: string, options: { silent?: boolean } = {}): void {
    const changes = this.workspace.writeFile(controlPath(path), content);
    if (options.silent !== true) this.emit(changes);
  }

  /** Script the app's next write to `path` (any `files.write` method naming it; a `move`'s `from`
   *  or `to`, a `delete`'s entry) to fail with the error Pomade gives for `failure`, once it passed
   *  the checks Pomade makes first. Failures queue up, each used once. */
  failNextWrite(path: string, failure: FakeWriteFailure): void {
    this.writeFailures.push({ path: controlPath(path), failure });
  }

  /** Create a symlink at `path` to `target` (both workspace-relative); emits `create`. */
  symlink(path: string, target: string): void {
    this.emit(this.workspace.symlink(controlPath(path), controlPath(target)));
  }

  /** True when `path` is a symlink (what the app's `files.symlink` left on the fake disk). */
  isSymlink(path: string): boolean {
    return this.workspace.isLink(controlPath(path));
  }

  /** Script the user's next picker choice: a workspace-relative folder (for a folder picker) or
   *  file (for a file picker), or `null` to cancel. Answers queue up; with none left a picker is
   *  cancelled. */
  answerPick(path: string | null): void {
    if (path === null) {
      this.pickAnswers.push(null);
      return;
    }
    // An answer outside the workspace stays as given: the picker refuses it like any outside folder.
    const n = normalizeWorkspacePath(path);
    this.pickAnswers.push(n.ok ? n.path : path);
  }

  /** A file's current text — what the app's writes left on the fake disk. */
  readFile(path: string): string {
    const file = this.workspace.file(controlPath(path));
    if (!file) throw new Error(`fake host: no file at ${path}`);
    return file.content;
  }

  /** Delete a file; emits `delete`. */
  deleteFile(path: string): void {
    this.emit(this.workspace.deleteFile(controlPath(path)));
  }

  /** Move a file or folder; emits `rename` (with any new parent folders). */
  rename(from: string, to: string): void {
    this.emit(this.workspace.rename(controlPath(from), controlPath(to)));
  }

  /** Replace the workspace's repos (what Pomade's git state would read next); emits `git.changed` to
   *  every watch whose scope's repos changed. */
  setGitRepos(repos: GitRepoState[]): void {
    this.gitRepos = scriptedRepos(repos);
    this.refreshGitWatches();
  }

  /** Switch the active project (`null` = Workspace); emits `project.changed` when it changes. */
  setActiveProject(id: string | null): void {
    const next = this.findScope(id);
    if (next.id === this.active.id) return;
    this.active = next;
    this.bus.publish("project.changed", { ...next });
  }

  /** Change Pomade's theme; emits `theme.changed` when it changes. */
  setTheme(theme: Theme): void {
    if (theme === this.themeNow) return;
    this.themeNow = theme;
    this.bus.publish("theme.changed", { theme });
  }

  /** Pomade's theme now. */
  get theme(): Theme {
    return this.themeNow;
  }

  /** Rename, move or regroup a project, or change its visible agents, as the user does in Pomade;
   *  its id stays. Emits `project.renamed` for a new name or folder, `project.updated` for a new
   *  group or agent list, and `project.changed` when it is the active project and its name or
   *  folder changed — as Pomade does. */
  updateProject(id: string, patch: { name?: string; root?: string; group?: string | null; visibleAgents?: string[] }): void {
    const project = this.projects.find((p) => p.id === id);
    if (!project) throw new Error(`fake host: no project ${JSON.stringify(id)}`);
    if (patch.group !== undefined && patch.group !== null && !this.groupList.some((g) => g.id === patch.group)) {
      throw new Error(`fake host: no group ${JSON.stringify(patch.group)}`);
    }
    let agents: string[] | undefined;
    if (patch.visibleAgents !== undefined) {
      const normalized = normalizeVisibleAgents(patch.visibleAgents);
      if (typeof normalized === "string") throw new Error(`fake host: ${normalized}`);
      agents = normalized;
    }
    const previous = { ...project };
    const previousGroup = this.projectGroup.get(id) ?? null;
    const previousAgents = this.projectAgents.get(id) ?? ["*"];
    if (patch.name !== undefined) project.name = patch.name;
    if (patch.root !== undefined) project.root = controlPath(patch.root);
    if (patch.group === null) this.projectGroup.delete(id);
    else if (patch.group !== undefined) this.projectGroup.set(id, patch.group);
    if (agents !== undefined) this.projectAgents.set(id, agents);
    // A moved project's git scope follows its new root.
    if (patch.root !== undefined) this.refreshGitWatches();
    const renamed = project.name !== previous.name || project.root !== previous.root;
    if (renamed) this.bus.publish("project.renamed", { project: { ...project }, previous });
    const changes: ProjectChange[] = [];
    if ((this.projectGroup.get(id) ?? null) !== previousGroup) changes.push("group");
    if (agents !== undefined && !sameList(previousAgents, agents)) changes.push("agents");
    if (changes.length > 0) this.publishProjectUpdated(id, changes);
    if (!renamed || this.active.id !== id) return;
    this.active = { ...project };
    this.bus.publish("project.changed", { ...project });
  }

  /** Remove a project from the workspace, as the user does in Pomade: its group, agents and settings
   *  go with it. Emits `project.removed` (the project as it was), then `project.changed` to the
   *  Workspace scope when it was the active project — as Pomade does. */
  removeProject(id: string): void {
    const at = this.projects.findIndex((p) => p.id === id);
    if (at === -1) throw new Error(`fake host: no project ${JSON.stringify(id)}`);
    const [project] = this.projects.splice(at, 1);
    this.projectGroup.delete(id);
    this.projectAgents.delete(id);
    this.projectSettings.delete(id);
    this.refreshGitWatches();
    this.bus.publish("project.removed", { ...project! });
    if (this.active.id !== id) return;
    this.active = { ...WORKSPACE_SCOPE };
    this.bus.publish("project.changed", { ...WORKSPACE_SCOPE });
  }

  /** `project.updated` to its subscribers; a `settings` change reaches only this app (the fake host's one app). */
  private publishProjectUpdated(id: string, changes: ProjectChange[]): void {
    const project = this.data.listProjects().projects.find((p) => p.id === id);
    if (!project) return;
    const payload = { project, changes } as unknown as JsonValue;
    if (changes.includes("settings")) this.bus.publishTo(this.manifest.id, "project.updated", payload);
    else this.bus.publish("project.updated", payload);
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

  /** Pomade finished restoring its tabs: raise the sticky `pomade.ready` (later subscriptions get it at once). */
  ready(): void {
    this.bus.publishSticky("pomade.ready", {});
  }

  /** Deliver a bus event to the frames subscribed to it — a platform event (`project.created`, `agentTab.exited`, …)
   *  or another app's (`pomade-runner:run.finished`). */
  emitEvent(name: string, payload: JsonValue): void {
    if (!isBusEventName(name)) throw new Error(`fake host: ${JSON.stringify(name)} is not a platform event or "<appId>:<event>"`);
    const bad = checkEventPayload(payload);
    if (bad) throw new Error(`fake host: ${bad}`);
    this.bus.publish(name, structuredClone(payload));
  }

  /** Another app subscribes to this app's own event `name` (unqualified), as `events.hasSubscribers` and
   *  `events.subscribersChanged` see it; returns its unsubscribe. What it hears lands in `heard`. */
  subscribeAs(appId: string, name: string, heard: JsonValue[] = []): () => void {
    const member = this.bus.open({
      appId,
      deliver: (event, payload) => {
        if (event !== "events.subscribersChanged") heard.push(payload);
      },
    });
    member.subscribe(`${this.manifest.id}:${name}`);
    return () => member.close();
  }

  /** The user clicks a notice the app posted (default: the last one): its action runs as in Pomade —
   *  the tab it opens lands in `openedTabs` and its project becomes active. A notice without an action does nothing. */
  clickNotice(index = this.notices.length - 1): void {
    const notice = this.notices[index];
    if (!notice) throw new Error(`fake host: no notice #${index}`);
    const action = notice.action;
    if (!action) return;
    const { kind, ...params } = action;
    const method = kind === "openFile" ? "tabs.openFile" : kind === "openTerminal" ? "tabs.openTerminal" : "tabs.openApp";
    dispatchTabs(this.data, method, { projectId: this.noticeProjects[index], ...params } as Record<string, unknown>);
  }

  /** The app's own tabs now, in open order (a snapshot). */
  get appTabs(): FakeAppTab[] {
    return this.appTabList.map(publicTab);
  }

  /** Hear every open, focus and route change of the app's own tabs (`appTabChanges`) as it happens —
   *  a browser harness mounts a frame for an opened tab with `{ tabId }`. Returns the unsubscribe. */
  onAppTab(listener: (change: FakeAppTabChange) => void): () => void {
    this.appTabListeners.add(listener);
    return () => this.appTabListeners.delete(listener);
  }

  /** The user opens the app's tab in a project (default the active one) — from the new-tab menu
   *  (no `icon`; at `route`, default `""`) or a strip icon whose action opens a tab — as Pomade
   *  does: an open one is focused (the icon-less one navigated to `route` when given), and the
   *  project becomes active. Returns the tab. */
  openAppTab(open: { projectId?: string; icon?: string; route?: string } = {}): FakeAppTab {
    if (open.icon !== undefined) {
      const icon = this.strip.find((s) => s.id === open.icon);
      if (!icon || icon.action === "panel") throw new Error(`fake host: no strip icon ${JSON.stringify(open.icon)} that opens a tab`);
    }
    const projectId = this.data.project(open.projectId).id;
    return publicTab(this.openOwnTab(projectId, open.icon, open.icon === undefined ? open.route : undefined));
  }

  /** The user renames one of the app's tabs: its title is theirs, and `tabs.setTitle` / `tabs.openApp` `title` no longer change it. */
  renameAppTab(tabId: string, title: string): void {
    const tab = this.appTab(tabId);
    tab.title = title;
    tab.renamed = true;
    this.tabChanged("title", tab);
  }

  /** The user closes one of the app's tabs: it leaves `appTabs` and the frames showing it are closed (`onClose`). */
  closeAppTab(tabId: string): void {
    this.closeTab(this.appTab(tabId));
  }

  /** Pomade's agent tabs now, in tab order (a snapshot). */
  get agentTabs(): AgentTabInfo[] {
    return this.agentTabModel.list();
  }

  /** Every agent tab the app opened (`agentTabs.launch` / `agentTabs.resume`), in order. */
  get openedAgentTabs(): FakeOpenedAgentTab[] {
    return structuredClone(this.agentTabModel.opened);
  }

  /** Every agent tab the app brought to the front (`agentTabs.focus`, or `resume` of a bound session), in order. */
  get focusedAgentTabs(): string[] {
    return [...this.agentTabModel.focused];
  }

  /** The user renames an agent tab: `agentTab.changed` with `titleSource: "user"`. */
  renameAgentTab(tabId: string, title: string): void {
    this.agentTabModel.rename(tabId, title);
  }

  /** Something happened in an agent tab — a session bound, a state change, a move: `agentTab.changed` names what changed. */
  updateAgentTab(tabId: string, patch: Partial<Pick<AgentTabInfo, "sessionId" | "state" | "projectId" | "cwd" | "launchedAt">>): void {
    this.agentTabModel.update(tabId, patch);
  }

  /** An agent tab closes, or its agent hands the shell back: it leaves the list (`agentTab.changed` with `closed`). */
  closeAgentTab(tabId: string, state: AgentTabState = "exited"): void {
    this.agentTabModel.close(tabId, state);
  }

  /** The bus event names the app's frames subscribe to now (each once), `project.changed` and `theme.changed` included. */
  get subscriptions(): string[] {
    const names = new Set<string>();
    for (const frame of this.frames) for (const name of frame.bus?.subscriptions() ?? []) names.add(name);
    return [...names].sort();
  }

  get activeProject(): ProjectRef {
    return { ...this.active };
  }

  /** The badges the app set, by strip icon id; icons without a badge are absent. */
  get badges(): Record<string, FakeBadge> {
    return Object.fromEntries([...this.badgeMap].map(([icon, badge]) => [icon, { ...badge }]));
  }

  /** The app's state as stored, key → value (a snapshot; unset keys are absent). */
  get state(): Record<string, JsonValue> {
    return Object.fromEntries([...this.stateMap].map(([key, text]) => [key, JSON.parse(text) as JsonValue]));
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
        // A socket client has no keyboard: Pomade ignores its keys.
        if (isSocketSurface(frame.target.surface)) return;
        this.keys.push(msg);
        if (frame.target.surface === "overlay" && isPlainEscape(msg)) frame.onClose?.();
        return;
      case "call":
        this.answer(frame, msg);
        return;
      case "response": {
        const pending = this.requests.get(msg.id);
        if (!pending || pending.frame !== frame) return;
        this.requests.delete(msg.id);
        if (!msg.ok) pending.settle({ ok: false, error: msg.error ?? { code: "app-error", message: "malformed response" } });
        else if (isJsonValue(msg.value)) pending.settle({ ok: true, value: msg.value });
        else pending.settle({ ok: false, error: brokerErrors.notJson(this.manifest.id) });
        return;
      }
    }
  }

  private handshake(frame: Frame, appHostApi: number): void {
    frame.watches.clear();
    frame.gitWatches.clear();
    frame.bus?.close();
    frame.bus = null;
    frame.welcomed = false;
    if (appHostApi !== this.hostApi) {
      const reason = appHostApi > this.hostApi ? "needs-newer-pomade" : "app-too-old";
      frame.post({ channel: CHANNEL, type: "reject", reason, hostApi: this.hostApi });
      return;
    }
    frame.welcomed = true;
    // Every frame hears `project.changed` and `theme.changed` (its welcome carries the project and
    // the theme), subscribed or not; a socket client hears only what it subscribes to.
    frame.bus = this.bus.open(
      {
        appId: this.manifest.id,
        deliver: (name, payload) => frame.post({ channel: CHANNEL, type: "event", name, payload } as HostToAppMessage),
      },
      isSocketSurface(frame.target.surface) ? [] : ["project.changed", "theme.changed"],
    );
    frame.post({
      channel: CHANNEL,
      type: "welcome",
      hostApi: this.hostApi,
      pomadeVersion: this.pomadeVersion,
      appId: this.manifest.id,
      ...frame.target,
      project: { ...this.active },
      theme: this.themeNow,
    });
  }

  private answer(frame: Frame, call: IncomingCall): void {
    const fail = (err: unknown): void => {
      if (!(err instanceof CallError)) throw err;
      frame.post({ channel: CHANNEL, type: "result", id: call.id, ok: false, error: { code: err.code, message: err.message } });
    };
    try {
      const value = this.dispatch(frame, call);
      if (value instanceof Promise) {
        value.then((v: unknown) => frame.post({ channel: CHANNEL, type: "result", id: call.id, ok: true, value: v }), fail);
        return;
      }
      frame.post({ channel: CHANNEL, type: "result", id: call.id, ok: true, value });
    } catch (err) {
      fail(err);
    }
  }

  // ── Broker ───────────────────────────────────────────────────────────────

  /** Call the app's own API as another app would (`from`, default the platform) — the request
   *  reaches its server (`api.serve`): the backend when it serves, else the frame that called it last. Rejects with the broker's errors: `app-absent`
   *  when no frame serves, `app-not-responding` on timeout, or the frame's own error. */
  callApi(method: string, params: JsonValue = {}, options: CallApiOptions = {}): Promise<JsonValue> {
    return this.route(options.from ?? PLATFORM_CLIENT_ID, method, params, options.timeoutMs ?? APP_CALL_TIMEOUT_MS);
  }

  private route(from: string, method: string, params: JsonValue, timeoutMs: number): Promise<JsonValue> {
    const id = this.manifest.id;
    if (!(this.manifest.api ?? []).includes(method)) return Promise.reject(asCallError(brokerErrors.unknownMethod(id, method)));
    // The backend when it serves, else the frame that called `api.serve` last (HOST-API §4 `apps`).
    const servers = [...this.frames].filter((f) => f.serving && f.welcomed).reverse();
    const server = servers.find((f) => f.target.surface === "backend") ?? servers[0];
    if (!server) return Promise.reject(asCallError(brokerErrors.notRunning(id)));
    const requestId = `q${this.nextRequestId++}`;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(asCallError(brokerErrors.timeout(id, timeoutMs)));
      }, timeoutMs);
      this.requests.set(requestId, {
        frame: server,
        settle: (outcome) => {
          clearTimeout(timer);
          if (outcome.ok) resolve(outcome.value);
          else reject(asCallError(outcome.error));
        },
      });
      server.post({ channel: CHANNEL, type: "request", id: requestId, from, method, params: structuredClone(params) });
    });
  }

  /** A frame that goes away fails the requests it was answering. */
  private dropRequests(frame: Frame): void {
    for (const [requestId, pending] of [...this.requests]) {
      if (pending.frame !== frame) continue;
      this.requests.delete(requestId);
      pending.settle({ ok: false, error: brokerErrors.gone(this.manifest.id) });
    }
  }

  /** `apps.call` from the app: its own API (served by a frame), or a scripted other app. */
  private async callApp(params: Record<string, unknown>): Promise<JsonValue> {
    const parsed = parseAppCall(params);
    if (!parsed.ok) throw asCallError(parsed.error);
    const { app, method, params: callParams, timeoutMs } = parsed.call;
    const own = this.manifest.id;
    if (app === own) return this.route(own, method, callParams, timeoutMs);
    if (!(this.manifest.calls ?? []).includes(app)) throw asCallError(brokerErrors.notDeclared(own, app));
    const target = this.apps[app];
    if (target === undefined) throw asCallError(brokerErrors.notInstalled(app));
    if (target === "not-responding") {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      throw asCallError(brokerErrors.timeout(app, timeoutMs));
    }
    const handler = Object.hasOwn(target, method) ? target[method] : undefined;
    if (!handler) throw asCallError(brokerErrors.unknownMethod(app, method));
    try {
      const value = await handler(structuredClone(callParams), { from: own });
      if (!isJsonValue(value)) throw asCallError(brokerErrors.notJson(app));
      return structuredClone(value);
    } catch (err) {
      if (err instanceof CallError) throw err;
      if (err instanceof HostError) throw new CallError(err.code, err.message);
      throw new CallError("app-error", err instanceof Error ? err.message : String(err));
    }
  }

  private dispatch(frame: Frame, call: IncomingCall): unknown {
    if (!frame.welcomed) throw new CallError("not-ready", "call before welcome");
    const { method } = call;
    if (!isMethod(method)) throw new CallError("unknown-method", `no method ${JSON.stringify(method)} in Host API v${this.hostApi}`);
    if (isSocketSurface(frame.target.surface) && FRAME_ONLY_METHODS.includes(method)) {
      throw new CallError("capability-denied", `${method} needs an app frame; a backend or a command cannot call it`);
    }
    const capability = METHOD_CAPABILITY[method];
    if (capability && !(this.manifest.capabilities as readonly string[]).includes(capability)) {
      throw new CallError("capability-denied", `${method} needs the "${capability}" capability`);
    }
    // A socket client is in no project: where a call's project is optional, it is the Workspace scope.
    const scoped =
      isSocketSurface(frame.target.surface) && WORKSPACE_DEFAULT_METHODS.includes(method) ? withWorkspaceDefault(call.params) : call.params;
    const params = paramsObject(scoped);
    switch (method) {
      case "host.info":
        return {
          pomadeVersion: this.pomadeVersion,
          hostApi: this.hostApi,
          appId: this.manifest.id,
          ...frame.target,
          skills: (this.manifest.skills ?? []).map((k) => ({ name: k.name, path: `${this.appFolder}/${k.path}` })),
        };
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
      case "strip.setBadge": {
        const { icon, count } = params;
        if (typeof icon !== "string") throw new CallError("invalid-params", '"icon" must be a strip icon id');
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
          throw new CallError("invalid-params", '"count" must be a non-negative integer');
        }
        const urgent = booleanParam(params, "urgent");
        if (!this.strip.some((s) => s.id === icon)) {
          throw new CallError("invalid-params", `No strip icon ${JSON.stringify(icon)} in the manifest`);
        }
        if (count === 0) this.badgeMap.delete(icon);
        else this.badgeMap.set(icon, { count, urgent });
        return {};
      }
      case "files.readFile":
      case "files.create":
      case "files.write":
      case "files.setBody":
      case "files.setField":
      case "files.removeField":
      case "files.setKeyLines":
      case "files.move":
      case "files.delete":
        return dispatchFileWrite(this.data, method, params);
      case "tabs.openFile":
      case "tabs.openTerminal":
      case "tabs.openAttached":
      case "tabs.openApp":
        return dispatchTabs(this.data, method, params);
      case "project.list":
      case "project.getSettings":
      case "project.setSettings":
      case "project.getAgents":
      case "project.setAgents":
        return dispatchProjects(this.data, method, params);
      case "files.symlink":
      case "files.removeSymlink":
        return dispatchSymlinks(this.data, method, params);
      case "files.pickFolder":
      case "files.pickFile":
        return dispatchPick(this.data, method, params);
      case "state.get": {
        const bad = checkStateKey(params.key);
        if (bad) throw new CallError("invalid-params", bad);
        const text = this.stateMap.get(params.key as string);
        return { value: text === undefined ? null : (JSON.parse(text) as JsonValue) };
      }
      case "state.set": {
        const bad = checkStateKey(params.key) ?? checkStateValue(params.value);
        if (bad) throw new CallError("invalid-params", bad);
        const key = params.key as string;
        const value = params.value as JsonValue;
        if (value === null) this.stateMap.delete(key);
        else this.stateMap.set(key, JSON.stringify(value));
        for (const other of this.frames) {
          if (other === frame || !other.welcomed) continue;
          other.post({ channel: CHANNEL, type: "event", name: "state.changed", payload: { key, value: structuredClone(value) } });
        }
        return {};
      }
      case "overlay.open": {
        if (frame.target.surface === "overlay") throw new CallError("invalid-params", "overlay.open is for a tab or a panel frame; an overlay is already open");
        if (frame.hidden) throw new CallError("invalid-params", "overlay.open needs a visible frame: an active tab or the shown panel");
        const route = params.route === undefined ? "" : stringParam(params, "route");
        const heightProblem = params.height === undefined ? null : checkOverlayHeight(params.height);
        if (heightProblem) throw new CallError("invalid-params", heightProblem);
        const anchorProblem = params.anchor === undefined ? null : checkOverlayAnchor(params.anchor);
        if (anchorProblem) throw new CallError("invalid-params", anchorProblem);
        const opened: FakeOpenedOverlay = {
          route,
          ...(params.height !== undefined ? { height: params.height as number } : {}),
          anchor: (params.anchor as OverlayAnchor | undefined) ?? "center",
        };
        this.overlays.push(opened);
        // After the result is posted, like Pomade: the caller hears its answer, then the overlay opens.
        const onOpen = frame.onOverlayOpen;
        if (onOpen) setTimeout(() => onOpen({ ...opened }), 0);
        return {};
      }
      case "overlay.resize": {
        if (frame.target.surface !== "overlay") throw new CallError("invalid-params", "overlay.resize is only for an overlay frame");
        const problem = checkOverlayHeight(params.height);
        if (problem) throw new CallError("invalid-params", problem);
        this.overlayResizes.push(params.height as number);
        frame.onOverlayResize?.(params.height as number);
        return {};
      }
      case "tabs.setRoute": {
        if (frame.target.surface !== "tab") throw new CallError("invalid-params", "tabs.setRoute is only for a tab frame");
        const bad = checkTabRoute(params.route);
        if (bad) throw new CallError("invalid-params", bad);
        this.recordRoute(frame, params.route as string);
        return {};
      }
      case "tabs.setTitle": {
        if (frame.target.surface !== "tab") throw new CallError("invalid-params", "tabs.setTitle is only for a tab frame");
        const bad = checkTabTitle(params.title);
        if (bad) throw new CallError("invalid-params", bad);
        const tab = frame.tab;
        if (tab && !tab.renamed) {
          const title = (params.title as string).trim();
          if (tab.title !== title) {
            tab.title = title;
            tab.appTitled = true;
            this.tabChanged("title", tab);
          }
        }
        return {};
      }
      case "tabs.close": {
        if (frame.target.surface !== "tab") throw new CallError("invalid-params", "tabs.close is only for a tab frame");
        const tab = frame.tab;
        // After the result is posted, like Pomade: the frame hears its answer, then its tab goes away.
        setTimeout(() => {
          if (tab) {
            if (this.appTabList.includes(tab)) this.closeTab(tab);
          } else frame.onClose?.();
        }, 0);
        return {};
      }
      case "overlay.close":
        if (frame.target.surface !== "overlay") throw new CallError("invalid-params", "overlay.close is only for an overlay frame");
        // After the result is posted, like Pomade: the frame hears its answer, then goes away.
        if (frame.onClose) setTimeout(frame.onClose, 0);
        return {};
      case "git.getState":
        return { repos: this.gitScope(this.gitProjectParam(params)) };
      case "git.watch": {
        const projectId = this.gitProjectParam(params);
        const watchId = `w${this.nextWatchId++}`;
        frame.gitWatches.set(watchId, { ...(projectId !== undefined ? { projectId } : {}), seen: JSON.stringify(this.gitScope(projectId)) });
        return { watchId };
      }
      case "git.unwatch":
        frame.gitWatches.delete(stringParam(params, "watchId"));
        return {};
      case "events.publish": {
        const p = checkPublish(this.manifest.events, params);
        if (!p.ok) throw new CallError(p.error.code, p.error.message);
        this.published.push({ name: p.name, payload: structuredClone(p.payload) });
        frame.bus?.publish(p.name, structuredClone(p.payload));
        return {};
      }
      case "events.subscribe": {
        const p = checkSubscribe(this.manifest.events, params);
        if (!p.ok) throw new CallError(p.error.code, p.error.message);
        // A sticky event (`pomade.ready`) follows the result, as in Pomade.
        frame.bus?.subscribe(p.name, (deliver) => setTimeout(deliver, 0));
        return {};
      }
      case "events.unsubscribe": {
        const p = checkUnsubscribe(params);
        if (!p.ok) throw new CallError(p.error.code, p.error.message);
        frame.bus?.unsubscribe(p.name);
        return {};
      }
      case "notices.post": {
        const n = checkNotice(params);
        if (!n.ok) throw new CallError(n.error.code, n.error.message);
        const needs = noticeActionCapability(n.value.action);
        if (needs && !this.manifest.capabilities.includes(needs)) {
          throw new CallError("capability-denied", `a notice that opens a tab needs the "${needs}" capability`);
        }
        this.notices.push(structuredClone(n.value));
        this.noticeProjects.push(isSocketSurface(frame.target.surface) ? WORKSPACE_PROJECT_ID : (frame.tab?.projectId ?? this.active.id));
        return {};
      }
      case "events.hasSubscribers": {
        const p = checkHasSubscribers(this.manifest.events, params);
        if (!p.ok) throw new CallError(p.error.code, p.error.message);
        return { subscribed: this.bus.count(`${this.manifest.id}:${p.name}`) > 0 };
      }
      case "apps.call":
        return this.callApp(params);
      case "agents.liveIn":
        // An app is never the platform: the capability check above refused it.
        throw new CallError("capability-denied", "agents.liveIn is for Pomade's own commands");
      case "agentTabs.list":
      case "agentTabs.setTitle":
      case "agentTabs.focus":
      case "agentTabs.launch":
      case "agentTabs.resume":
        return this.agentTabModel.dispatch(method, scoped);
      case "api.serve": {
        const methods = this.manifest.api ?? [];
        if (methods.length === 0) throw new CallError("capability-denied", 'The manifest declares no "api"');
        frame.serving = true;
        return { methods: [...methods] };
      }
    }
  }

  // ── App tabs ─────────────────────────────────────────────────────────────

  /** The strip icon whose tab renders `route` (action `tab` or `both`), if any. */
  private iconForRoute(route: string): string | undefined {
    return this.strip.find((s) => s.action !== "panel" && s.route === route)?.id;
  }

  /** Open or focus the app's tab for `icon` in `projectId`, as Pomade's tab strip does: an open tab
   *  is navigated to `route` when given (`tabs.openApp`; a strip icon click gives none — a plain
   *  focus); the project becomes active. */
  private openOwnTab(projectId: string, icon: string | undefined, route: string | undefined): AppTabRecord {
    let tab = this.appTabList.find((t) => t.projectId === projectId && t.key === undefined && t.icon === icon);
    const changes: FakeAppTabChange["change"][] = [];
    if (tab) {
      if (route !== undefined && tab.route !== route) {
        tab.route = route;
        changes.push("route");
      }
      changes.push("focus");
    } else {
      const iconRoute = icon === undefined ? undefined : this.strip.find((s) => s.id === icon)?.route;
      tab = {
        tabId: `app-tab-${this.nextAppTab++}`,
        projectId,
        ...(icon !== undefined ? { icon } : {}),
        route: iconRoute ?? route ?? "",
        frames: new Set(),
      };
      this.appTabList.push(tab);
      changes.push("open");
    }
    this.setActiveProject(projectId === WORKSPACE_PROJECT_ID ? null : projectId);
    for (const change of changes) {
      if (change === "route") for (const frame of tab.frames) this.navigateFrame(frame, tab.route);
      this.tabChanged(change, tab);
    }
    return tab;
  }

  /** Open or focus the app's keyed tab for `key` in `projectId`, as Pomade does: a new one at `route`, titled
   *  `title`, else its kind's title, else the app's name; an open one navigated to `route` and retitled to
   *  `title` (unless the user renamed it). The project becomes active. */
  private openKeyedTab(projectId: string, key: string, params: CheckedOpenAppParams): AppTabRecord {
    let tab = this.appTabList.find((t) => t.projectId === projectId && t.key === key);
    const changes: FakeAppTabChange["change"][] = [];
    if (tab) {
      if (tab.route !== params.route) {
        tab.route = params.route;
        changes.push("route");
      }
      if (params.title !== undefined && !tab.renamed && tab.title !== params.title) {
        tab.title = params.title;
        tab.appTitled = true;
        changes.push("title");
      }
      changes.push("focus");
    } else {
      const kind = params.kind === undefined ? undefined : this.manifest.tabKinds?.[params.kind];
      tab = {
        tabId: `app-tab-${this.nextAppTab++}`,
        projectId,
        route: params.route,
        key,
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        title: params.title ?? kind?.title ?? this.manifest.name.trim(),
        appTitled: params.title !== undefined,
        frames: new Set(),
      };
      this.appTabList.push(tab);
      changes.push("open");
    }
    this.setActiveProject(projectId === WORKSPACE_PROJECT_ID ? null : projectId);
    for (const change of changes) {
      if (change === "route") for (const frame of tab.frames) this.navigateFrame(frame, tab.route);
      this.tabChanged(change, tab);
    }
    return tab;
  }

  private appTab(tabId: string): AppTabRecord {
    const tab = this.appTabList.find((t) => t.tabId === tabId);
    if (!tab) throw new Error(`fake host: no app tab ${JSON.stringify(tabId)}`);
    return tab;
  }

  private closeTab(tab: AppTabRecord): void {
    this.appTabList.splice(this.appTabList.indexOf(tab), 1);
    this.tabChanged("close", tab);
    for (const frame of [...tab.frames]) frame.onClose?.();
  }

  /** `tabs.setRoute`: the frame navigated by itself — its route (and its app tab's) is recorded with no
   *  `route.changed` back to it; another frame showing the same tab is navigated there. */
  private recordRoute(frame: Frame, route: string): void {
    frame.target.route = route;
    const tab = frame.tab;
    if (!tab || tab.route === route) return;
    tab.route = route;
    for (const other of tab.frames) if (other !== frame) this.navigateFrame(other, route);
    this.tabChanged("route", tab);
  }

  /** Navigate an app tab and every frame showing it. */
  private navigateTab(tab: AppTabRecord, route: string): void {
    if (route === tab.route) return;
    tab.route = route;
    for (const frame of tab.frames) this.navigateFrame(frame, route);
    this.tabChanged("route", tab);
  }

  private navigateFrame(frame: Frame, route: string): void {
    if (route === frame.target.route) return;
    frame.target.route = route;
    if (this.frames.has(frame) && frame.welcomed) {
      frame.post({ channel: CHANNEL, type: "event", name: "route.changed", payload: { route } });
    }
  }

  private tabChanged(change: FakeAppTabChange["change"], tab: AppTabRecord): void {
    const record = { change, tab: publicTab(tab) };
    this.appTabChanges.push(record);
    for (const listener of [...this.appTabListeners]) listener({ change, tab: publicTab(tab) });
  }

  /** `projectId` of a git call, checked to name a project; absent or the Workspace scope = the workspace. */
  private gitProjectParam(params: Record<string, unknown>): string | undefined {
    if (params.projectId === undefined) return undefined;
    const id = stringParam(params, "projectId");
    if (id === WORKSPACE_PROJECT_ID) return undefined;
    return this.data.project(id).id;
  }

  /** The repos of a git scope; a project that no longer exists has none. */
  private gitScope(projectId: string | undefined): GitRepoState[] {
    if (projectId === undefined) return reposInScope(this.gitRepos, "");
    const project = this.projects.find((p) => p.id === projectId);
    return project ? reposInScope(this.gitRepos, project.root) : [];
  }

  private refreshGitWatches(): void {
    for (const frame of this.frames) {
      if (!frame.welcomed) continue;
      for (const [watchId, watch] of frame.gitWatches) {
        const repos = this.gitScope(watch.projectId);
        const seen = JSON.stringify(repos);
        if (seen === watch.seen) continue;
        watch.seen = seen;
        frame.post({ channel: CHANNEL, type: "event", name: "git.changed", payload: { watchId, repos } });
      }
    }
  }

  /** Normalize a request path and require it to exist. */
  private existing(path: string): string {
    const n = requestPath(path);
    if (this.workspace.kindOf(n) === null) throw new CallError("not-found", `${JSON.stringify(path)} does not exist`);
    return requireAllowedTarget(this.workspace, n);
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

/** `params` with `projectId` defaulted to the Workspace scope; malformed params stay as given (refused later). */
function withWorkspaceDefault(params: unknown): unknown {
  if (params === undefined) return { projectId: WORKSPACE_PROJECT_ID };
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
  return (params as Record<string, unknown>).projectId === undefined ? { ...params, projectId: WORKSPACE_PROJECT_ID } : params;
}

function publicTab(tab: AppTabRecord): FakeAppTab {
  return {
    tabId: tab.tabId,
    projectId: tab.projectId,
    ...(tab.icon !== undefined ? { icon: tab.icon } : {}),
    route: tab.route,
    ...(tab.key !== undefined ? { key: tab.key } : {}),
    ...(tab.kind !== undefined ? { kind: tab.kind } : {}),
    ...(tab.title !== undefined ? { title: tab.title } : {}),
    ...(tab.renamed ? { renamed: true } : {}),
  };
}

function asCallError(error: ErrorPayload): CallError {
  return new CallError(error.code, error.message);
}
