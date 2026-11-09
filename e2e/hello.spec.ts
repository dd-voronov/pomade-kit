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
  await expect(row(page, "Projects/alpha/docs/roadmap/E-001-first.md")).toHaveText(/E-001-first\.mdE-001plannedFirst/);
  await expect(row(page, "Projects/alpha/docs/roadmap/T-002-broken.md")).toContainText("can't read:");
  await expect(app(page).locator("tr[data-path]")).toHaveCount(2);
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

test("standalone (no host): shows the no-host state", async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByTestId("state")).toHaveText("No Pomade host — open this app inside Pomade.");
});
