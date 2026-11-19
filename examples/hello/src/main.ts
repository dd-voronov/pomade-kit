// Hello — the smallest Pomade app: lists the active project's docs/roadmap/ with each file's
// frontmatter (the folder is a per-project setting), shows the project's group path and visible
// agents and keeps them live (`project.updated`), lets the user pick its folder with Pomade's
// folder picker, follows project switches and file changes, marks a ticket done with a field-only frontmatter write, and opens a ticket in a
// Pomade editor tab. It also counts its own
// launches in the app state shared by all its frames, shows the route it renders and opens its
// own tab at a route, and badges its strip icon with the number of tickets — it starts on launch,
// so the badge is there before the panel is opened; its Cmd+Shift+J overlay takes a quick note
// into the app state; it shows the project's git repos live. On the event bus it shows the last
// platform event it heard (Pomade ready, a project renamed or removed); its Greet button publishes a
// `greeted` event and is enabled only while another app listens. "Notify me" posts a Pomade notice
// whose click opens the roadmap in the app's own tab, in the project the notice is about. Its
// always-on backend keeps a ticking demo service in a keeper (`public/backend/`); "Open the
// ticker" opens it in an attached terminal tab, whose Restart header action the backend serves.
// "Ask the backend" calls the app's own API (`status`), which its backend serves through Pomade's broker.
// "Quick note…" opens the same overlay as Cmd+Shift+J from the panel or tab (`overlay.open`).
// "New scratch file" makes a file in the project's scratch/ folder; "Trash scratch files" moves
// every file there to the Trash in one `files.delete` call and says how each one went.
// It looks like Pomade: Pomade's design tokens and its theme, whatever the Mac's appearance.
// Built only on pomade-kit's SDK.

import "pomade-kit/tokens.css";
import { joinPath } from "pomade-kit/protocol";
import {
  connect,
  followTheme,
  HostError,
  type FileEntry,
  type FileWatch,
  type GitRepoState,
  type GitWatch,
  type HostClient,
  type ProjectRef,
} from "pomade-kit/sdk";

const FOLDER = "docs/roadmap";
const DONE_FOLDER = "docs/roadmap/done";
const COLUMNS = ["id", "status", "title"];
const SCRATCH = "scratch";

function el(testId: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`missing ${testId}`);
  return node;
}

function cell(tag: "td" | "th", text: string, className?: string): HTMLTableCellElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(testId: string, text: string, onClick: () => void): HTMLTableCellElement {
  const td = document.createElement("td");
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.testid = testId;
  b.textContent = text;
  b.addEventListener("click", onClick);
  td.append(b);
  return td;
}

interface RowActions {
  markDone(entry: FileEntry): void;
  open(entry: FileEntry): void;
}

/** Draw the rows; returns how many tickets were listed. */
function renderRows(entries: FileEntry[], actions: RowActions): number {
  const table = el("rows");
  table.replaceChildren();
  const head = document.createElement("tr");
  for (const name of ["file", ...COLUMNS]) head.append(cell("th", name));
  table.append(head);
  for (const entry of entries) {
    if (entry.frontmatter === undefined && entry.frontmatterError === undefined) continue;
    const row = document.createElement("tr");
    row.dataset.path = entry.path;
    row.append(cell("td", entry.name));
    if (entry.frontmatterError !== undefined) {
      const error = cell("td", `can't read: ${entry.frontmatterError}`, "error");
      error.colSpan = COLUMNS.length;
      row.append(error);
    } else {
      for (const key of COLUMNS) {
        const value = entry.frontmatter?.[key];
        row.append(cell("td", value === undefined || value === null ? "" : String(value)));
      }
      row.append(button("done", "Done", () => actions.markDone(entry)));
      row.append(button("open", "Open", () => actions.open(entry)));
    }
    table.append(row);
  }
  return table.querySelectorAll("tr[data-path]").length;
}

/** Every frame load counts one launch in the app state; other frames' counts arrive as `state.changed`. */
async function countLaunches(host: HostClient): Promise<void> {
  const show = (n: unknown): void => {
    el("launches").textContent = `Launches: ${typeof n === "number" ? n : 0}`;
  };
  host.state.onChange((key, value) => {
    if (key === "launches") show(value);
  });
  const launches = ((await host.state.get<number>("launches")) ?? 0) + 1;
  await host.state.set("launches", launches);
  show(launches);
}

