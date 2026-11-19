# pomade-kit

Shared library for the Pomade family: the app SDK (Host API client, types, fake host) and shared
pure logic.

Part of the Pomade family — the platform and its rules live in the sibling repo `Pomade`
(`docs/PLATFORM.md`); the protocol is `Pomade/docs/HOST-API.md`. Backlog: `docs/BACKLOG.md`.

## Install

```sh
npm install github:dd-voronov/pomade-kit#v0.1.0
```

The package installs from a git tag: npm clones it, installs its dev dependencies and builds
`dist/` through the `prepare` script. ESM only, with TypeScript declarations.

| Import | What | Runs in |
|---|---|---|
| `pomade-kit/protocol` | Host API v0 in code: messages, `ProjectRef`, `FileEntry`, `FileChange`, error codes, `Manifest` + `parseManifest`, strip icons (`StripIcon`, `resolveFrameTarget`), shortcuts (`AppShortcut`, `parseChord`, `formatChord`, `chordMatches`), app state rules, the event bus (`PLATFORM_EVENTS`, event name and payload rules, `parseManifestEvents`, the `EventBus` both hosts run), `HOST_API_VERSION`, message guards, workspace path rules, `readFrontmatter` | browser and Node |
| `pomade-kit/sdk` | `connect()` and the typed client | browser (any `Transport` elsewhere) |
| `pomade-kit/fake-host` | the Host API in memory, for standalone runs and tests | browser and Node |
| `pomade-kit/frontmatter` | field-only frontmatter writes: `setField`, `removeField`, body writes `setBody` / `getBody`, and the block core Pomade's editor uses | browser and Node |
| `pomade-kit/schedule` | the schedule format: `parseSchedule` with readable errors, the occurrence engine, `describeSchedule`, `formatSchedule` | browser and Node |
| `pomade-kit/dates` | date phrases: `parseDatePhrase` (`fri`, `tomorrow`, `+3d`, `nov 20`, `tonight 23:00`, `in 2 hours`) and `currentDay` with a day boundary | browser and Node |
| `pomade-kit/scanners` | terminal output readers: `MarkerScanner` (Pomade's shell markers), `AttentionScanner` (bell, notifications), `AgentStateScanner` (claude/codex working, idle, waiting at a permission or trust prompt) | browser and Node |
| `pomade-kit/node` | the Host API over Pomade's socket for backends and commands (`connectSocket`, `stayConnected`, `launchPomade`), `resolveWorkspace()`; `postNotice()` — a notice from a backend or command, with Pomade open or closed; the attach protocol's client (`connectKeeper`, `followSession`, `startKeeper`) | Node |
| `pomade-kit/keeper` | the keeper: holds an app's terminal sessions so they outlive Pomade, and serves the attach protocol (`runKeeper`). Needs `node-pty` (a peer dependency) | Node |

## Connect to Pomade

```ts
import { connect, HostError } from "pomade-kit/sdk";

const result = await connect();                 // never throws
if (result.status === "no-host") showNoHost();  // opened outside Pomade (no answer in 1500 ms)
else if (result.status === "rejected") {
  // "needs-newer-pomade": this Pomade is too old; "app-too-old": the app needs an update
  showRejected(result.reason);
} else {
  const host = result.host;
  host.welcome.project;                         // the project the frame was opened in
  const { surface, icon, route } = host.welcome; // what the frame was opened for — render `route`
  await host.info();                            // { pomadeVersion, hostApi, appId, surface, icon?, route, skills }
  await host.project.getActive();               // ProjectRef; the Workspace scope when none
  const off = host.project.onChange((project) => { /* switch */ });

  const { entries } = await host.files.readFolder({ path: "Projects/x/docs/roadmap", recursive: true, frontmatter: true });
  // each Markdown entry: frontmatter (null = no block) or frontmatterError (invalid YAML, not a mapping, an unclosed --- block)
  const watch = await host.files.watch({ path: "Projects/x/docs/roadmap", recursive: true }, (changes) => {
    /* FileChange[] — one batch */
  });
  await watch.close();

  await host.strip.setBadge({ icon: "board", count: 3, urgent: true });   // count 0 clears it

  // files.read / files.write (see "Read and write files" below)
  const { content } = await host.files.readFile({ path: "Projects/x/docs/roadmap/T-1.md" });
  await host.files.setField({ path: "Projects/x/docs/roadmap/T-1.md", key: "status", value: "done" });

  await host.state.set("view.alpha", "board");  // any JSON value; null removes the key
  await host.state.get("view.alpha");           // "board"; null when unset
  host.state.onChange((key, value) => { /* another frame of this app set it */ });

  await host.tabs.openApp({ route: "planner/today" });               // open or focus own tab at a route
  await host.tabs.openApp({ route: "board", projectId: "<project id>" }); // …in another project (switches to it)
  host.onRouteChange((route) => { /* Pomade navigated this tab: render `route` */ });

  try {
    await host.files.readFolder({ path: "../outside" });
  } catch (err) {
    if (err instanceof HostError) err.code;     // "outside-workspace"
  }
}
```

- Paths are workspace-relative; join a project's root with your own path:
  `joinPath(project.root, "docs/roadmap")` from `pomade-kit/protocol`.
- After `welcome` the client forwards every unhandled (`defaultPrevented === false`) Cmd/Ctrl
  keydown to Pomade (a modifier key pressed alone is not forwarded), so Pomade's shortcuts keep
  working while the app has focus. The decision
  waits one task, so any keydown handler of the app can still claim a key with
  `preventDefault()`. `connect({ keySource: null })` turns it off.
- One bundle serves every surface. `surface` is `"tab"`, `"panel"` or `"overlay"`; `icon` is the manifest
  `strip` icon the frame was opened for (absent for a tab from the new-tab menu); `route` is that
  icon's `route` on a tab, its `panelRoute` (else `route`) on a panel, `""` without an icon.
- `host.strip.setBadge` badges one of the app's own strip icons from any of its frames; an icon
  the manifest does not declare is `invalid-params`. Pomade clears an app's badges when its frames
  reload; the app sets them again.
- `host.state` is the app's machine-local state (`<userData>/app-state/<id>/` in Pomade), one
  store shared by all of the app's frames — tab, panel, overlay. Keys are non-empty strings of at
  most 200 characters (`STATE_KEY_MAX_LENGTH`); values are plain JSON (`JsonValue`; finite
  numbers, plain objects, nesting ≤ 64) of at most 1 MiB as JSON. A `set` is written atomically
  before it resolves; every *other* frame of the app then gets `state.changed` (`onChange`), so a
  panel sees what the overlay stored without re-reading. `checkStateKey` / `checkStateValue` /
  `isJsonValue` (`pomade-kit/protocol`) are the rules both hosts apply.
- `host.tabs.openApp({ route?, projectId? })` opens or focuses the app's own tab at `route`
  (default `""`) in `projectId` (a `ProjectRef.id`, the Workspace scope included; default the active
  project; an unknown id is `not-found`), and brings the user there. A route equal to a strip
  icon's `route` (an icon with action `tab` or `both`) is that icon's tab; any other route is the
  app's one icon-less tab, navigated to the route. A frame already showing that tab gets
  `route.changed` (`host.onRouteChange`); `host.welcome.route` stays the route the frame opened
  with, `host.info()` answers the current one.
- `host.close()` detaches the client: no more events, pending calls reject.

## Read and write files

Capabilities: `files.read` for `readFile`, `files.write` for every write. Paths are
workspace-relative and name an entry below the root.

```ts
await host.files.readFile({ path });                       // { content, size, mtimeMs } — UTF-8 text
await host.files.readFile({ path, frontmatter: true });    // + { frontmatter } or { frontmatterError } (Markdown files)
await host.files.setField({ path, key: "status", value: "done" });   // { changed }
await host.files.setField({ path, key: "tags", value: ["a", "b"] }); // value: string | number | boolean | null | string[]
await host.files.removeField({ path, key: "parked" });     // { changed }
await host.files.setKeyLines({ path, key: "repeat", text: formatSchedule("repeat", schedule) });   // { changed } — a mapping
await host.files.setField({ path, key: "status", value: "done", ifMtime: read.mtimeMs });   // every write takes ifMtime
await host.files.setBody({ path, body: "New body\n" });    // { changed } — the frontmatter block's bytes stay
await host.files.create({ path: "Projects/x/docs/roadmap/T-9.md", content: "---\nid: T-9\n---\n" });
await host.files.write({ path, content });                 // replace an existing file's text
await host.files.move({ from: path, to: "Projects/x/docs/roadmap/done/T-1.md" });   // move or rename
const results = await host.files.delete([path, "Projects/x/docs/roadmap/T-2.md"]);  // to the Trash
// [{ path, ok: true }, { path: "Projects/x/docs/roadmap/T-2.md", ok: false, error: { code: "not-found", message } }]
```

- `setField` / `removeField` are the kit's own `setField` / `removeField` run by the host on the
  file: only the key's lines change, every other byte stays (see "Write one frontmatter field").
  `setBody` keeps the frontmatter block and the blank lines after it, and replaces the rest.
  `changed: false` = the bytes were identical; nothing was written and no watch event fires.
- `setKeyLines` writes one key as its own YAML lines, verbatim — for a value `setField` does not
  take (a mapping, a list of mappings, a block scalar): `text` is `key:` at column 0 plus indented
  lines, as `formatSchedule` returns it. It replaces the key's lines (or appends them at the end of
  the block) and every other byte stays (the kit's `setKeyLines`). `text` that is not exactly that
  key's lines as valid YAML is `invalid-params`.
- `ifMtime` (on `write`, `setBody`, `setField`, `removeField`, `setKeyLines`): the `mtimeMs` the app
  read. When the file's mtime differs at the moment of the write, nothing is written and the call
  fails with `changed-on-disk` — a Board drag or a Planner tick never lands on a file an agent
  rewrote since the read. Pomade checks it immediately before the atomic rename, under its own
  per-file write lock (HOST-API §4 "Conditional writes").
- `readFile({ frontmatter: true })` adds the file's frontmatter record exactly as `readFolder`
  reports it (Markdown files only), from the same read as `content` and `mtimeMs`.
- `create` makes missing parent folders and refuses a taken path (`already-exists`); `write` needs
  an existing file (`not-found`); `move` creates missing parent folders and refuses a taken `to`
  (`already-exists`).
- `delete(paths)` moves files to the macOS Trash (Finder can put them back) and resolves with one
  `{ path, ok, error? }` per path, in order (`path` as passed). Each path fails only its own entry:
  `not-found`, `invalid-params` (a folder, the root), `capability-denied` (`.pomade`),
  `outside-workspace`, `io-error`; the others still go. A symlink goes as the link itself. Only a
  `paths` that is not a list of strings, or longer than `FILES_DELETE_MAX_PATHS` (1000), rejects the
  call (`invalid-params`). Watches hear each delete; a file open in Pomade keeps its buffer and says
  it no longer exists on disk.
- Refusals are `HostError`s: `unreadable-frontmatter` (invalid YAML or an unclosed `---` — nothing is
  written), `unsupported-key`, `changed-on-disk` (`ifMtime`), `invalid-params`, `outside-workspace` (also for a write that would
  leave the workspace through a symlink), `not-found`, `io-error`.
- The workspace's `.pomade` folder (Pomade's own config and state) is out of reach: every path a
  method takes — read, list, watch, write, both ends of a move, a symlink's location and target,
  a picked folder, a file to open — is refused with `capability-denied` when it is at or inside
  `.pomade`, by the path given and by its real path (a symlink into `.pomade` is refused too).
  Listings leave it out and watches never report it. `isPomadeFolderPath(path)` in
  `pomade-kit/protocol` is the rule.
