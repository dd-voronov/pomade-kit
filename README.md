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
| `pomade-kit/protocol` | Host API v0 in code: messages, `ProjectRef`, `FileEntry`, `FileChange`, error codes, `Manifest` + `parseManifest`, `HOST_API_VERSION`, message guards, workspace path rules, `readFrontmatter` | browser and Node |
| `pomade-kit/sdk` | `connect()` and the typed client | browser (any `Transport` elsewhere) |
| `pomade-kit/fake-host` | the Host API in memory, for standalone runs and tests | browser and Node |
| `pomade-kit/node` | `resolveWorkspace()` for commands | Node |

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
  await host.info();                            // { pomadeVersion, hostApi, appId, surface }
  await host.project.getActive();               // ProjectRef; the Workspace scope when none
  const off = host.project.onChange((project) => { /* switch */ });

  const { entries } = await host.files.readFolder({ path: "Projects/x/docs/roadmap", recursive: true, frontmatter: true });
  const watch = await host.files.watch({ path: "Projects/x/docs/roadmap", recursive: true }, (changes) => {
    /* FileChange[] — one batch */
  });
  await watch.close();

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
- `host.close()` detaches the client: no more events, pending calls reject.

## Develop and test without Pomade — the fake host

```ts
import { createFakeHost } from "pomade-kit/fake-host";
import { connect } from "pomade-kit/sdk";
import manifest from "./public/manifest.json" with { type: "json" };

const fake = createFakeHost({
  manifest,                                     // sets the app id and the granted capabilities
  projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }],
  activeProject: "alpha",                       // omit for the Workspace scope
  files: { "Projects/alpha/docs/roadmap/E-001-x.md": "---\nid: E-001\nstatus: planned\n---\n" },
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

`fake.keys` lists the forwarded keys; `fake.createTransport()` gives another frame;
`createFakeHost({ hostApi: 1 })` makes the handshake reject.

**Browser e2e (Playwright):** a harness page creates the fake host, puts it on `window` for the
specs, and hosts the app's page in an iframe with `mountApp(fake, { src: appUrl })` — the app
runs unchanged, as inside Pomade. Working setup: `e2e/harness/` and `e2e/hello.spec.ts`, run by
`playwright.config.ts` (the built app served on one origin, the harness on another).

**`dev:fake`:** serve such a harness page with a fixture workspace from the app's own Vite dev
server, with `?app=` pointing at the app's page — a standalone app with live, scriptable data.

## Commands run with Pomade closed

```ts
import { resolveWorkspace } from "pomade-kit/node";
const root = resolveWorkspace();   // absolute POMADE_WORKSPACE, or null
```

Reading the workspace pointer Pomade records joins with `pomade:E-028`.

## Example

`examples/hello/` — the smallest app: lists the active project's `docs/roadmap/` frontmatter rows
and follows project and file events. `npm run hello:build` writes the installable folder
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