/** One line per repo: name, branch, uncommitted files, unpushed commits, remote. */
function describeGit(repos: GitRepoState[]): string {
  if (repos.length === 0) return "Git: no repository";
  return `Git: ${repos.map((r) => `${r.name} · ${r.branch ?? "detached"} · ● ${r.changes.length} ↑${r.ahead} · ${r.remoteUrl ?? "local only"}`).join("; ")}`;
}

/** The bus: the last event heard, and a Greet button that publishes `greeted` only while it has subscribers. */
async function useEvents(host: HostClient): Promise<void> {
  const heard = (text: string): void => {
    el("events").textContent = `Last event: ${text}`;
  };
  const greet = el("greet") as HTMLButtonElement;
  const listeners = (subscribed: boolean): void => {
    greet.disabled = !subscribed;
    el("listeners").textContent = subscribed ? "someone listens" : "nobody listens";
  };
  host.events.onSubscribersChange((name, subscribed) => {
    if (name === "greeted") listeners(subscribed);
  });
  greet.addEventListener("click", () => void host.events.publish("greeted", { from: host.welcome.surface }));
  await host.events.subscribe("pomade.ready", () => heard("Pomade ready"));
  await host.events.subscribe("project.renamed", ({ project, previous }) => heard(`${previous.name} renamed to ${project.name}`));
  await host.events.subscribe("project.removed", (project) => heard(`${project.name} removed`));
  listeners(await host.events.hasSubscribers("greeted"));
}

/** The reference pattern for an app that ships agent skills: Pomade links nothing, so the app
 *  says where its skills are — once, as a first-run notice dismissed for good (`state`), and always
 *  in its About view. */
async function showSkills(host: HostClient): Promise<void> {
  const info = await host.info();
  el("about-version").textContent = `App ${info.appId} · Host API ${info.hostApi} · Pomade ${info.pomadeVersion}`;
  const list = el("about-skills");
  list.replaceChildren();
  for (const skill of info.skills) {
    const item = document.createElement("li");
    item.dataset.skill = skill.name;
    const name = document.createElement("strong");
    name.textContent = skill.name;
    const path = document.createElement("code");
    path.textContent = skill.path ?? "(served by a dev server: no local folder)";
    item.append(name, " — ", path);
    list.append(item);
  }
  if (list.childElementCount === 0) list.append(Object.assign(document.createElement("li"), { textContent: "none" }));
  el("about-toggle").addEventListener("click", () => {
    el("about").hidden = !el("about").hidden;
  });
  const first = info.skills[0];
  if (!first || (await host.state.get<boolean>("skillNoticeDismissed")) === true) return;
  el("skill-notice-text").textContent = `This app ships a skill for agents: ${first.name}, at ${first.path ?? "(no local folder)"}. To give it to an agent, copy or link that folder into the agent's skills folder.`;
  el("skill-notice").hidden = false;
  el("skill-notice-dismiss").addEventListener("click", () => {
    el("skill-notice").hidden = true;
    void host.state.set("skillNoticeDismissed", true);
  });
}

/** The app's own API, served by its backend: the UI reaches it through Pomade's broker. */
async function askBackend(host: HostClient): Promise<void> {
  const status = el("backend-status");
  status.textContent = "Asking…";
  try {
    const { pid, ticker } = await host.apps.call<{ pid: number; ticker: string }>(host.welcome.appId, "status", {}, { timeoutMs: 3000 });
    status.textContent = `Backend: pid ${pid} · ${ticker === "no keeper" ? "keeper not running" : `ticker ${ticker}`}`;
  } catch (err) {
    const absent = err instanceof HostError && (err.code === "app-absent" || err.code === "app-not-responding");
    status.textContent = absent ? "Backend: not running" : `Backend: ${err instanceof HostError ? err.code : String(err)}`;
  }
}