- Pomade's editor treats an app's write like any outside write: a doc open with unsaved edits
  shows "File changed since your edits" and nothing is overwritten.

## Projects

```ts
const { workspace, groups, projects } = await host.project.list();   // sidebar order
projects[0];   // { id, kind: "project", name, root, groupId, groupPath: ["Building tools", "Tools"] }
groups[0];     // { id, name, parentId, path: ["Building tools"] }
```

Project ids are stable: renames, moves and regrouping keep them, so store ids and look names and
roots up with `project.list()` / `project.getActive()`. `project.onChange` fires when the user
switches project or picks the sidebar's Workspace item (`kind: "workspace"`, root `""`), and when
the active project is renamed or moved.

**Per-project settings and agents** (`project.read` to read, `project.write` to change):

```ts
const { settings } = await host.project.getSettings({ projectId });          // this app's own; {} when none
await host.project.setSettings({ projectId, settings: { backlog: "docs/roadmap", view: null } });  // merge; null removes
const { visibleAgents } = await host.project.getAgents({ projectId });       // ["*"] = every agent
await host.project.setAgents({ projectId, visibleAgents: ["claude", "claude-coder"] });
```

Settings are plain JSON (`JsonValue`), at most 64 KiB per app per project
(`PROJECT_SETTINGS_MAX_BYTES`); each app sees only its own. They live with the project in Pomade's
workspace config, so they follow renames and moves. The Workspace scope (`"__workspace__"`) has no
settings and offers every agent. `pomade-kit/protocol` exports the shared checks: `jsonProblem`,
`mergeProjectSettings`, `settingsSizeProblem`, `normalizeVisibleAgents`.

To follow a project's group, visible agents and settings as they change — in Pomade's sidebar,
from another app or from this one — subscribe to `project.updated` (declared in the manifest's
`events.subscribe`):

```ts
await host.events.subscribe("project.updated", ({ project, changes }) => {
  if (changes.includes("group")) showGroup(project.groupPath);          // project is a ProjectInfo
  if (changes.includes("agents")) void host.project.getAgents({ projectId: project.id }).then(showAgents);
  if (changes.includes("settings")) void reloadSettings(project.id);    // this app's own settings only
});
```

## Choose a folder

```ts
const { path } = await host.files.pickFolder({ root: project.id, initial: "Projects/x/docs" });  // files.read
if (path !== null) save(path);   // workspace-relative; null = cancelled
```

Pomade opens its native folder dialog at `initial` (when it is inside the root, else at the
root). `root` is a project id — absent or `"__workspace__"` for the whole workspace. A folder
outside the root is refused in the dialog, which opens again until the user picks one inside or
cancels.

## Symlinks

Capability `files.symlink`, plus the folders in the manifest:

```jsonc
{ "capabilities": ["files.symlink"], "symlinks": ["Projects/*/links"] }   // "*" = any one folder name
```

```ts
await host.files.symlink({ path: "Projects/alpha/links/spec", target: "Knowledge/specs/alpha" });
await host.files.removeSymlink({ path: "Projects/alpha/links/spec" });   // the link only, never its target
```

The link must sit directly in a declared folder, reached without passing through a symlinked
folder (`capability-denied` otherwise); missing folders are created; the link is written
relative. A taken path is `already-exists`, a missing target `not-found`; `removeSymlink` on
anything that is not a link is `invalid-params`. `symlinkScopeCovers(scopes, path)` in
`pomade-kit/protocol` is the rule both hosts apply.

## Open tabs

Capability `tabs.open`. The tab opens right of the active tab of `projectId`'s tab strip (default
the active project; `"__workspace__"` = the Workspace scope), and Pomade switches to that project.

```ts
await host.tabs.openFile({ path: "Projects/x/docs/roadmap/T-1.md" });           // focuses it when already open
await host.tabs.openTerminal({ cwd: "Projects/coda", command: "npm run dev", title: "Coda web" });
await host.tabs.openTerminal({ cwd: "", projectId: "__workspace__" });          // a plain shell at the root
```

`command` is one line, typed and run once the shell is ready (Relaunch runs it again); `title`
names the tab (default: the command). A missing path or folder is `not-found`, a folder passed as a
file (or the reverse) `io-error`, an unknown project `not-found`.

```ts
await host.tabs.openAttached({ session: { app: "pomade-runner", session: "svc:coda-web" } });   // any app's session
await host.tabs.openAttached({ session: { app: "hello", session: "ticker" }, title: "Ticker", projectId: "p1" });
```

`openAttached` opens (or focuses) a terminal tab attached to a session an app's keeper holds
("Attached terminals" below), by reference — the owning app is not asked. `title` replaces the
session's own; the tab shows the owner's name after it ("Coda web · Runner"). A malformed reference
is `invalid-params`.

## Agent tabs

Pomade's agent tabs (pomade:E-033; HOST-API §4 `agentTabs`): the session bound to each, its title,
what the agent is doing — and focus, launch, resume.

```ts
const tabs = await host.agentTabs.list({ projectId: "p1" });   // AgentTabInfo[] (agentTabs.read)
// { tabId, projectId, agentId, cwd /* absolute, the session-store key */, launchedAt, sessionId | null,
//   title, titleSource: "default" | "user" | "app", unnamed, state: "working" | "needs-you" | "idle" | "exited" }
await host.agentTabs.setTitle(tabs[0].tabId, "G4 tickets");     // agentTabs.write
await host.agentTabs.setTitle(tabs[0].tabId, null);             // the session is unnamed: italic default title + dot
await host.agentTabs.focus(tabs[0].tabId);                      // tabs.open
const { tabId } = await host.agentTabs.launch({ agentId: "claude-pm", projectId: "p1", mode: "full-autonomy", prompt: "Triage the inbox" });
await host.agentTabs.resume({ agentId: "claude", sessionId: "5f0c…", projectId: "p1" });  // focuses a live tab already on it
await host.events.subscribe("agentTab.changed", ({ tab, changes }) => { /* opened · closed · session · title · state · project */ });
```

