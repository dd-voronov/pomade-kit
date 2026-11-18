import { expect, test, type Page } from "@playwright/test";

const APP = "http://localhost:4317/";
const HARNESS = `http://localhost:4318/harness.html?app=${encodeURIComponent(APP)}`;

function app(page: Page) {
  return page.frameLocator("iframe");
}

function row(page: Page, path: string) {
  return app(page).locator(`tr[data-path="${path}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(app(page).getByTestId("state")).toHaveText("Project: Alpha");
});

test("lists the active project's tickets with their frontmatter", async ({ page }) => {
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/alpha/docs/roadmap");
  await expect(row(page, "Projects/alpha/docs/roadmap/E-001-first.md")).toHaveText(/E-001-first\.mdE-001plannedFirstDoneOpen/);
  await expect(row(page, "Projects/alpha/docs/roadmap/T-002-broken.md")).toContainText("can't read:");
  await expect(app(page).locator("tr[data-path]")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.fakeHost.badges)).toEqual({ hello: { count: 2, urgent: false } });
});

test("follows file events: create, change, rename, delete", async ({ page }) => {
  await page.evaluate(() => window.fakeHost.writeFile("Projects/alpha/docs/roadmap/E-003-new.md", "---\nid: E-003\nstatus: planned\ntitle: New\n---\n"));
  await expect(row(page, "Projects/alpha/docs/roadmap/E-003-new.md")).toContainText("New");

  await page.evaluate(() => window.fakeHost.writeFile("Projects/alpha/docs/roadmap/E-003-new.md", "---\nid: E-003\nstatus: done\ntitle: New\n---\n"));
  await expect(row(page, "Projects/alpha/docs/roadmap/E-003-new.md")).toContainText("done");

  await page.evaluate(() => window.fakeHost.rename("Projects/alpha/docs/roadmap/E-003-new.md", "Projects/alpha/docs/roadmap/E-003-renamed.md"));
  await expect(row(page, "Projects/alpha/docs/roadmap/E-003-renamed.md")).toContainText("done");
  await expect(row(page, "Projects/alpha/docs/roadmap/E-003-new.md")).toHaveCount(0);

  await page.evaluate(() => window.fakeHost.deleteFile("Projects/alpha/docs/roadmap/E-003-renamed.md"));
  await expect(row(page, "Projects/alpha/docs/roadmap/E-003-renamed.md")).toHaveCount(0);
  await expect(app(page).locator("tr[data-path]")).toHaveCount(2);
});

test("follows project switches, including the Workspace scope", async ({ page }) => {
  await page.evaluate(() => window.fakeHost.setActiveProject("beta"));
  await expect(app(page).getByTestId("state")).toHaveText("Project: Beta");
  await expect(row(page, "Projects/beta/docs/roadmap/E-100-beta.md")).toContainText("Beta epic");
  await expect(app(page).locator("tr[data-path]")).toHaveCount(1);

  // The old project's watch is closed: its changes no longer re-render.
  await page.evaluate(() => window.fakeHost.writeFile("Projects/alpha/docs/roadmap/E-009.md", "---\nid: E-009\n---\n"));
  await page.evaluate(() => window.fakeHost.setActiveProject(null));
  await expect(app(page).getByTestId("state")).toHaveText("Project: Workspace");
  await expect(app(page).getByTestId("folder")).toHaveText("docs/roadmap — not found");
  await expect(app(page).locator("tr[data-path]")).toHaveCount(0);
});

test("forwards unhandled Cmd/Ctrl keys to the host, and only those", async ({ page }) => {
  await app(page).getByTestId("title").click();
  await page.keyboard.press("a");
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Control+Shift+T");
  await expect
    .poll(() => page.evaluate(() => window.fakeHost.keys.map((k) => ({ key: k.key, code: k.code, meta: k.metaKey, ctrl: k.ctrlKey, shift: k.shiftKey }))))
    .toEqual([
      { key: "k", code: "KeyK", meta: true, ctrl: false, shift: false },
      { key: "T", code: "KeyT", meta: false, ctrl: true, shift: true },
    ]);
});

test("a frame reload starts a new handshake and keeps working", async ({ page }) => {
  await app(page).locator("body").evaluate(() => location.reload());
  await expect(app(page).getByTestId("state")).toHaveText("Project: Alpha");
  await page.evaluate(() => window.fakeHost.writeFile("Projects/alpha/docs/roadmap/E-004.md", "---\nid: E-004\ntitle: After reload\n---\n"));
  await expect(row(page, "Projects/alpha/docs/roadmap/E-004.md")).toContainText("After reload");
});

test("counts launches in the shared app state; a reload counts again", async ({ page }) => {
  await expect(app(page).getByTestId("launches")).toHaveText("Launches: 1");
  await app(page).locator("body").evaluate(() => location.reload());
  await expect(app(page).getByTestId("launches")).toHaveText("Launches: 2");
  expect(await page.evaluate(() => window.fakeHost.state)).toEqual({ launches: 2 });
});

test("shows its route, follows route changes, and opens its own tab at a route", async ({ page }) => {
  await expect(app(page).getByTestId("route")).toHaveText("Route: (default)");
  await page.evaluate(() => window.mounted.navigate("roadmap"));
  await expect(app(page).getByTestId("route")).toHaveText("Route: roadmap");
  await app(page).getByTestId("open-tab").click();
  await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", route: "roadmap", projectId: "alpha" }]);
});

test.describe("the quick-note overlay", () => {
  const OVERLAY = `${HARNESS}&shortcut=note`;

  test("Enter stores the note in the app state and closes the overlay", async ({ page }) => {
    await page.goto(OVERLAY);
    const note = app(page).getByTestId("note");
    await expect(note).toBeFocused();
    await note.fill("call the bank");
    await note.press("Enter");
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => window.fakeHost.state)).toEqual({ lastNote: "call the bank" });
  });

  test("Escape closes it and stores nothing", async ({ page }) => {
    await page.goto(OVERLAY);
    await app(page).getByTestId("note").press("Escape");
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => window.fakeHost.state)).toEqual({});
  });
});

test("standalone (no host): shows the no-host state", async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByTestId("state")).toHaveText("No Pomade host — open this app inside Pomade.");
});

test("Done writes one frontmatter field; every other byte stays; the row follows", async ({ page }) => {
  const path = "Projects/alpha/docs/roadmap/E-001-first.md";
  await page.evaluate((p) => window.fakeHost.writeFile(p, "---\n# keep me\nid: E-001\nstatus: 'planned'   # board\ntitle: First\n---\n\nBody [[E-030]] **bold**.\r\n"), path);
  await row(page, path).getByTestId("done").click();
  await expect(row(page, path)).toHaveText(/E-001-first\.mdE-001doneFirstDoneOpen/);
  expect(await page.evaluate((p) => window.fakeHost.readFile(p), path)).toBe(
    "---\n# keep me\nid: E-001\nstatus: done   # board\ntitle: First\n---\n\nBody [[E-030]] **bold**.\r\n",
  );
});

test("Open asks Pomade for an editor tab", async ({ page }) => {
  await row(page, "Projects/alpha/docs/roadmap/E-001-first.md").getByTestId("open").click();
  await expect.poll(() => page.evaluate(() => window.fakeHost.openedTabs)).toEqual([
    { kind: "file", projectId: "alpha", path: "Projects/alpha/docs/roadmap/E-001-first.md" },
  ]);
});

test("shows the project's group path from project.list, and follows a rename by id", async ({ page }) => {
  await expect(app(page).getByTestId("group")).toHaveText("Building tools › Tools");
  await page.evaluate(() => window.fakeHost.setActiveProject("beta"));
  await expect(app(page).getByTestId("group")).toHaveText("Ungrouped");
  await page.evaluate(() => window.fakeHost.setActiveProject(null));
  await expect(app(page).getByTestId("group")).toHaveText("Workspace");
  await page.evaluate(() => window.fakeHost.setActiveProject("alpha"));
  await page.evaluate(() => window.fakeHost.updateProject("alpha", { name: "Alpha Prime" }));
  await expect(app(page).getByTestId("state")).toHaveText("Project: Alpha Prime");
});

test("the listed folder is a per-project setting; the visible agents are the project's", async ({ page }) => {
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: claude, codex");
  await app(page).getByTestId("use-done").click();
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/alpha/docs/roadmap/done");
  await expect(row(page, "Projects/alpha/docs/roadmap/done/E-000-old.md")).toContainText("Old");
  // The setting is per project: Beta keeps the default; back on Alpha it is remembered.
  await page.evaluate(() => window.fakeHost.setActiveProject("beta"));
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/beta/docs/roadmap");
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: all");
  await page.evaluate(() => window.fakeHost.setActiveProject("alpha"));
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/alpha/docs/roadmap/done");
  await app(page).getByTestId("only-claude").click();
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: claude");
});

test("group, agents and folder lines follow project.updated without a project switch", async ({ page }) => {
  await expect(app(page).getByTestId("group")).toHaveText("Building tools › Tools");
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: claude, codex");
  // The user regroups the project and edits its agents in Pomade.
  await page.evaluate(() => window.fakeHost.updateProject("alpha", { group: "build" }));
  await expect(app(page).getByTestId("group")).toHaveText("Building tools");
  await page.evaluate(() => window.fakeHost.updateProject("alpha", { group: null, visibleAgents: ["codex"] }));
  await expect(app(page).getByTestId("group")).toHaveText("Ungrouped");
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: codex");
  // Another frame of the app writes the folder setting: this one re-lists.
  await setFolderFromAnotherFrame(page);
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/alpha/docs/roadmap/done");
  await expect(row(page, "Projects/alpha/docs/roadmap/done/E-000-old.md")).toContainText("Old");
  // A change to another project is not the shown one's.
  await page.evaluate(() => window.fakeHost.updateProject("beta", { group: "tools", visibleAgents: ["claude"] }));
  await expect(app(page).getByTestId("group")).toHaveText("Ungrouped");
  await expect(app(page).getByTestId("agents")).toHaveText("Agents: codex");
});

/** A second, headless frame of the app writes Alpha's folder setting through the protocol. */
async function setFolderFromAnotherFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = window.fakeHost.attach(() => {});
    frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
    frame.receive({
      channel: "pomade",
      type: "call",
      id: "1",
      method: "project.setSettings",
      params: { projectId: "alpha", settings: { folder: "docs/roadmap/done" } },
    });
  });
}

test("a ticket whose --- block never closes is listed as unreadable", async ({ page }) => {
  await page.evaluate(() => window.fakeHost.writeFile("Projects/alpha/docs/roadmap/T-009-unclosed.md", "---\nid: T-009\nstatus: open\n\n# Never closed\n"));
  await expect(row(page, "Projects/alpha/docs/roadmap/T-009-unclosed.md")).toHaveText("T-009-unclosed.mdcan't read: the leading --- block is not closed");
});

test("Choose folder… uses the host's folder picker, bounded by the project", async ({ page }) => {
  await page.evaluate(() => {
    window.fakeHost.answerPick("Projects/beta/docs/roadmap");
    window.fakeHost.answerPick("Projects/alpha/docs/roadmap/done");
  });
  await app(page).getByTestId("pick-folder").click();
  await expect(app(page).getByTestId("folder")).toHaveText("Projects/alpha/docs/roadmap/done");
  expect(await page.evaluate(() => window.fakeHost.pickRequests)).toEqual([{ root: "Projects/alpha", initial: "Projects/alpha/docs/roadmap" }]);
});

test("shows the project's git repos and follows git changes and project switches", async ({ page }) => {
  await expect(app(page).getByTestId("git")).toHaveText("Git: alpha · main · ● 1 ↑1 · git@github.com:me/alpha.git");
  await page.evaluate(() =>
    window.fakeHost.setGitRepos([
      { name: "alpha", root: "Projects/alpha", absPath: "/Users/me/ws/Projects/alpha", remoteUrl: null, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasCommits: true, changes: [] },
    ]),
  );
  await expect(app(page).getByTestId("git")).toHaveText("Git: alpha · main · ● 0 ↑0 · local only");
  await page.evaluate(() => window.fakeHost.setActiveProject("beta"));
  await expect(app(page).getByTestId("git")).toHaveText("Git: no repository");
});

test("hears platform events it subscribes to: Pomade ready (sticky), a project renamed", async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.fakeHost.subscriptions)).toEqual(["pomade.ready", "project.changed", "project.renamed", "project.updated"]);
  await page.evaluate(() => window.fakeHost.ready());
  await expect(app(page).getByTestId("events")).toHaveText("Last event: Pomade ready");
  await page.evaluate(() => window.fakeHost.updateProject("beta", { name: "Beta 2" }));
  await expect(app(page).getByTestId("events")).toHaveText("Last event: Beta renamed to Beta 2");
  // A frame loaded after Pomade was ready still hears it.
  await app(page).locator("body").evaluate(() => location.reload());
  await expect(app(page).getByTestId("events")).toHaveText("Last event: Pomade ready");
});

test("publishes only while someone listens; subscribers hear it", async ({ page }) => {
  await expect(app(page).getByTestId("listeners")).toHaveText("nobody listens");
  await expect(app(page).getByTestId("greet")).toBeDisabled();
  await page.evaluate(() => {
    const w = window as unknown as { heard: never[]; off: () => void };
    w.heard = [];
    w.off = window.fakeHost.subscribeAs("other", "greeted", w.heard);
  });
  await expect(app(page).getByTestId("listeners")).toHaveText("someone listens");
  await app(page).getByTestId("greet").click();
  await expect.poll(() => page.evaluate(() => window.fakeHost.published)).toEqual([{ name: "greeted", payload: { from: "tab" } }]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { heard: unknown[] }).heard)).toEqual([{ from: "tab" }]);
  await page.evaluate(() => (window as unknown as { off: () => void }).off());
  await expect(app(page).getByTestId("greet")).toBeDisabled();
});

test("posts a notice, for its project, whose click opens its own tab at the roadmap", async ({ page }) => {
  await expect(app(page).locator("tr[data-path]")).toHaveCount(2);
  await app(page).getByTestId("notify").click();
  await expect
    .poll(() => page.evaluate(() => window.fakeHost.notices))
    .toEqual([{ title: "Roadmap ready", body: "2 tickets in Projects/alpha/docs/roadmap", action: { kind: "openApp", route: "roadmap", projectId: "alpha" } }]);
  await page.evaluate(() => window.fakeHost.clickNotice());
  expect(await page.evaluate(() => window.fakeHost.openedTabs)).toEqual([{ kind: "app", route: "roadmap", projectId: "alpha" }]);
});

test("opens its backend's ticker in an attached terminal tab, by reference", async ({ page }) => {
  await app(page).getByTestId("open-ticker").click();
  await expect
    .poll(() => page.evaluate(() => window.fakeHost.openedTabs))
    .toEqual([{ kind: "attached", projectId: "alpha", session: { app: "hello", session: "ticker" } }]);
});

test("says once where its shipped skill is, and always in About", async ({ page }) => {
  const notice = app(page).getByTestId("skill-notice");
  await expect(notice).toBeVisible();
  await expect(app(page).getByTestId("skill-notice-text")).toHaveText(
    "This app ships a skill for agents: hello-roadmap, at /fake/apps/hello/skills/hello-roadmap. To give it to an agent, copy or link that folder into the agent's skills folder.",
  );
  if (process.env.HELLO_SHOTS) await page.screenshot({ path: `${process.env.HELLO_SHOTS}/skill-notice.png` });
  await app(page).getByTestId("skill-notice-dismiss").click();
  await expect(notice).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.fakeHost.state.skillNoticeDismissed)).toBe(true);
  await app(page).locator("body").evaluate(() => location.reload());
  await expect(app(page).getByTestId("state")).toHaveText("Project: Alpha");
  await expect(app(page).getByTestId("about-version")).not.toHaveText("");
  await expect(notice).toBeHidden();
  await app(page).getByTestId("about-toggle").click();
  await expect(app(page).locator('[data-testid="about-skills"] li[data-skill="hello-roadmap"]')).toHaveText(
    "hello-roadmap — /fake/apps/hello/skills/hello-roadmap",
  );
  if (process.env.HELLO_SHOTS) await page.screenshot({ path: `${process.env.HELLO_SHOTS}/about.png` });
});

test("Quick note… opens its overlay from the frame (overlay.open); focus comes back to the button", async ({ page }) => {
  await app(page).getByTestId("open-overlay").click();
  await expect.poll(() => page.evaluate(() => window.fakeHost.overlays)).toEqual([{ route: "note" }]);
  // The overlay takes focus into another frame (here: the harness page), then gives it back to this frame.
  await page.evaluate(() => {
    const away = document.createElement("input");
    document.body.append(away);
    away.focus();
  });
  await expect.poll(() => app(page).locator("body").evaluate(() => document.hasFocus())).toBe(false);
  await page.evaluate(() => document.querySelector("iframe")?.focus());
  await expect(app(page).getByTestId("open-overlay")).toBeFocused();
});

test("Trash scratch files deletes every file in scratch/ in one call; the status says how it went", async ({ page }) => {
  await app(page).getByTestId("scratch-delete").click();
  await expect(app(page).getByTestId("scratch-status")).toHaveText("Nothing to trash in Projects/alpha/scratch");
  await page.evaluate(() => {
    window.fakeHost.writeFile("Projects/alpha/scratch/a.md", "a\n");
    window.fakeHost.writeFile("Projects/alpha/scratch/b.md", "b\n");
  });
  await app(page).getByTestId("scratch-delete").click();
  await expect(app(page).getByTestId("scratch-status")).toHaveText("Trashed 2 of 2");
  expect(await page.evaluate(() => ["a", "b"].map((n) => { try { window.fakeHost.readFile(`Projects/alpha/scratch/${n}.md`); return "kept"; } catch { return "gone"; } }))).toEqual(["gone", "gone"]);
  await app(page).getByTestId("scratch-new").click();
  await expect(app(page).getByTestId("scratch-status")).toHaveText(/^Created Projects\/alpha\/scratch\/scratch-\d+\.md$/);
});
