// The frame relay (`serveFrameRelay`): an app's real frames in the relay's shell page and a
// scripted backend on the fake host's socket (`serveFakeHost`) talk to one fake host — a broker call
// from a frame reaches the backend, an event the backend publishes reaches the frame, the frame's
// `tabs.openApp` lands in the fake host's tab model and the page shows the tab, which follows route
// changes; an overlay a frame opens is mounted as `mountApp` mounts it.

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { connectSocket } from "../src/node/index.js";
import type { HostClient } from "../src/sdk/index.js";
import { createFakeHost, type FakeHost } from "../src/fake-host/index.js";
import { serveFakeHost, serveFrameRelay, type FakeSocket, type FrameRelay } from "../src/fake-host/node/index.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = "http://localhost:4318/relay-app.html";

const MANIFEST = {
  id: "relay-test",
  name: "Relay test",
  version: "0.1.0",
  hostApi: 0,
  icon: "relay-app.svg",
  capabilities: ["project.read"],
  strip: [{ id: "board", title: "Board", action: "both", route: "board", panelRoute: "panel" }],
  api: ["echo"],
  events: { publish: ["pinged"], subscribe: ["relay-test:pinged"] },
  backend: { entry: "backend/main.mjs", mode: "with-pomade" },
};

/** The relay's page runs the built kit (dist/): it must be built from the current sources. */
function requireFreshDist(): void {
  const built = join(ROOT, "dist/fake-host/relay-shell.js");
  if (!existsSync(built)) throw new Error("run `npm run build` first: the relay's page runs dist/");
  const newest = (dir: string): number =>
    Math.max(...readdirSync(dir).map((f) => (f.endsWith(".ts") && !f.endsWith(".test.ts") ? statSync(join(dir, f)).mtimeMs : 0)));
  for (const dir of ["src/fake-host", "src/protocol"]) {
    if (newest(join(ROOT, dir)) > statSync(built).mtimeMs) throw new Error(`dist/ is older than ${dir}: run \`npm run build\``);
  }
}

interface World {
  userData: string;
  fake: FakeHost;
  server: FakeSocket;
  relay: FrameRelay;
  /** The scripted backend: a socket client of the app serving `echo`. */
  backend: HostClient;
}

let world: World;

test.beforeAll(() => requireFreshDist());

test.beforeEach(async () => {
  const userData = mkdtempSync("/tmp/pk-relay-");
  const fake = createFakeHost({
    manifest: MANIFEST,
    pomadeVersion: "0.0.0-e2e",
    projects: [
      { id: "alpha", name: "Alpha", root: "Projects/alpha" },
      { id: "beta", name: "Beta", root: "Projects/beta" },
    ],
    activeProject: "alpha",
  });
  const server = await serveFakeHost(fake, { userData });
  const relay = await serveFrameRelay(fake, { app: APP });
  const r = await connectSocket({ env: server.env("backend"), timeoutMs: 2000 });
  if (r.status !== "connected") throw new Error(`backend: ${r.status}`);
  await r.host.api.serve({ echo: (params) => ({ echoed: (params as { text: string }).text, by: "backend" }) });
  world = { userData, fake, server, relay, backend: r.host };
});

test.afterEach(async () => {
  world.backend.close();
  await world.relay.close();
  await world.server.close();
  rmSync(world.userData, { recursive: true, force: true });
});

test("a frame calls the backend through the broker and hears the events it publishes; the backend has its state folder", async ({ page }) => {
  expect(statSync(world.server.env().POMADE_APP_STATE ?? "").isDirectory()).toBe(true);
  await page.goto(world.relay.url);
  const panel = page.frameLocator('[data-testid="panel-frame-board"]');
  await expect(panel.getByTestId("where")).toHaveText("panel · panel");
  await expect(page.getByTestId("strip-board")).toHaveAttribute("aria-pressed", "true");

  await panel.getByTestId("ask").click();
  await expect(panel.getByTestId("answer")).toHaveText('{"echoed":"hello","by":"backend"}');

  await expect(panel.getByTestId("subscribed")).toHaveText("subscribed");
  await world.backend.events.publish("pinged", { n: 1 });
  await expect(panel.getByTestId("heard")).toHaveText('{"n":1}');
});

