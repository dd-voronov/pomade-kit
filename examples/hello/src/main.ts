// Hello — the smallest Pomade app: lists the active project's docs/roadmap/ with each file's
// frontmatter (the folder is a per-project setting), shows the project's group path and visible
// agents, lets the user pick its folder with Pomade's folder picker, links its skill into an
// agent's skills folder, follows project switches and file changes, marks a ticket done with a
// field-only frontmatter write, and opens a ticket in a Pomade editor tab. It also counts its own
// launches in the app state shared by all its frames, shows the route it renders and opens its
// own tab at a route, and badges its strip icon with the number of tickets — it starts on launch,
// so the badge is there before the panel is opened; its Cmd+Shift+J overlay takes a quick note
// into the app state. Built only on pomade-kit's SDK.

import { joinPath } from "pomade-kit/protocol";
import { connect, HostError, type FileEntry, type FileWatch, type HostClient, type ProjectRef } from "pomade-kit/sdk";

const FOLDER = "docs/roadmap";
const DONE_FOLDER = "docs/roadmap/done";
const SKILL = "Apps/hello/skill";
const SKILL_LINK = "Agents/claude/skills/hello";
const COLUMNS = ["id", "status", "title"];

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

function startApp(host: HostClient): void {
  void countLaunches(host);
  const showRoute = (route: string): void => {
    el("route").textContent = `Route: ${route === "" ? "(default)" : route}`;
  };
  showRoute(host.welcome.route);
  host.onRouteChange(showRoute);
  const open = el("open-tab");
  open.hidden = false;
  open.addEventListener("click", () => void host.tabs.openApp({ route: "roadmap" }));
  let watch: FileWatch | null = null;
  let generation = 0;
  const actions: RowActions = {
    // One field changes; the watch re-renders the row.
    markDone: (entry) =>
      void host.files.setField({ path: entry.path, key: "status", value: "done" }).catch((err: unknown) => showError(entry.path, err)),
    open: (entry) => void host.tabs.openFile({ path: entry.path }).catch((err: unknown) => showError(entry.path, err)),
  };

  async function show(project: ProjectRef): Promise<void> {
    const mine = ++generation;
    await watch?.close();
    watch = null;
    const folder = joinPath(project.root, await folderSetting(project));
    if (mine !== generation) return;
    el("state").textContent = `Project: ${project.name}`;
    el("folder").textContent = folder;
    void showGroup(project, mine);
    void showAgents(project, mine);
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

  async function showAgents(project: ProjectRef, mine: number): Promise<void> {
    const { visibleAgents } = await host.project.getAgents({ projectId: project.id });
    if (mine !== generation) return;
    el("agents").textContent = `Agents: ${visibleAgents.includes("*") ? "all" : visibleAgents.join(", ") || "none"}`;
  }

  // Remember a different folder for this project, or offer only claude in its "+" menu.
  el("use-done").addEventListener("click", () => {
    void (async () => {
      const project = await host.project.getActive();
      if (project.kind === "workspace") return;
      const { settings } = await host.project.getSettings({ projectId: project.id });
      const folder = settings.folder === DONE_FOLDER ? null : DONE_FOLDER;
      await host.project.setSettings({ projectId: project.id, settings: { folder } });
      await show(project);
    })();
  });
  el("only-claude").addEventListener("click", () => {
    void (async () => {
      const project = await host.project.getActive();
      if (project.kind === "workspace") return;
      await host.project.setAgents({ projectId: project.id, visibleAgents: ["claude"] });
      await show(project);
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
      await show(project);
    })();
  });

  // Link (or unlink) this app's skill for the claude agent — inside the manifest's `symlinks` folder.
  el("link-skill").addEventListener("click", () => {
    void (async () => {
      try {
        await host.files.symlink({ path: SKILL_LINK, target: SKILL });
        el("skill").textContent = "Skill linked";
      } catch (err) {
        if (!(err instanceof HostError && err.code === "already-exists")) throw err;
        await host.files.removeSymlink({ path: SKILL_LINK });
        el("skill").textContent = "Skill unlinked";
      }
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

  host.project.onChange((project) => void show(project));
  void show(host.welcome.project);
}

/** The overlay (Cmd+Shift+J): one input; Enter stores the note and closes, Escape just closes. */
function startQuickNote(host: HostClient): void {
  document.body.replaceChildren();
  document.body.className = "overlay";
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.dataset.testid = "note";
  input.placeholder = "Quick note — Enter to save, Esc to cancel";
  form.append(input);
  document.body.append(form);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void host.state.set("lastNote", input.value).then(() => host.overlay.close());
  });
  input.focus();
}

async function main(): Promise<void> {
  const result = await connect();
  switch (result.status) {
    case "connected":
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