Inside a Pomade terminal `POMADE_TAB_ID` names the tab, so a command finds its own tab in the list.
An agents app serves Pomade's roster as `roster.list` (`RosterListResult`, `checkRosterList`,
`providerModes`); Pomade falls back to its own scan when the app is absent or not answering.

It also answers Pomade's questions about sessions (pomade:E-043; `SESSIONS_APP_ID`):

```ts
// sessions.forRepo — the Git panel's branch ↔ session link: sessions started at or below a
// repository / worktree folder, optionally on one branch. Newest activity first.
{ folder: "/ws/Projects/app/.claude/worktrees/t1", branch?: "agent/t1" }
  → { sessions: RepoSession[] }   // { id, agent, name | null, status, live, cwd, branch | null, project | null, startedAt, lastActiveAt }
// sessions.liveIn — "is an agent live here?" (merge blocking, pomade-git's skip): agent tabs
// (prompted or not) and Runner runs at or below the folder.
{ folder: "/ws/Projects/app" } → { live: boolean, sessions: LiveSession[] }   // { sessionId | null, agent, cwd, source: "tab" | "run", job | null }
```

`checkRepoSessions` drops a malformed session (a malformed answer is no answer: no link);
`checkLiveIn` refuses a malformed answer whole, and Pomade answers from its own terminals.

## Git state

Capability `git.read`. Pomade serves its own git snapshot — the one its file tree and sidebar
show — so a read runs no git command.

```ts
const { repos } = await host.git.getState();                          // every repo, sorted by root
const mine = await host.git.getState({ projectId: project.id });      // the project's repos
const watch = await host.git.watch({ projectId: project.id }, (repos) => render(repos));
await watch.close();
```

Each `GitRepoState`: `name` (the folder name the Git panel shows — the name `pomade-git` accepts),
`root` (workspace-relative, `""` = the workspace root), `absPath` (absolute), `remoteUrl` (the
upstream's remote, else `origin`, else the first remote; `null` = local only), `branch` (`null` when detached), `upstream` (`null` when the branch
tracks nothing), `ahead` / `behind` (0 without an upstream), `hasCommits`, `changes` (`{ path,
status, from?, dir? }` — `modified` · `new` · `conflict` · `renamed` · `deleted`; `dir: true` = an
untracked folder as one entry), and `error` when the repo could not be read.

A project's repos are the repos at or below its folder plus the nearest repo holding the folder
(`gitReposInScope(repos, root)` in `pomade-kit/protocol`); absent `projectId` or `"__workspace__"`
= every repo. A watch delivers the scope's repos whenever they change (`git.changed`), follows a
project that moves, and ends with the frame (a reload drops it). An unknown project is
`not-found`.

### `pomade-git` runs and scheduled jobs

Pomade's `pomade-git` command prints `GitRunOutput` with `--json` (`{ op, job, at, results:
GitRunResult[] }`; each result `{ repo, path, op, status: "done" | "skipped" | "failed", reason,
steps, commit }`; `isGitRunOutput` / `isGitRunResult` check one). A scheduler that targets repos
serves `jobs.forRepo` (`REPO_JOBS_APP_ID` = `pomade-runner`, `REPO_JOBS_METHOD`): `{ repo: { name,
path } }` → `{ jobs: RepoJob[] }` (`{ id, name, operation, schedule, nextRun, lastResult, route }`);
Pomade's repo row reads it through the broker, `checkRepoJobs` drops a malformed job, and no
answer means no row.

## Events

The event bus (`pomade:E-031`). Pomade and apps publish; apps subscribe; a publisher can ask whether
anyone listens. Declare both sides in the manifest — a call on an undeclared name is
`capability-denied`, a malformed one `invalid-params`:

```jsonc
"events": {
  "publish": ["run.started", "run.finished"],                        // your own events, unqualified
  "subscribe": ["pomade.ready", "project.renamed", "pomade-agents:session.closed"]
}
```

```ts
const sub = await host.events.subscribe("project.renamed", ({ project, previous }) => { /* … */ });
await host.events.subscribe("pomade-agents:session.closed", (payload) => { /* JsonValue */ });
await sub.close();                                  // the host subscription ends with its last handler

if (await host.events.hasSubscribers("run.finished")) {
  await host.events.publish("run.finished", { runId: "r1", ok: true });   // plain JSON ≤ 64 KiB; default null
}
host.events.onSubscribersChange((name, subscribed) => { /* first subscriber came / last one left */ });
```

**Platform events** (`PLATFORM_EVENTS`, payloads typed by `PlatformEvents`):

| Event | Payload | When |
|---|---|---|
| `pomade.ready` | `{}` | Pomade restored the workspace's tabs. Sticky: a later subscription gets it at once |
| `project.created` | `ProjectRef` | a project was added |
| `project.renamed` | `{ project, previous }` (`ProjectRef`s) | a project's name or folder changed |
| `project.opened` | `ProjectRef` | a project (or the Workspace scope) became active for the first time since Pomade started |
| `project.changed` | `ProjectRef` | the active project changed; every frame gets it without subscribing |
| `project.updated` | `{ project: ProjectInfo, changes }` — `changes` ⊆ `"group"` · `"agents"` · `"settings"` (`PROJECT_CHANGES` order) | a project moved to another group or its group path changed, its visible agents changed, or the app's own settings for it changed. `settings` goes **only to the app whose settings changed**; a write by the app itself is heard too |
| `agentTab.exited` | `{ tabId, projectId, agentId, sessionId \| null, reason }` | an agent process in a tab ended — `reason` `exit` · `crash` · `tab-closed` · `quit` |
| `attachedTab.action` | `{ session: { app, session }, action, projectId }` | a person clicked a header action the app contributed on an attached tab; delivered **only to the app that owns the session** (`EventBus.publishTo`) |

**App events** travel as `<appId>:<event>` (`pomade-runner:run.finished`); an event name is
dot-separated lowerCamel words (`EVENT_NAME_RE`, at most 64 characters). A published event reaches
every subscribed frame of every app — hidden ones too — except the publishing frame itself.
Subscriptions end with the frame (a reload subscribes again). `EventBus` (`pomade-kit/protocol`)
is the bookkeeping Pomade and the fake host share; `checkPublish` / `checkSubscribe` /
`checkHasSubscribers` are their call checks.

## Notices

`pomade:E-032`. A notice shows as a toast in Pomade and stays in its Notices list; a click runs its
action. No capability, except that an action opening a file or a terminal needs `tabs.open`.

```ts
await host.notices.post({
  title: "Run failed",                           // one line, ≤ 200 characters
  body: "Nightly commit-push: conflict in Knowledge",   // optional, ≤ 2000
  action: { kind: "openApp", route: "runs/r42" },       // optional: what a click does
});
// action kinds: { kind: "openApp", route?, projectId? } — your own tab, exactly tabs.openApp
//               { kind: "openFile", path, projectId? } · { kind: "openTerminal", cwd, command?, title?, projectId? }
```

Pomade coalesces a burst from one app into one toast ("4 more from Runner"), and the user can mute
an app's notices (they still land in the list). `checkNotice` (`pomade-kit/protocol`) is the rule
every host applies.

**From a backend or a command** — with Pomade open or closed:

```ts
import { postNotice } from "pomade-kit/node";
const r = await postNotice({ title: "Commit & push failed", body: "Knowledge: conflict" }, { source: "pomade-git" });
r.delivered;                                    // "pomade" (shown now) | "queue" (r.path: the queued file)
```

With Pomade running it sends `notices.post` over the socket — over `options.host` (a connected
client) or a short connection made with the identity in the environment (`POMADE_APP_ID`, …). With
Pomade closed, or no identity configured, it writes one JSON file into `<userData>/notices/queue/`
(a dot-file renamed into place); Pomade drains the folder at launch and watches it while running. `source` is the app's id (or the
platform command's name); the target is the dev Pomade unless `stable: true`, and
`POMADE_USER_DATA` overrides both (`pomadeUserData()`). The file format is `QueuedNotice`
(`parseQueuedNotice`, `NOTICE_QUEUE_DIR`, `queuedNoticeFileName` in `pomade-kit/protocol`).

## Develop and test without Pomade — the fake host

```ts
import { createFakeHost } from "pomade-kit/fake-host";
import { connect } from "pomade-kit/sdk";
import manifest from "./public/manifest.json" with { type: "json" };

