// Hello with its real backend, both against one fake host: the backend (a Node process) connects
// to the fake host's socket as to Pomade, the UI runs in the browser with its frames relayed to
// the same fake host in this test process — so the UI's `apps.call` goes through the fake host's
// broker to the backend and back, and the app's own tabs open, focus and change route as in Pomade.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { connectSocket } from "../src/node/index.js";
import { createFakeHost, type FakeHost, type FrameOptions } from "../src/fake-host/index.js";
import { serveFakeHost, type FakeSocket } from "../src/fake-host/node/index.js";
import manifest from "../examples/hello/public/manifest.json" with { type: "json" };

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = "http://localhost:4317/";
const REMOTE = "http://localhost:4318/remote.html";
const BACKEND = join(ROOT, "examples/hello/public/backend/main.mjs");

/** The backend imports `pomade-kit/node` from dist/: it must be built from the current sources. */
function requireFreshDist(): void {
  const built = join(ROOT, "dist/node/socket.js");
  if (!existsSync(built)) throw new Error("run `npm run build` first: hello's backend runs dist/");
  const newest = (dir: string): number =>
    Math.max(...readdirSync(dir).map((f) => (f.endsWith(".ts") && !f.endsWith(".test.ts") ? statSync(join(dir, f)).mtimeMs : 0)));
  for (const dir of ["src/node", "src/sdk", "src/protocol"]) {
    if (newest(join(ROOT, dir)) > statSync(built).mtimeMs) throw new Error(`dist/ is older than ${dir}: run \`npm run build\``);
  }
}

interface World {
  fake: FakeHost;
  server: FakeSocket;
  userData: string;
  backend: ChildProcess | null;
}

let world: World;

/** Attach a frame of the page to the fake host and mount it: what the host posts is delivered in order. */
async function mountFrame(page: Page, frameId: string, open: FrameOptions): Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  const connection = world.fake.attach((message) => {
    // As JSON text: what postMessage carries is plain JSON, and the page parses it back.
    const text = JSON.stringify(message);
    queue = queue.then(() => page.evaluate(([id, json]) => window.deliver(id, JSON.parse(json)), [frameId, text] as const)).catch(() => undefined);
  }, open);
  frameConnections.set(frameId, connection);
  await page.evaluate(([id, src, surface]) => window.mountFrame(id, src, surface), [frameId, APP, open.tabId !== undefined ? "tab" : (open.surface ?? "tab")] as const);
}

const frameConnections = new Map<string, ReturnType<FakeHost["attach"]>>();

/** A socket client of the app, as a second backend connection would be. */
async function socketClient() {
  const r = await connectSocket({ env: world.server.env("backend"), timeoutMs: 2000 });
  if (r.status !== "connected") throw new Error(`socket client: ${r.status}`);
  return r.host;
}

function frame(page: Page, frameId: string) {
  return page.frameLocator(`iframe[data-frame="${frameId}"]`);
}

/** Start hello's backend with the environment Pomade gives it — without a keeper socket: the
 *  keeper is covered by the keeper's own tests, and the status says the keeper is not running. */
function startBackend(): ChildProcess {
  const { POMADE_KEEPER_SOCKET: _keeper, ...env } = world.server.env("backend");
  const child = spawn(process.execPath, [BACKEND], { stdio: "ignore", env: { ...process.env, ...env } });
  world.backend = child;
  return child;
}

async function stopBackend(): Promise<void> {
  const child = world.backend;
  world.backend = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await gone;
}

test.beforeAll(() => requireFreshDist());

test.beforeEach(async ({ page }) => {
  const userData = mkdtempSync("/tmp/pk-e2e-");
  const fake = createFakeHost({
    manifest,
    pomadeVersion: "0.0.0-e2e",
    projects: [
      { id: "alpha", name: "Alpha", root: "Projects/alpha" },
      { id: "beta", name: "Beta", root: "Projects/beta" },
    ],
    activeProject: "alpha",
    files: { "Projects/alpha/docs/roadmap/E-001-first.md": "---\nid: E-001\nstatus: planned\ntitle: First\n---\n" },
  });
  const server = await serveFakeHost(fake, { userData });
  world = { fake, server, userData, backend: null };
  frameConnections.clear();
  await page.exposeBinding("toHost", (_source, frameId: string, data: unknown) => frameConnections.get(frameId)?.receive(data));
  // A tab the app opens gets a frame; a tab brought to the front is shown.
  fake.onAppTab(({ change, tab }) => {
    const frameId = `tab-${tab.tabId}`;
    if (change === "open") void mountFrame(page, frameId, { tabId: tab.tabId });
    else if (change === "focus") void page.evaluate((id) => window.showTab(id), frameId).catch(() => undefined);
  });
  await page.goto(REMOTE);
  await mountFrame(page, "panel", { surface: "panel", icon: "hello" });
  await expect(frame(page, "panel").getByTestId("state")).toHaveText("Project: Alpha");
});

