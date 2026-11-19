// The fake host as the parent window of an app frame: the page an app's Playwright e2e opens
// instead of Pomade. `?app=<url>` is the app to load; the fake host is on `window.fakeHost` so
// specs can drive it (writeFile, setActiveProject, …), and the mounted frame on `window.mounted`
// (navigate; `overlay` is the overlay it opened). `?shortcut=<id>` mounts it as that shortcut's overlay.

import { createFakeHost, mountApp, type FakeHost, type MountedApp } from "pomade-kit/fake-host";
import manifest from "../../examples/hello/public/manifest.json" with { type: "json" };

declare global {
  interface Window {
    fakeHost: FakeHost;
    mounted: MountedApp;
  }
}

const fakeHost = createFakeHost({
  manifest,
  pomadeVersion: "0.0.0-e2e",
  groups: [
    { id: "build", name: "Building tools" },
    { id: "tools", name: "Tools", parent: "build" },
  ],
  projects: [
    { id: "alpha", name: "Alpha", root: "Projects/alpha", group: "tools", visibleAgents: ["claude", "codex"] },
    { id: "beta", name: "Beta", root: "Projects/beta" },
  ],
  activeProject: "alpha",
  git: [
    { name: "alpha", root: "Projects/alpha", absPath: "/Users/me/ws/Projects/alpha", remoteUrl: "git@github.com:me/alpha.git", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, hasCommits: true, changes: [{ path: "Projects/alpha/docs/roadmap/E-001-first.md", status: "modified" }] },
  ],
  files: {
    "Projects/alpha/docs/roadmap/E-001-first.md": "---\nid: E-001\nstatus: planned\ntitle: First\n---\n",
    "Projects/alpha/docs/roadmap/T-002-broken.md": "---\nid: [oops\n---\n",
    "Projects/alpha/docs/roadmap/notes.txt": "not markdown",
    "Projects/alpha/docs/roadmap/done/E-000-old.md": "---\nid: E-000\nstatus: done\ntitle: Old\n---\n",
    "Projects/beta/docs/roadmap/E-100-beta.md": "---\nid: E-100\nstatus: done\ntitle: Beta epic\n---\n",
  },
});
window.fakeHost = fakeHost;

const query = new URLSearchParams(location.search);
const app = query.get("app");
if (!app) throw new Error("harness: missing ?app=<url>");
// `?shortcut=<id>` opens the app as the overlay that shortcut opens.
const shortcut = query.get("shortcut");
window.mounted = mountApp(fakeHost, { src: app, ...(shortcut ? { surface: "overlay", shortcut } : {}) });