const fake = createFakeHost({
  manifest,                                     // sets the app id and the granted capabilities
  groups: [{ id: "tools", name: "Tools" }],      // optional; `parent` nests a group
  projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha", group: "tools",
              settings: { backlog: "docs/roadmap" }, visibleAgents: ["claude"] }],   // both optional
  activeProject: "alpha",                       // omit for the Workspace scope
  files: { "Projects/alpha/docs/roadmap/E-001-x.md": "---\nid: E-001\nstatus: planned\n---\n" },
  git: [{ name: "alpha", root: "Projects/alpha", absPath: "/Users/me/ws/Projects/alpha",
          remoteUrl: "git@github.com:me/alpha.git", branch: "main", upstream: "origin/main",
          ahead: 1, behind: 0, hasCommits: true, changes: [] }],               // optional; git.getState's repos
});

const result = await connect({ transport: fake.transport });   // in-process
```

It implements all of HOST-API v0 with the same messages: frontmatter exactly as Pomade reads it
(js-yaml `JSON_SCHEMA` with non-finite numbers kept as their source text, Pomade's editor block
detection), the Workspace scope as `WORKSPACE_PROJECT_ID` (`"__workspace__"`), Pomade's default tree ignore list
(`.git`, `node_modules`, `.DS_Store`; `ignore` option), the manifest's capabilities, every error
code, and the events. Test controls emit the events Pomade would:

| Control | Emits |
|---|---|
| `fake.writeFile(path, content)` | `create` (and one per new parent folder) or `change` |
| `fake.deleteFile(path)` | `delete` |
| `fake.rename(from, to)` | `rename` (file or folder) |
| `fake.batch(() => …)` | the changes inside as one `files.changed` per watch |
| `fake.setActiveProject(id \| null)` | `project.changed` |
| `fake.updateProject(id, { name?, root?, group?, visibleAgents? })` | `project.renamed` to its subscribers when the name or folder changed, `project.updated` when the group or the visible agents changed, and `project.changed` when it is the active project and its name or folder changed (the id stays) |
| `fake.clickNotice(index?)` | — (the user clicks a notice the app posted, default the last: its action runs as in Pomade, landing in `openedTabs`). `fake.notices` lists every `notices.post`, normalized |
| `fake.ready()` | `pomade.ready` (sticky: later subscriptions get it at once) |
| `fake.renameAgentTab(tabId, title)` / `fake.updateAgentTab(tabId, { sessionId?, state?, projectId?, … })` / `fake.closeAgentTab(tabId)` | `agentTab.changed` naming what changed (the user renamed it; a session bound, a state change, a move; it left the list). Seed tabs with `agentTabs`, the launchable roster with `roster` (default claude, codex), resumable sessions with `sessions`; `fake.agentTabs`, `fake.openedAgentTabs`, `fake.focusedAgentTabs` record what happened |
| `fake.emitEvent(name, payload)` | a platform event or another app's `<appId>:<event>` to the frames subscribed to it |
| `fake.subscribeAs(appId, name, heard?)` | — (another app subscribes to this app's event `name`: `hasSubscribers` turns true and `events.subscribersChanged` fires; what it hears is pushed to `heard`; returns its unsubscribe). `fake.published` lists every `events.publish` (`{ name, payload }`), `fake.subscriptions` the names the frames subscribe to |
| `fake.readFile(path)` | — (returns the file's text: what the app's writes left) |
| `fake.symlink(path, target)` | `create` (a link listings report as its target's kind) |
| `fake.isSymlink(path)` | — (true when a symlink is at `path`) |
| `fake.answerPick(path \| null)` | — (queues the user's next folder-picker choice; a folder outside the root is refused and the next answer used; none left = cancel). `fake.pickRequests` logs `{ root, initial }` per picker |
| `fake.setGitRepos(repos)` | `git.changed` to each git watch whose scope's repos changed |
| `fake.openedTabs` | — (every `tabs.openFile` / `openTerminal` / `openApp`, in order: `{ kind: "file", projectId, path }` · `{ kind: "terminal", projectId, cwd, command?, title? }` · `{ kind: "app", projectId, route }`; the call switches the active project like Pomade) |
| `fake.overlays` | — (every `overlay.open`, in order: `{ route, height?, anchor }` — `height` as given, absent when none; `anchor` `"center"` when none) |
| `fake.overlayResizes` | — (every height an overlay frame asked for with `overlay.resize`, in order, as given) |

A frame opened with `attach(post, { route })` / `mountApp(fake, { src, route })` starts at that route,
and `connection.navigate(route)` / `mounted.navigate(route)` sends `route.changed` as Pomade
does. `createFakeHost({ state: { pins: ["a"] } })` seeds the app state and `fake.state` reads it back
(a snapshot; unset keys are absent); `fake.keys` lists the forwarded keys; `fake.badges` holds the badges the app set
(`{ board: { count: 3, urgent: true } }`; a cleared icon is absent); `fake.createTransport()` gives
another frame; `createFakeHost({ hostApi: 1 })` makes the handshake reject.

A frame opens as a tab from the new-tab menu by default. Open it for a strip icon or as a panel
with `fake.createTransport({ surface: "panel", icon: "board" })` (also `fake.attach(post, open)`
and `mountApp(fake, { src, surface, icon })`); `welcome` and `host.info` then carry the icon and
its resolved route, exactly as Pomade resolves them. An icon the manifest does not declare opens
the default view (no icon, route `""`).

**Browser e2e (Playwright):** a harness page creates the fake host, puts it on `window` for the
specs, and hosts the app's page in an iframe with `mountApp(fake, { src: appUrl })` — the app
runs unchanged, as inside Pomade. Working setup: `e2e/harness/` and `e2e/hello.spec.ts`, run by
`playwright.config.ts` (the built app served on one origin, the harness on another).

**`dev:fake`:** serve such a harness page with a fixture workspace from the app's own Vite dev
server, with `?app=` pointing at the app's page — a standalone app with live, scriptable data.

## Validate a manifest

```ts
import { parseManifest } from "pomade-kit/protocol";

