// The fake host as the parent window of an app frame: the page an app's Playwright e2e opens
// instead of Pomade. `?app=<url>` is the app to load; the fake host is on `window.fakeHost` so
// specs can drive it (writeFile, setActiveProject, …).

import { createFakeHost, mountApp, type FakeHost } from "pomade-kit/fake-host";
import manifest from "../../examples/hello/public/manifest.json" with { type: "json" };

declare global {
  interface Window {
    fakeHost: FakeHost;
  }
}

const fakeHost = createFakeHost({
  manifest,
  pomadeVersion: "0.0.0-e2e",
  projects: [
    { id: "alpha", name: "Alpha", root: "Projects/alpha" },
    { id: "beta", name: "Beta", root: "Projects/beta" },
  ],
  activeProject: "alpha",
  files: {
    "Projects/alpha/docs/roadmap/E-001-first.md": "---\nid: E-001\nstatus: planned\ntitle: First\n---\n",
    "Projects/alpha/docs/roadmap/T-002-broken.md": "---\nid: [oops\n---\n",
    "Projects/alpha/docs/roadmap/notes.txt": "not markdown",
    "Projects/beta/docs/roadmap/E-100-beta.md": "---\nid: E-100\nstatus: done\ntitle: Beta epic\n---\n",
  },
});
window.fakeHost = fakeHost;

const app = new URLSearchParams(location.search).get("app");
if (!app) throw new Error("harness: missing ?app=<url>");
mountApp(fakeHost, { src: app });