test.afterEach(async () => {
  await stopBackend();
  for (const connection of frameConnections.values()) connection.detach();
  await world.server.close();
  rmSync(world.userData, { recursive: true, force: true });
});

test("the UI asks its backend through the broker and shows the answer; without the backend it says so", async ({ page }) => {
  const panel = frame(page, "panel");
  await panel.getByTestId("ask-backend").click();
  await expect(panel.getByTestId("backend-status")).toHaveText("Backend: not running");

  const backend = startBackend();
  await expect.poll(() => world.server.clients()).toEqual([{ role: "backend" }]);
  // The backend serves the app's API once connected.
  await expect.poll(() => world.fake.callApi("status").then(() => true, () => false)).toBe(true);
  await panel.getByTestId("ask-backend").click();
  await expect(panel.getByTestId("backend-status")).toHaveText(`Backend: pid ${backend.pid} · keeper not running`);
  await page.screenshot({ path: process.env.KIT_SCREENSHOT_DIR ? join(process.env.KIT_SCREENSHOT_DIR, "backend-status.png") : test.info().outputPath("backend-status.png") });

  // The backend's process ends: its server is withdrawn, the UI falls back.
  await stopBackend();
  await expect.poll(() => world.server.clients()).toEqual([]);
  await panel.getByTestId("ask-backend").click();
  await expect(panel.getByTestId("backend-status")).toHaveText("Backend: not running");
});

test("the backend reconnects when the fake host comes back, and serves again", async ({ page }) => {
  startBackend();
  await expect.poll(() => world.server.clients()).toEqual([{ role: "backend" }]);
  await world.server.close();
  world.server = await serveFakeHost(world.fake, { userData: world.userData });
  await expect.poll(() => world.server.clients(), { timeout: 10_000 }).toEqual([{ role: "backend" }]);
  const panel = frame(page, "panel");
  await panel.getByTestId("ask-backend").click();
  await expect(panel.getByTestId("backend-status")).toHaveText(/^Backend: pid \d+ · keeper not running$/);
});

test("the app's own tab: opened from the UI, focused again, and moved to a new route from a socket client", async ({ page }) => {
  const panel = frame(page, "panel");
  await panel.getByTestId("open-tab").click();
  await expect.poll(() => world.fake.appTabs).toEqual([{ tabId: "app-tab-1", projectId: "alpha", route: "roadmap" }]);
  const tab = frame(page, "tab-app-tab-1");
  await expect(tab.getByTestId("route")).toHaveText("Route: roadmap");

  await panel.getByTestId("open-tab").click();
  await expect.poll(() => world.fake.appTabChanges.map((c) => c.change)).toEqual(["open", "focus"]);

  // A socket client opens the app at another route in that project: the open tab follows.
  const host = await socketClient();
  await host.tabs.openApp({ route: "today", projectId: "alpha" });
  await expect(tab.getByTestId("route")).toHaveText("Route: today");
  expect(world.fake.appTabChanges.map((c) => c.change)).toEqual(["open", "focus", "route", "focus"]);
  // Without a project, a socket client's tab is the Workspace's.
  await host.tabs.openApp({ route: "today" });
  expect(world.fake.appTabs.map((t) => t.projectId)).toEqual(["alpha", "__workspace__"]);
  await expect(frame(page, "tab-app-tab-2").getByTestId("route")).toHaveText("Route: today");
  host.close();
});

test("keyed output tabs: one per run, retitled and closed from inside the tab", async ({ page }) => {
  const panel = frame(page, "panel");
  await panel.getByTestId("open-output-scraper").click();
  await panel.getByTestId("open-output-deploy").click();
  await panel.getByTestId("open-output-scraper").click();
  await expect.poll(() => world.fake.appTabs).toEqual([
    { tabId: "app-tab-1", projectId: "alpha", route: "output/scraper", key: "output:scraper", kind: "output", title: "Scraper · output" },
    { tabId: "app-tab-2", projectId: "alpha", route: "output/deploy", key: "output:deploy", kind: "output", title: "Deploy · output" },
  ]);
  await expect.poll(() => world.fake.appTabChanges.map((c) => c.change)).toEqual(["open", "open", "focus"]);
  // Deploy's tab to the front again.
  await panel.getByTestId("open-output-deploy").click();
  await expect.poll(() => world.fake.appTabChanges.at(-1)).toMatchObject({ change: "focus", tab: { tabId: "app-tab-2" } });
  const deploy = frame(page, "tab-app-tab-2");
  await expect(deploy.getByTestId("tab-key")).toHaveText("Keyed tab output:deploy · kind output");
  await expect(frame(page, "panel").getByTestId("keyed")).toBeHidden();
  await deploy.getByTestId("retitle-tab").click();
  await expect.poll(() => world.fake.appTabs[1]?.title).toBe("Deploy · done");
  await deploy.getByTestId("close-tab").click();
  await expect.poll(() => world.fake.appTabs.map((t) => t.key)).toEqual(["output:scraper"]);
});