test("tabs.openApp from a frame lands in the fake host's tab model; the page shows the tab, which follows route changes and closes", async ({ page }) => {
  await page.goto(world.relay.url);
  const panel = page.frameLocator('[data-testid="panel-frame-board"]');
  await panel.getByTestId("open-tab").click();
  await expect.poll(() => world.fake.appTabs).toEqual([{ tabId: "app-tab-1", projectId: "alpha", route: "notes/1" }]);
  const tab = page.frameLocator('[data-testid="tab-frame-app-tab-1"]');
  await expect(tab.getByTestId("where")).toHaveText("tab · notes/1");
  await expect(page.getByTestId("tab-app-tab-1")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: process.env.KIT_SCREENSHOT_DIR ? join(process.env.KIT_SCREENSHOT_DIR, "kt024-relay-shell.png") : test.info().outputPath("relay-shell.png") });

  // The backend moves the app's tab in that project: the frame showing it follows.
  await world.backend.tabs.openApp({ route: "notes/2", projectId: "alpha" });
  await expect(tab.getByTestId("where")).toHaveText("tab · notes/2");

  // A strip icon whose action opens a tab opens the icon's tab beside it.
  await page.getByTestId("strip-board").click();
  await expect.poll(() => world.fake.appTabs.map((t) => t.tabId)).toEqual(["app-tab-1", "app-tab-2"]);
  await expect(page.frameLocator('[data-testid="tab-frame-app-tab-2"]').getByTestId("where")).toHaveText("tab · board");
  await expect(page.getByTestId("tab-app-tab-1")).toHaveAttribute("aria-selected", "false");

  // The user closes the first tab: the fake host's model drops it, and its frame goes.
  await page.getByTestId("close-tab-app-tab-1").click();
  await expect.poll(() => world.fake.appTabs.map((t) => t.tabId)).toEqual(["app-tab-2"]);
  await expect(page.getByTestId("tab-frame-app-tab-1")).toHaveCount(0);
  await expect(page.getByTestId("tab-app-tab-1")).toHaveCount(0);
});

test("tabs the fake host has open when the page connects are shown, the last in front", async ({ page }) => {
  world.fake.openAppTab({ route: "notes/1" });
  world.fake.openAppTab({ projectId: "beta", route: "notes/2" });
  await page.goto(world.relay.url);
  await expect(page.frameLocator('[data-testid="tab-frame-app-tab-1"]').getByTestId("where")).toHaveText("tab · notes/1");
  await expect(page.frameLocator('iframe[data-surface="tab"][data-project-id="beta"]').getByTestId("where")).toHaveText("tab · notes/2");
  await expect(page.getByTestId("tab-frame-app-tab-1")).toBeHidden();
  await expect(page.getByTestId("tab-frame-app-tab-2")).toBeVisible();
});

test("an overlay a frame opens is mounted over a scrim with the focus, with clipboard-write like every frame, and closes back to its opener", async ({ page }) => {
  await page.goto(world.relay.url);
  const panel = page.frameLocator('[data-testid="panel-frame-board"]');
  await expect(page.getByTestId("panel-frame-board")).toHaveAttribute("allow", "clipboard-write");
  await panel.getByTestId("open-overlay").click();
  const overlay = page.locator('iframe[data-surface="overlay"]');
  await expect(page.frameLocator('iframe[data-surface="overlay"]').getByTestId("where")).toHaveText("overlay · quick");
  await expect(overlay).toBeFocused();
  await expect(overlay).toHaveAttribute("allow", "clipboard-write");
  await page.screenshot({ path: process.env.KIT_SCREENSHOT_DIR ? join(process.env.KIT_SCREENSHOT_DIR, "kt024-relay-overlay.png") : test.info().outputPath("relay-overlay.png") });

  await page.frameLocator('iframe[data-surface="overlay"]').getByTestId("close-overlay").click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("panel-frame-board")).toBeFocused();
});

test("a page that goes away detaches its frames; the relay closing tells the page", async ({ page, context }) => {
  await page.goto(world.relay.url);
  await expect(page.frameLocator('[data-testid="panel-frame-board"]').getByTestId("subscribed")).toHaveText("subscribed");
  expect(world.relay.sessions()).toBe(1);
  expect(await world.backend.events.hasSubscribers("pinged")).toBe(true);

  const second = await context.newPage();
  await second.goto(world.relay.url);
  await expect.poll(() => world.relay.sessions()).toBe(2);
  await second.close();
  await expect.poll(() => world.relay.sessions()).toBe(1);

  await world.relay.close();
  expect(world.relay.sessions()).toBe(0);
  await expect.poll(() => world.backend.events.hasSubscribers("pinged")).toBe(false);
  await expect(page.locator("html")).toHaveAttribute("data-relay", "closed");
});

test("the relay serves only the built kit's scripts and styles, and refuses posts outside a session", async () => {
  const at = (path: string, init?: RequestInit): Promise<number> => fetch(new URL(path, world.relay.url), init).then((r) => r.status);
  expect(await at("kit/fake-host/relay-shell.js")).toBe(200);
  expect(await at("kit/tokens.css")).toBe(200);
  expect(await at("kit/fake-host/relay-shell.js.map")).toBe(404);
  expect(await at("kit/..%2Fnode_modules/js-yaml/index.js")).toBe(404);
  expect(await at("kit/..%2Fsrc/fake-host/node/relay.ts")).toBe(404);
  expect(await at("send?session=nope", { method: "POST", body: "[]" })).toBe(410);
  expect(await at("elsewhere")).toBe(404);
});