function startApp(host: HostClient): void {
  void countLaunches(host);
  void showSkills(host);
  void useEvents(host);
  // The ticker is a session the backend's keeper runs, with or without Pomade: open it attached.
  el("open-ticker").addEventListener("click", () => void host.tabs.openAttached({ session: { app: host.welcome.appId, session: "ticker" } }));
  el("ask-backend").addEventListener("click", () => void askBackend(host));
  // The notice belongs to the project it is about: its click opens the roadmap there, whichever
  // project is in front by then.
  el("notify").addEventListener("click", () => {
    const body = `${el("rows").querySelectorAll("tr[data-path]").length} tickets in ${el("folder").textContent}`;
    void host.project.getActive().then((project) =>
      host.notices.post({ title: "Roadmap ready", body, action: { kind: "openApp", route: "roadmap", projectId: project.id } }),
    );
  });
  // The overlay a shortcut opens, opened from this frame instead, beside the side panel unless the user
  // has moved it; focus comes back to the button.
  el("open-overlay").addEventListener("click", () => void host.overlay.open({ route: "note", anchor: "panel" }));
  useScratch(host);
  const showRoute = (route: string): void => {
    el("route").textContent = `Route: ${route === "" ? "(default)" : route}`;
  };
  showRoute(host.welcome.route);
  host.onRouteChange(showRoute);
  const open = el("open-tab");
  open.hidden = false;
  open.addEventListener("click", () => void host.tabs.openApp({ route: "roadmap" }));
  let watch: FileWatch | null = null;
  let gitWatch: GitWatch | null = null;
  let generation = 0;
  let shown: ProjectRef = host.welcome.project;
  const actions: RowActions = {
    // One field changes; the watch re-renders the row.
    markDone: (entry) =>
      void host.files.setField({ path: entry.path, key: "status", value: "done" }).catch((err: unknown) => showError(entry.path, err)),
    open: (entry) => void host.tabs.openFile({ path: entry.path }).catch((err: unknown) => showError(entry.path, err)),
  };

  async function show(project: ProjectRef): Promise<void> {
    const mine = ++generation;
    shown = project;
    await watch?.close();
    watch = null;
    const folder = joinPath(project.root, await folderSetting(project));
    if (mine !== generation) return;
    el("state").textContent = `Project: ${project.name}`;
    el("folder").textContent = folder;
    void showGroup(project, mine);
    void showAgents(project, mine);
    void showGit(project, mine);
    const reload = async (): Promise<void> => {
      const { entries } = await host.files.readFolder({ path: folder, frontmatter: true });
      if (mine !== generation) return;
      await host.strip.setBadge({ icon: "hello", count: renderRows(entries, actions) });
    };
    try {
      const next = await host.files.watch({ path: folder }, () => void reload().catch((err: unknown) => showError(folder, err)));
      if (mine !== generation) {
        await next.close();
        return;
      }
      watch = next;
      await reload();
    } catch (err) {
      if (mine === generation) showError(folder, err);
    }
  }

  /** The folder this app lists for a project: its per-project setting, else docs/roadmap. */
  async function folderSetting(project: ProjectRef): Promise<string> {
    if (project.kind === "workspace") return FOLDER;
    const { settings } = await host.project.getSettings({ projectId: project.id });
    return typeof settings.folder === "string" ? settings.folder : FOLDER;
  }

  /** The project's repos, kept live by a git watch scoped to the project. */
  async function showGit(project: ProjectRef, mine: number): Promise<void> {
    await gitWatch?.close();
    gitWatch = null;
    const render = (repos: GitRepoState[]): void => {
      if (mine === generation) el("git").textContent = describeGit(repos);
    };
    const next = await host.git.watch({ projectId: project.id }, render);
    if (mine !== generation) {
      await next.close();
      return;
    }
    gitWatch = next;
    render((await host.git.getState({ projectId: project.id })).repos);
  }

  async function showAgents(project: ProjectRef, mine: number): Promise<void> {
    const { visibleAgents } = await host.project.getAgents({ projectId: project.id });
    if (mine !== generation) return;
    el("agents").textContent = `Agents: ${visibleAgents.includes("*") ? "all" : visibleAgents.join(", ") || "none"}`;
  }

  // Remember a different folder for this project, or offer only claude in its "+" menu; the
  // `project.updated` that follows redraws the lines.
  el("use-done").addEventListener("click", () => {
    void (async () => {
      const project = await host.project.getActive();
      if (project.kind === "workspace") return;
      const { settings } = await host.project.getSettings({ projectId: project.id });
      const folder = settings.folder === DONE_FOLDER ? null : DONE_FOLDER;
      await host.project.setSettings({ projectId: project.id, settings: { folder } });
    })();
  });
  el("only-claude").addEventListener("click", () => {
    void (async () => {
      const project = await host.project.getActive();
      if (project.kind === "workspace") return;
      await host.project.setAgents({ projectId: project.id, visibleAgents: ["claude"] });
    })();
  });

  // Let the user pick the listed folder (inside the project) and remember it per project.
  el("pick-folder").addEventListener("click", () => {
    void (async () => {
      const project = await host.project.getActive();
      if (project.kind === "workspace") return;
      const { path } = await host.files.pickFolder({ root: project.id, initial: joinPath(project.root, FOLDER) });
      if (path === null) return;
      const folder = path === project.root ? "" : path.slice(project.root.length + 1);
      await host.project.setSettings({ projectId: project.id, settings: { folder } });
    })();
  });

  /** The project's place in Pomade's sidebar, looked up by its stable id. */
  async function showGroup(project: ProjectRef, mine: number): Promise<void> {
    const { projects } = await host.project.list();
    if (mine !== generation) return;
    const info = projects.find((p) => p.id === project.id);
    el("group").textContent = project.kind === "workspace" ? "Workspace" : info && info.groupPath.length > 0 ? info.groupPath.join(" › ") : "Ungrouped";
  }

  function showError(folder: string, err: unknown): void {
    el("rows").replaceChildren();
    void host.strip.setBadge({ icon: "hello", count: 0 });
    const reason = err instanceof HostError && err.code === "not-found" ? "not found" : err instanceof Error ? err.message : String(err);
    el("folder").textContent = `${folder} — ${reason}`;
  }

  // The shown project regrouped, its agents changed, or this app's settings for it (its folder)
  // changed — here, in Pomade, or from another frame of this app: redraw what changed.
  void host.events.subscribe("project.updated", ({ project, changes }) => {
    if (project.id !== shown.id) return;
    if (changes.includes("settings")) {
      void show(shown);
      return;
    }
    if (changes.includes("group")) void showGroup(shown, generation);
    if (changes.includes("agents")) void showAgents(shown, generation);
  });
  host.project.onChange((project) => void show(project));
  void show(host.welcome.project);
}