const r = parseManifest(JSON.parse(text));
if (r.ok) r.manifest.strip;                     // StripIcon[] | undefined; routes defaulted to ""
else r.errors;                                  // every invalid field: [{ field: "strip[1].action", message }]
```

A failed result lists every invalid field in `errors` (`field` is a path: `"id"`, `"strip"`,
`"strip[1].action"`; `""` when the manifest is not an object); its `field` and `message` are the
first error's. Messages name the field and the value received (`(got "popup")`, `(missing)`).
Strip icon rules follow HOST-API §1: `id` matches `^[a-z][a-z0-9-]{0,31}$` and is unique (a repeat
is reported on the later icon), `title` is non-empty (kept trimmed), `action` is `panel`, `tab` or
`both`, `route` defaults to `""`, `panelRoute` only with `both`; other keys inside an icon are
ignored. `resolveFrameTarget(strip, surface, icon)` is the route rule `welcome` uses.

`shortcuts` declares the app's Pomade-wide shortcuts — they work from any tab, terminal and editor
included, and from inside any app frame:

```jsonc
"shortcuts": [
  { "id": "today", "title": "Open Today", "key": "Cmd+Shift+Y", "action": "tab", "route": "today" }
]
```

`id` matches `^[a-z][a-z0-9-]{0,31}$` and is unique; `title` is non-empty (kept trimmed); `key` is a
chord — `Cmd`, then any of `Ctrl`, `Alt`, `Shift`, then one letter or digit (`parseChord`,
case-insensitive; kept in its canonical spelling `formatChord`: `Cmd+Ctrl+Alt+Shift+K`) — unique
within the app; `action` `"tab"` opens or focuses the app's tab at `route` (default `""`) in the
active project, exactly like `host.tabs.openApp({ route })`; `action` `"overlay"` opens a small
frame of the app (about 420×220) centred over whatever tab is active — even when the app was never
opened — on `surface: "overlay"` at `route` (a quick-add form). It closes on Escape (the SDK
forwards an unhandled plain Escape from an overlay frame) or on `host.overlay.close()`, and focus
returns exactly where it was; the next press opens a fresh frame. Keep anything it must remember
in `host.state`. Pomade matches the physical key
(`chordMatches`), so a chord works under any keyboard layout. A chord Pomade itself uses, or one
another app took first, is reported at install and does nothing — Pomade wins. In the fake host a
`tab` shortcut's target is a frame opened at its route: `fake.createTransport({ route })`; an
overlay is `fake.createTransport({ surface: "overlay", shortcut: "quick-add", onClose })` (or
`mountApp(fake, { src, surface: "overlay", shortcut })`, which removes the frame when it closes) —
`onClose` runs after `overlay.close` is answered, or on a forwarded Escape.

The app's own tab or panel frame opens the same overlay with `host.overlay.open({ route, height?, anchor? })`
(route default `""`; no overlay shortcut needed) — the Planner panel's **+**. Only while that frame is
shown (the active tab, the shown panel): a hidden frame's call, and an overlay frame's, reject with
`invalid-params`; over the socket it is `capability-denied`. Every call opens a fresh overlay frame
at its route, replacing any open one. When it closes Pomade gives focus back to the frame that called
`overlay.open` (not to whatever frame had focus before it), and the SDK puts it on the element that had it before the
call (the button). In the fake host a frame opened with `{ hidden: true }` (or hidden later:
`connection.setHidden(true)` / `mounted.setHidden(true)`) is refused, and `fake.overlays` records each
open's `{ route, height?, anchor }`.

The frame is 420 px wide and 220 px high (`OVERLAY_WIDTH`, `OVERLAY_DEFAULT_HEIGHT`). The app sizes the
height — `height` in `overlay.open`, or `host.overlay.resize({ height })` from the overlay frame as its
form grows (`invalid-params` from a tab or a panel frame). A height is a positive number; Pomade rounds it
and clamps it to its limits (at most 60% of the pane area), so read `window.innerHeight` for what the frame
got; the width never changes (`checkOverlayHeight` / `checkOverlayAnchor` hold the param rules). `anchor`
is `"center"` (default) or `"panel"` — beside the side panel, for an overlay asked for from a panel. The user
can drag the overlay by its head; Pomade remembers where it was left, per app, and the app's next overlay
opens there — a remembered position wins over `anchor`. The fake host records `height` and `anchor` in
`fake.overlays` and each `overlay.resize` height in `fake.overlayResizes`; it does not mount, place or
size the frame.

`skills` lists the agent skills the app ships — folders inside the build, each holding a
`SKILL.md`; a folder's last segment is the skill's name (`SKILL_NAME_RE`, unique):

```jsonc
"skills": ["skills/pomade-runner-jobs"]
```

The skill's master copy lives in the app repo, versioned with the format it describes, and ships
in the build. `host.info()` answers `skills: [{ name, path }]` — each folder's absolute path in the
installed (or dev-linked) build, `path: null` for a dev-server link; the fake host answers
`<appFolder>/<path>` (`appFolder` option, default `/fake/apps/<id>`). The reference pattern
(`examples/hello`): say once, in a first-run notice the user dismisses for good (remember it with
`host.state`), "This app ships a skill for agents: <name>, at <path>. To give it to an agent, copy or
link that folder into the agent's skills folder." — and keep the same in the app's About view. Pomade links it nowhere: `pomade apps install` checks each folder holds a `SKILL.md`
and reports where it is in the installed build, so the user can copy or link it into an agent's
skills folder (HOST-API §2). Validation reports every invalid entry as `"skills[i]"`.

`startOnLaunch: true` makes Pomade load the app's panel frame — hidden — when it starts, so the
app can set its badge (and later post notices) before the user opens it; the frame is the same one
its icon shows, welcomed on `surface: "panel"`. It needs a strip icon with action `panel` or
`both` (the first one is the launch panel: `launchPanelIcon(manifest)`); otherwise, and for a
non-boolean value, the field is invalid. The fake host has no launch: open that panel frame with
`fake.createTransport({ surface: "panel", icon })`.

`backend` declares the app's background process — a Node program in the build that Pomade runs
with its own runtime and that talks to it over the socket ("Backends and commands" below):

```jsonc
"backend": { "entry": "backend/main.js", "mode": "with-pomade" }
```

`entry` is a `.js`, `.mjs` or `.cjs` file inside the build; `mode` is `"with-pomade"` (runs while
Pomade runs, restarted after a crash) or `"always-on"` (a login item that keeps running when Pomade
quits); `restartOnUpdate: true` (always-on only) lets an update restart the running backend.
Bundle the backend into its entry — an installed build has no `node_modules`. Invalid keys are
reported as `"backend.mode"` etc. The id `pomade` is reserved for Pomade itself.

`commands` declares command-line entries Pomade puts on `PATH` (its command folder, `~/.pomade/bin`
for the stable Pomade):

```jsonc
"commands": [{ "name": "pomade-planner", "entry": "cli/main.js", "title": "Today's items as JSON" }]
```

`name` is the app id or starts with `<app id>-` (so an app never shadows a system command or
another app's), never `pomade` / `pomade-git` (`RESERVED_COMMANDS`); `entry` is a bundled Node file
in the build; `title` is optional. The command runs with Pomade's runtime, with or without Pomade
running: it reaches its app's API through `connectSocket()` and finds the workspace with
`resolveWorkspace()`.

## Write one frontmatter field

```ts
import { setField, setKeyLines, removeField, setBody } from "pomade-kit/frontmatter";

const r = setField(fileText, "status", "done");   // FieldValue: string | number | boolean | null | string[]
if (r.ok) save(r.text);                           // r.changed: false when the bytes are identical
else showError(r.reason);                         // "unreadable-frontmatter" | "unsupported-key" | "invalid-value"
removeField(fileText, "parked");
setKeyLines(fileText, "repeat", "repeat:\n  every: { week: 1 }");   // one key as its own YAML lines (a mapping)
setBody(fileText, "New body\n");                  // keeps the frontmatter block's bytes; getBody(fileText) reads it
```

Only the field's own lines change; every other byte — other keys, their quoting, comments,
blank lines, key order, the body and its line endings — stays identical. A missing key is
appended at the end of the block (a file without frontmatter gets a new block on top). A string
is written plain when it reads back as the same string, otherwise double-quoted (`"true"`,
`"3"`); dates stay plain (`2026-11-09`). A string with a control character (tab and line
breaks included, DEL, C1, U+FFFE/U+FFFF) or a lone surrogate is always double-quoted with JSON
escapes, by `emitScalar` as by `setField`, so a written block always parses. A block that is not a valid YAML mapping, or a first
`---` line that never closes, is refused — never rewritten. `setKeyLines` takes the key's lines
verbatim (`key:` at column 0, every further line indented, one key, valid YAML — else
`invalid-value`; CRLF or one trailing line break is fine) and writes them with the file's line
endings.

Exceptions on the edited key itself (Pomade's editor has the same ones): a quoted value is
re-emitted plain when safe; a list edit rewrites all of the list's item lines (comments between
items are lost); an emptied block list becomes `key: []`; removing the last key drops the whole
block, its standalone comments and the blank lines after it. A block with mixed line endings is
written back with the block's CRLF.

The block core (`parseFrontmatter`, `setScalarValue`, `setBooleanValue`, `setListValue`,
`addProperty`, `removeProperty`, `moveKey`, `getKeyLines`, `setComplexKeyLines`, `validateYaml`,
`emitScalar`, `splitFrontmatter`) is Pomade's properties-panel logic with identical behavior and
signatures; it works on the LF-normalized block that `splitFrontmatter` returns.

## Schedules

One recurrence format for every piece of the family: Runner jobs write it under `schedule:`,
Planner recurring items under `repeat:`. It is a YAML mapping with **one shape key** and optional
**modifiers**. No cron syntax. Times are `H:MM`, 24-hour, on the Mac's local clock; dates are
`YYYY-MM-DD`.

```yaml
schedule:
  once: 2026-11-20 23:00                         # one run; a Planner item writes the date only
```
```yaml
schedule:
  every: { minutes: 30, from: 9:00, to: 19:00 }  # or { hours: 2 }; from/to optional
  only: weekdays                                 # weekdays (Mon–Fri) | weekends (Sat–Sun)
```
```yaml
schedule:
  daily: { at: [13:00, 20:00] }                  # one time or a list
```
```yaml
schedule:
  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
```
```yaml
schedule:
  weekly: { every: 2, days: [sun], at: 3:00 }    # every other Sunday: every N weeks
  start: 2026-11-22                              # counted from the week of start (required)
```
```yaml
repeat:
  daily: { every: 10 }                           # every 10 days: every N days
  start: 2027-01-03                              # counted from start (required)
```
```yaml
schedule:
  monthly: { days: [1, 15, last, first mon], at: 9:00 }   # numbers 1–31, last, "<nth> <weekday>"
```
```yaml
schedule:
  monthly: { days: [5], months: [jan, apr, jul, oct], at: 9:00 }   # quarterly; one month = yearly
```
```yaml
schedule:
  always: true                                   # services
```
```yaml
repeat:                                          # a Planner recurring item: whole days, no `at`
  monthly: { days: [5] }
  start: 2026-01-01                              # first date with occurrences (inclusive)
  end: 2026-12-31                                # last date with occurrences (inclusive)
  lead-days: 3                                   # shows up 3 days early
```
```yaml
repeat:
  after-completion: { months: 3 }                # or { days: N } / { weeks: N }
