// Hello — the smallest Pomade app: lists the active project's docs/roadmap/ with each file's
// frontmatter and follows project switches and file changes. Built only on pomade-kit's SDK.

import { joinPath } from "pomade-kit/protocol";
import { connect, HostError, type FileEntry, type FileWatch, type HostClient, type ProjectRef } from "pomade-kit/sdk";

const FOLDER = "docs/roadmap";
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

function renderRows(entries: FileEntry[]): void {
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
    }
    table.append(row);
  }
}

function startApp(host: HostClient): void {
  let watch: FileWatch | null = null;
  let generation = 0;

  async function show(project: ProjectRef): Promise<void> {
    const mine = ++generation;
    await watch?.close();
    watch = null;
    const folder = joinPath(project.root, FOLDER);
    el("state").textContent = `Project: ${project.name}`;
    el("folder").textContent = folder;
    const reload = async (): Promise<void> => {
      const { entries } = await host.files.readFolder({ path: folder, frontmatter: true });
      if (mine === generation) renderRows(entries);
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

  function showError(folder: string, err: unknown): void {
    el("rows").replaceChildren();
    const reason = err instanceof HostError && err.code === "not-found" ? "not found" : err instanceof Error ? err.message : String(err);
    el("folder").textContent = `${folder} — ${reason}`;
  }

  host.project.onChange((project) => void show(project));
  void show(host.welcome.project);
}

async function main(): Promise<void> {
  const result = await connect();
  switch (result.status) {
    case "connected":
      startApp(result.host);
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