/** Scratch files in the active project's scratch/ folder: make one, or trash them all in one call. */
function useScratch(host: HostClient): void {
  const status = (text: string): void => {
    el("scratch-status").textContent = text;
  };
  const folder = async (): Promise<string> => joinPath((await host.project.getActive()).root, SCRATCH);
  el("scratch-new").addEventListener("click", () => {
    void (async () => {
      const path = joinPath(await folder(), `scratch-${Date.now()}.md`);
      await host.files.create({ path, content: "# Scratch\n\nType here, then trash it from Hello.\n" });
      status(`Created ${path}`);
    })().catch((err: unknown) => status(err instanceof Error ? err.message : String(err)));
  });
  el("scratch-delete").addEventListener("click", () => {
    void (async () => {
      const path = await folder();
      const { entries } = await host.files.readFolder({ path }).catch(() => ({ entries: [] as FileEntry[] }));
      const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
      if (files.length === 0) {
        status(`Nothing to trash in ${path}`);
        return;
      }
      const results = await host.files.delete(files);
      const trashed = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error?.code ?? "error"}`);
      status([`Trashed ${trashed} of ${results.length}`, ...failed].join(" · "));
    })().catch((err: unknown) => status(err instanceof Error ? err.message : String(err)));
  });
}

/** The overlay (Cmd+Shift+J, or "Quick note…"): a note field that grows with its text (`overlay.resize`);
 *  Enter stores the note and closes, Shift+Enter adds a line, Escape just closes. */
function startQuickNote(host: HostClient): void {
  document.body.replaceChildren();
  document.body.className = "overlay";
  const form = document.createElement("form");
  const note = document.createElement("textarea");
  note.dataset.testid = "note";
  note.rows = 3;
  note.placeholder = "Quick note — Enter to save, Shift+Enter for a new line, Esc to cancel";
  form.append(note);
  document.body.append(form);
  const store = (): void => void host.state.set("lastNote", note.value).then(() => host.overlay.close());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    store();
  });
  note.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    store();
  });
  // Room for the text plus the body's margin; Pomade clamps it.
  note.addEventListener("input", () => {
    note.style.height = "auto";
    note.style.height = `${note.scrollHeight}px`;
    void host.overlay.resize({ height: note.scrollHeight + 2 * 12 + 8 });
  });
  note.focus();
}

async function main(): Promise<void> {
  const result = await connect();
  switch (result.status) {
    case "connected":
      followTheme(result.host);
      if (result.host.welcome.surface === "overlay") startQuickNote(result.host);
      else startApp(result.host);
      return;
    case "no-host":
      el("state").textContent = "No Pomade host — open this app inside Pomade.";
      return;
    case "rejected":
      el("state").textContent =
        result.reason === "needs-newer-pomade" ? "This app needs a newer Pomade." : "This app needs an update.";
      return;
  }
}

void main();