```

| Key | Values |
|---|---|
| `once` | `YYYY-MM-DD H:MM`, or `YYYY-MM-DD` in a day schedule |
| `every` | `minutes: 1–1440` or `hours: 1–24`; `from`, `to` (a window inside one day, both ends inclusive) |
| `daily` | `every`: 1–1000 days (default 1); `at`: a time or a list |
| `weekly` | `every`: 1–1000 weeks (default 1); `days`: `mon` … `sun` (full names too); `at` |
| `monthly` | `days`: `1`–`31`, `last`, `first`/`second`/`third`/`fourth`/`fifth`/`last` + weekday; `months`: `jan` … `dec` or `1`–`12`; `at` |
| `after-completion` | exactly one of `days`, `weeks`, `months` |
| `always` | `true` |
| `only` | `weekdays` · `weekends` — with `every` and `daily` |
| `start`, `end` | dates, inclusive — not with `once`, `always`; `start` is required with `every` above 1 |
| `lead-days` | whole days ≥ 0 — not with `always` |

Full day names, `1st`…`5th` and capitalised names are accepted; `formatSchedule` writes the
canonical form above.

**Meaning, where it could be read two ways:**
- **Day 29–31 in a shorter month** happens on that month's last day (`days: [31]` = Jan 31, Feb
  28 or 29, Mar 31, Apr 30 …). Two days that land on the same date are one occurrence. A **fifth
  weekday** happens only in months that have one.
- **`every`** is a grid of wall-clock times that restarts each day at `from` (default 0:00) and
  stops at `to` (default 23:59): `every: { hours: 5 }` = 0:00, 5:00, 10:00, 15:00, 20:00.
- **A time skipped by spring-forward** happens as many minutes later as the change skipped: a
  02:30 daily run on Madrid's 02:00 → 03:00 day runs at 03:30, once. Interval times that land on
  the same instant merge.
- **A time repeated by fall-back** happens once, on its first pass: a 01:30 run on New York's
  02:00 → 01:00 day runs at 01:30 EDT and not again at 01:30 EST. An interval leaves the repeated
  hour empty.
- **`every` in `daily` / `weekly`** counts calendar days or weeks from `start`, which is the first
  occurrence's day or week: `daily: { every: 10 }` from Jan 3 = Jan 3, 13, 23, Feb 2 …; `weekly:
  { every: 2, days: [mon, fri] }` from Wed Nov 25 = Fri Nov 27, then Mon Dec 7, Fri Dec 11 … — weeks
  run Monday to Sunday, the week of `start` is the first, and its days before `start` do not count.
  `only` (with `daily`) filters the cycle's days without shifting it. DST never moves the cycle:
  it counts dates.
- **`after-completion`** has no fixed dates: the next date is the completion date plus the period
  (months keep the day, clamped like above), never before `start`.
- **A day schedule** (no `at`) in the time functions happens at local 0:00.

**Resolution.** `parseSchedule(value, { resolution })` checks what the consumer accepts:
`"day"` (Planner: no `every`, `always` or `at`), `"time"` (Runner: `at` required, `once` needs a
time, no `after-completion` or `lead-days`), or omitted (anything).

```ts
import {
  parseSchedule, formatScheduleError, formatSchedule, describeSchedule,
  nextOccurrence, previousOccurrence, occurrencesBetween, nextDate, datesBetween, leadStart,
} from "pomade-kit/schedule";

const r = parseSchedule(frontmatter.schedule, { resolution: "time" });
if (!r.ok) return r.errors.map((e) => formatScheduleError("schedule", e));
// → 'schedule.weekly.days[1]: "fry" is not a weekday — use mon, tue, wed, thu, fri, sat or sun'
const s = r.schedule;

describeSchedule(s);                          // "every 30 min on weekdays, 9:00–19:00"

// Runner — instants; time is always a parameter, never read inside.
nextOccurrence(s, now);                       // first occurrence > now, or null
occurrencesBetween(s, lastAlive, now);        // missed runs in (lastAlive, now], earliest first, ≤ 1000
previousOccurrence(s, now);                   // the latest occurrence < now

// Planner — whole days, as YYYY-MM-DD, relative to the planner day.
nextDate(s, today, { inclusive: true });      // first date ≥ today (strictly after without inclusive)
nextDate(afterCompletion, doneOn);            // doneOn + the period
datesBetween(s, doOn, today);                 // dates in (doOn, today] — "missed N×" = 1 + length
leadStart(s, doOn);                           // doOn − lead-days: in Today from this date

setComplexKeyLines(block, "repeat", formatSchedule("repeat", s));   // write it back
```

`after-completion` and `always` have no fixed times: the time functions return null / `[]`, and
`datesBetween` returns `[]`. Date helpers used by the engine are exported too (`addDays`,
`addMonths`, `daysBetween`, `localDateOf`, `toInstant`, …).

**Why JS `Date` local time and no time-zone library:** schedules follow the Mac's clock, and the
`Date` local-time APIs are exactly that clock — in Node and in the browser, with no zone database
to ship or keep current. ECMAScript defines how they resolve skipped and repeated wall times (the
rules above), so the DST behavior is specified, not engine-dependent. Calendar arithmetic runs on
UTC day numbers, so it never meets a DST shift. Tests pin a zone through `process.env.TZ`
(`src/schedule/test-helpers.ts`), which Node applies on assignment; the matrix covers
Europe/Madrid and America/New_York across both changes.

## Date phrases

Short typed phrases become dates the same way everywhere — the Planner's quick add, Pomade's
editor, Runner's "Run at…".

```ts
import { parseDatePhrase, currentDay } from "pomade-kit/dates";

const r = parseDatePhrase(input, { now: new Date(), dayBoundary: { hour: 3, minute: 0 } });
switch (r.kind) {
  case "date":       r.date; break;                  // "2026-11-13" — a whole day
  case "date-time":  r.at; r.date; r.time; break;    // a moment: the instant, its local date and time
  case "invalid":    r.message; break;               // "Nov has no day 31" — looks like a date, isn't one
  case "not-a-date": break;                          // treat the text as text
}
currentDay(now, { hour: 3, minute: 0 });             // the Planner day: at 01:30 still yesterday
```

| Phrase | Result (now = Mon 2026-11-09 14:00) |
|---|---|
| `today` · `tomorrow` · `yesterday` · `tonight` | 2026-11-09 · 2026-11-10 · 2026-11-08 · 2026-11-09 |
| `fri`, `friday` (any weekday name) | 2026-11-13 — the next one after today, 1–7 days ahead (`mon` → 2026-11-16) |
| `nov 20`, `20 nov`, `november 20th` | 2026-11-20 — the first on or after today (`nov 8` → 2027-11-08, `feb 29` → 2028-02-29) |
| `nov 20 2027`, `nov 20, 2027`, `2026-11-20` | that date |
| `+3d` or `in 3 days` · `+2w` or `in 2 weeks` · `+1mo` | 2026-11-12 · 2026-11-23 · 2026-12-09 (months clamp to short months) |
| `+2h` · `+30min` · `in 2 hours` · `in 90 minutes` | `now` plus that much elapsed time |
| `tonight 23:00` · `tonight 1:00` | 2026-11-09 23:00 · 2026-11-10 1:00 (before 12:00 = the next morning) |
| `tomorrow 9:00`, `fri at 9pm`, `nov 20 9:30` | that day at that time |
| `23:00`, `at 7am` (a time alone) | its next occurrence after `now` |
| `2026-11-20T09:30` (`<input type="datetime-local">`) | that local date and time, even if it has passed |

- **Day boundary.** Day phrases count from the reference day: the calendar date, or with
  `dayBoundary` the Planner's day — at 01:30 with a 03:00 boundary, `today` is still yesterday's
  date and `tomorrow` is today's. Elapsed-time phrases (`+2h`), a time alone and
  `YYYY-MM-DDTHH:MM` ignore it. `currentDay` never moves backwards: on a fall-back night the day
  starts on the first pass of the boundary and stays while the clock repeats the hour before it (a
  02:30 boundary in Madrid: the day starts at 02:30 CEST and stays through 02:00–02:59 CET); a
  boundary skipped by spring-forward is passed when the clock jumps over it.
- **Times** are `H:MM` 24-hour or `9pm` / `9:30am`; they follow the schedule module's DST rules (a
  skipped time moves forward by the gap, a repeated one is its first pass). `date` and `time` in
  the result are where `at` actually falls.
- **Invalid** means the text reads as a date but names none: `nov 31`, `feb 29 2027`,
  `2026-02-30`, `tomorrow 25:00`, `13pm`, `+99999d`, `2026-11-20T24:00`.
- Case and extra spaces are ignored. Anything else — `buy milk`, `next fri`, `fri 20` — is
  `not-a-date`.

## Agent output scanners

Readers of a terminal's output stream, fed chunk by chunk exactly as the pty delivers them. Pomade's
terminals use them, and so does Runner's keeper for the sessions it runs.

```ts
import { AgentStateScanner, AttentionScanner, MarkerScanner } from "pomade-kit/scanners";

const markers = new MarkerScanner((ev) => {
  if (ev.kind === "exec") ev.command;   // a command is about to run at the shell
  else ev.cwd;                          // a prompt was drawn; its $PWD, or null; `ev.status`: the ended command's exit status, when the shell reported it
});
const attention = new AttentionScanner(() => markUnread());   // a bell or an OSC 9/99/777 notification

const agent = new AgentStateScanner({ agent: "claude", cols, rows }, (state) => {
  // { kind: "working" } | { kind: "idle" } | { kind: "waiting", prompt: "permission" | "trust" } | { kind: "unknown" }
});

pty.onData((data) => { markers.push(data); attention.push(data); agent.push(data); });
pty.onResize(({ cols, rows }) => agent.resize(cols, rows));
pty.onExit(() => agent.dispose());
```

- **Markers and attention** are synchronous and split-safe: a marker, OSC or BEL cut across two
  chunks is recognised exactly once. A BEL that ends an OSC is not a bell; window titles (OSC
  0/1/2) and Pomade's OSC 7879 markers are never attention.
- **Agent state** replays the stream into a headless terminal of the pty's size
  (`@xterm/headless`) and reads the screen and the window title. Both CLIs redraw only changed
  cells, so a prompt's words are not reliably in the raw bytes, but they are on the screen.

| | claude | codex |
|---|---|---|
| working | title starts with ◐ ◓ ◑ ◒ | title starts with a braille spinner |
| idle | title starts with ✳ | any other title, once a spinner has been seen |
| waiting: permission | dialog "Do you want to …" · "❯ 1. Yes" · "Esc to cancel" | title "[ ! ] Action Required" or dialog "› 1. Yes, proceed" · "Press enter to confirm or esc to cancel" |
| waiting: trust | "Yes, I trust this folder" · "Enter to confirm · Esc to cancel" | "› 1. Yes, continue" · "Press enter to continue" |

- A dialog counts only while its footer is the **last non-blank row** on screen, where both CLIs
  draw a live prompt. A transcript that quotes a prompt has the composer below it and does not
  count.
- **Idle is reported after it holds for `idleAfterMs`** (default 500 ms). claude shows its idle
  title a few milliseconds before it draws a permission dialog, so a consumer that ends a run
  on idle never sees that flash. Working and waiting are reported at once. A finished turn is a
  `working → idle` change.
- Events are asynchronous (after the chunk is parsed); `await agent.settled()` waits for
  everything pushed so far. `agent.state` is the last reported state.
- `unknown` until the output says otherwise: before the first title, or under a codex
  `[tui].terminal_title` without the spinner (the scanner never guesses idle).
- Create the scanner when the agent starts and dispose it when it exits; after an exit the
  screen still holds whatever the CLI left there.
- Evidence: real captures of claude 2.1.321 and codex-cli 0.153.2 answering permission prompts
  (`src/scanners/fixtures/`, provenance in each file) replay in the unit suite with their
  recorded timing.

## Calling other apps — the broker

An app offers methods to other apps by naming them in its manifest's `api`, and declares the apps it
calls in `calls` (PLATFORM rule 4: no call cycles). Pomade carries each call to the app's serving
client — its backend, else a frame — and back:

```jsonc
"api": ["jobsForRepo"],          // what this app serves
"calls": ["pomade-agents"]       // whose APIs it calls
```

```ts
// Serve (in the backend, or a frame): one handler per method; return plain JSON.
await host.api.serve({
  jobsForRepo: async (params, { from }) => ({ jobs: await jobsFor((params as { repo: string }).repo) }),
});

// Call: reject with HostError — fall back on "app-absent" / "app-not-responding".
try {
  const last = await host.apps.call("pomade-agents", "sessions.last", { cwd }, { timeoutMs: 2000 });
} catch (err) {
  if (err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding")) useFallback();
  else throw err;
}
```

- `api` method names match `API_METHOD_RE` (`today`, `jobsForRepo`, `sessions.list`); `calls` are app
  ids, never the app itself — an app always reaches its own API (a frame calling its own backend).
- `apps.call` errors: `capability-denied` (the app is not in `calls`), `app-absent` (not installed,
  or nothing serves its API now), `unknown-method` (not in its `api`, or no handler),
  `app-not-responding` (no answer within `timeoutMs`, 100–60000, default 5000; or the server went
  away), `app-error` (the handler threw something other than `HostError`, or answered non-JSON), or
  the `HostError` code the handler threw. `params` default to `{}`.
- A handler gets `from`: the caller's app id, `"pomade"` for Pomade itself (rule 7 reads).
- Fake host: `createFakeHost({ apps: { "pomade-agents": { "sessions.last": () => ({…}) }, "slow": "not-responding" } })`
  scripts other apps; `fake.callApi(method, params, { from })` calls the app's own served API.

## Backends and commands — the socket

An app's backend and its commands talk to Pomade over a unix socket in Pomade's user data, with the
same messages and the same typed client as a frame (`Pomade/docs/HOST-API.md` §3 "Socket").

```ts
import { connectSocket, launchPomade, stayConnected, resolveWorkspace } from "pomade-kit/node";

// A command: one connection. Identity and socket come from the environment Pomade gives it
// (POMADE_APP_ID, POMADE_APP_KEY_FILE, POMADE_CLIENT, POMADE_SOCKET / POMADE_HOME).
const r = await connectSocket();                // never throws for a closed Pomade
if (r.status === "not-running") {
  // Pomade is closed: fall back (read your own files under resolveWorkspace())
} else if (r.status === "rejected") {
  r.reason;                                     // "unauthorized" | "needs-newer-pomade" | "app-too-old"
} else {
  const host = r.host;                          // the same HostClient as a frame's
  host.welcome.surface;                         // "backend" | "command"
  await host.files.readFolder({ path: "Projects/x/docs" });
  host.close();
}

// A backend: stay connected across Pomade restarts (back-off 250 ms → 5 s).
const keeper = stayConnected({}, {
  onConnect(host) { /* register, watch, … */ },
  onDisconnect() { /* Pomade quit or restarted */ },
});
keeper.stop();

const root = resolveWorkspace();   // POMADE_WORKSPACE, else the pointer Pomade records; null if none

// An always-on backend (or a command) that needs Pomade: start it the way it recorded, and wait.
const up = await launchPomade({ readyTimeoutMs: 60000 });
if (up.status === "connected") up.host;      // up.launched: this call started it
```

- `connectSocket()` resolves `connected`, `not-running` (nothing listens, or no answer in 5 s) or
  `rejected`. It throws only when the identity is not configured — no app id, no key.
- Options override the environment: `socketPath`, `appId`, `key` / `keyFile`, `role`
  (`"backend"` | `"command"`, default `POMADE_CLIENT`, else `"command"`), `env`, `timeoutMs`.
- Over the socket `files.pickFolder`, `git.watch`, `overlay.open`, `overlay.resize` and `overlay.close` are `capability-denied`
  (they need a frame); everything else is as for the app's frames, under its manifest.
- `launchPomade()` connects when Pomade runs; otherwise it runs the launch Pomade recorded in
  `host.json` (`open -a` for the installed app), without `ELECTRON_RUN_AS_NODE`, and retries the
  socket until it answers (`readyTimeoutMs`, default 60 s): `connected` (`launched`, and `pid` for a
  directly started dev build), `rejected`, or `failed`.
- Pomade's own commands (`pomade-git`) connect as the platform client (`appId: "pomade"`, the
  platform key) and may call `host.agents.liveIn(folder)` → `{ live, agents: [{ agentId, cwd }] }`
  — agents running in Pomade's terminals at or below an absolute folder; for an app it is
  `capability-denied` (`PLATFORM_CAPABILITY`). They reach app APIs with `host.apps.call` like apps.
- `host.onClose(cb)` runs when the client closes — `close()`, or Pomade went away.
- `pomadeHome()` is the Pomade home a command belongs to (`POMADE_HOME`, else the stable Pomade's
  `~/.pomade`); `readHostRecord()` reads what Pomade records there (`host.json`: its socket and
  how to launch it).
- The framing (`encodeLine`, `createLineDecoder`), the path limit (`socketPathProblem`, 103 bytes
  on macOS), the environment names (`POMADE_ENV`) and the home layout (`HOME_FILES`) are in
  `pomade-kit/protocol`, shared with Pomade.

## Attached terminals — the keeper and the attach protocol

An app that runs things in terminals while Pomade is closed (Runner's services and jobs) keeps
them in a **keeper**: a small Node process that holds the sessions' PTYs and serves the **attach
protocol** on a unix socket (`pomade:E-034`). Pomade's attached tabs, and the owning app itself,
are clients. The app's always-on backend starts the keeper as its own detached process, so the
backend can restart, update or crash while the sessions run on; the keeper runs on Pomade's runtime
(Electron as Node) like the backend.

```js
// backend/keeper.mjs — the keeper's entry: app id, socket and owner key come from the backend's
// environment (POMADE_APP_ID, POMADE_KEEPER_SOCKET, POMADE_APP_KEY_FILE).
import { runKeeper } from "pomade-kit/keeper";
await runKeeper({ version: "1" });
```

```ts
// backend/main.mjs — keep the keeper up and drive it as its owner.
import { startKeeper, connectKeeper, followSession } from "pomade-kit/node";

await startKeeper({ entry: new URL("./keeper.mjs", import.meta.url).pathname });  // no-op when it runs
const r = await connectKeeper({ socketPath: process.env.POMADE_KEEPER_SOCKET, app: "pomade-runner", role: "owner", key });
if (r.status === "connected") {
  const k = r.keeper;
  await k.spawn({
    id: "svc:coda-web", title: "Coda web",
    command: "npm run dev",                    // run by the user's login shell (`$SHELL -l -c`); or argv: [...]
    cwd: "/Users/me/Projects/coda",
    log: "/…/app-state/pomade-runner/output/run-17.log",   // optional: every output byte, appended
    background: false,                         // true: macOS background priority (taskpolicy -b)
    actions: [{ id: "restart", title: "Restart" }],        // header actions on attached tabs
  });
  await k.list();                              // SessionInfo[]: id, title, command, cwd, pid, state, exit, clients, actions
  await k.stop("svc:coda-web", { reason: "time-limit", graceMs: 3000 });   // SIGTERM, then SIGKILL
  await k.update("svc:coda-web", { title: "Coda web (dev)" });
  await k.forget("svc:coda-web");              // drop an ended session
}

// Any client: follow one session across keeper updates and restarts.
const f = followSession({ socketPath, app: "pomade-agents", session: "svc:coda-web", cols: 120, rows: 30 }, {
  onSnapshot(data, info) { /* draw into an emptied terminal of info.cols × info.rows */ },
  onDelta(data) { /* output missed during a reconnect: write on top */ },
  onOutput(data) { /* live output */ },
  onExit(exit) { /* exit.reason */ },
  onState(state) { /* connecting · attached · unreachable · gone · rejected */ },
});
f.input("q"); f.paste("text"); f.resize(100, 30); await f.stop(); f.close();   // close = detach; the session runs on
```

**Where.** One keeper per app, at a fixed socket: `keeperSocketPath(userData, appId)` =
`<userData>/run/keepers/<appId>.sock` (folder 0700). Pomade gives an app's backend the path as
`POMADE_KEEPER_SOCKET` (`POMADE_ENV.keeperSocket`, in the login item too) and connects there itself,
so attaching never calls the owner (`PLATFORM` rule 4): a **session reference** is
`{ app, session }` (`SessionRef`, `checkSessionRef`). macOS caps a socket path at 103 bytes;
`keeperSocketProblem()` says why a path is too long, and `runKeeper` / `startKeeper` refuse one with
that message. The keeper's own records live in `stateDir` (default
`<userData>/app-state/<appId>/keeper`): one record per session, exit statuses, its log.

**The protocol** (`pomade-kit/protocol`, `ATTACH_PROTOCOL` = 1): one JSON object per line over the
socket — the Host API socket's framing (`encodeLine`, `createLineDecoder`). Requests that carry a
`rid` are answered `result` or `error`.

| Client → keeper | Answer |
|---|---|
| `hello { protocol, client: { app, role: "owner" \| "viewer", key? } }` | `welcome { protocol, app, keeper: { version, pid } }` or `reject { code: "unauthorized" \| "version-mismatch" }` — the owner must be the keeper's app with its key |
| `list` | `SessionInfo[]` |
| `spawn { spec }` *(owner)* | `SessionInfo`; an id held by an ended session is reused (its clients stay attached and get the new session's screen); a running id is `session-running` |
| `attach { session, cols?, rows?, since?, scrollback? }` | a `snapshot` (or a `delta` when `since: { startedAt, seq }` is still in the keeper's ring), then the session's events |
| `input { session, data }` · `paste { session, text }` · `resize { session, cols, rows }` · `detach { session }` | — (paste is bracketed when the program asked for it) |
| `stop { session, reason?, graceMs? }` | a viewer's stop ends as `stopped-by-you`; the owner names `stopped` (default), `stopped-by-you` or `time-limit` |
| `update { session, title?, actions? }` · `forget { session }` · `upgrade { entry, args? }` *(owner)* | |

| Keeper → client | |
|---|---|
| `snapshot { session, info, data, seq, resync }` | the screen serialized: drawn into an empty terminal it reproduces scrollback (up to 1000 lines), the screen (normal or alternate), colours, cursor, modes, scroll region, mouse encoding and cursor visibility — never a replay of recorded bytes, so it asks the terminal nothing |
| `delta { session, info, data, seq }` · `output { session, data, seq }` | `seq` counts output characters since the session started; a client keeps the last one to resume |
| `resized { session, cols, rows }` · `exit { session, exit }` · `info { session, info }` | another client resized it (last active client wins) · it ended · the owner changed its title or actions |
| `keeper-restarting { reconnectAfterMs }` | an update: reconnect and attach again with `since` |

**Exit reasons** (`SessionExit.reason`): `exited` (status 0) · `crashed` (any other status, or a
signal) · `stopped` (the owner) · `stopped-by-you` (an interrupt typed through a client within 5 s
of the exit, or a viewer's Stop) · `time-limit` · `lost-in-keeper-crash`.

**Rules a client follows.** The keeper's headless terminal is the terminal of record and answers
the program's terminal queries (cursor position, device attributes, colours); a client never sends
its own terminal's answers — only what the user did (keys, mouse, focus reports), and pastes as
`paste`. Header actions a session carries are the owner's: a host calls back into the owner through
its own channel (Pomade publishes `attachedTab.action` to the owner), never over the keeper socket.

**Inside the keeper.**
- Every session runs under a small shell shim that writes its exit status to the state folder, so a
  keeper that is not the session's parent (after an update) still learns how it ended. Sessions get
  a terminal's environment (`TERM=xterm-256color`, `TERM_PROGRAM=Apple_Terminal`, `LANG` when unset —
  as in Pomade's own terminals) without the keeper's runtime switch and the app's identity
  (`sessionEnv`); a `command` runs in the user's login shell, which brings the user's `PATH`.
- A headless xterm per session parses every byte — the same xterm line (5.5) and Unicode 11 width
  tables as Pomade's renderer, so both agree on every cell.
- **Update** (`upgrade`): the keeper stops reading the PTYs (and drains what it already read — a
  paused stream would lose it), writes the sessions' state to a hand-off file and starts the new
  entry with the PTY masters as inherited fds; the new keeper adopts them and binds the socket.
  Clients see a gap of tens of milliseconds and resume. When the new keeper does not answer within
  15 s, the old one kills it and serves again.
- **Flow control:** a client whose unsent bytes pass the high-water mark (default 4 MiB) has its
  output dropped and gets a fresh snapshot (`resync: true`) once it catches up — the keeper's memory
  stays bounded.
- **Crash:** the kernel hangs up a dead keeper's PTYs, so its sessions end with it; the next keeper
  reads their records and reports them `lost-in-keeper-crash`.
- **One per socket:** a keeper refuses a socket another keeper serves; a stale socket file is replaced.
- `node-pty` is a peer dependency of `pomade-kit/keeper` only. Its prebuilt `spawn-helper` sometimes
  loses its executable bit on install; the keeper restores it before the first spawn.

## Example

`examples/hello/` — the smallest app: tells once (and in its About view) where its shipped skill is, lists the active project's `docs/roadmap/` frontmatter rows,
shows the project's git repos, and follows project, file and git events. On the bus it shows the
last platform event it heard (Pomade ready, a project renamed) and publishes `greeted` from a
button that is enabled only while another app listens; "Notify me" posts a notice whose click opens
its roadmap tab in the project the notice is about. "Quick note…" opens its Cmd+Shift+J overlay
from the panel or tab (`overlay.open`); "New scratch file" / "Trash scratch files" make files in the
project's `scratch/` folder and move them all to the Trash in one `files.delete`. Its always-on backend (`public/backend/`) keeps the app's keeper running with a
demo ticker in it; "Open the ticker" opens that session in an attached tab, and the tab's Restart
action reaches the backend as `attachedTab.action`. `npm run hello:build` writes the installable folder
`examples/hello/dist/` (`index.html`, `manifest.json`, assets).

## Develop this repo

```sh
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

`npm test` runs the unit matrix (vitest) and the e2e (Playwright, Chromium).

## Release

1. On `main`, with the gate green, bump `version` in `package.json` and commit.
2. Tag with the changelog in the tag message and push the tag:
   ```sh
   git tag -a v0.2.0 -m "v0.2.0

   - what changed, one line per change
   - BREAKING: … (a breaking change is a major version)"
   git push origin v0.2.0
   ```
3. Consumers bump their pin: `npm install github:dd-voronov/pomade-kit#v0.2.0`. A breaking change
   is announced in each consumer's backlog.
