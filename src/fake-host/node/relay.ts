// The frame relay: an HTTP server beside the fake host in Node that serves a shell page — a window
// laid out as Pomade's — hosting an app's real frames, and carries each frame's Host API traffic
// between the page (postMessage) and the fake host. With `serveFakeHost` on the same fake host, the
// frames and the app's backend talk to one host: a frame's `apps.call` reaches the backend's
// `api.serve`, an event the backend publishes reaches the frames, a frame's `tabs.openApp` opens a
// tab the page shows.
//
// The page's script is the kit's own browser code (`relay-shell.ts`, which mounts frames with
// `mountApp`), served from the built kit (`dist/`). The page streams from the server (server-sent
// events) and posts to it (`relay-wire.ts`); one stream is one session, and its frames are detached
// when it ends.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { FakeHost, FrameConnection } from "../fake-host.js";
import type { RelayFrameId, RelayToShell, ShellToRelay } from "../relay-wire.js";

/** The built kit: `dist/` of the package, whether this module runs from `dist/` or from `src/`. */
const KIT_DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const SHELL_SCRIPT = "fake-host/relay-shell.js";
/** What the page may load from the built kit, by extension. */
const ASSET_TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
/** The largest batch the page may post. */
const MAX_BODY = 64 * 1024 * 1024;

export interface FrameRelayOptions {
  /** The app's page (an absolute URL), on its own origin as Pomade serves an app; every frame loads it. */
  app: string;
  /** The port to listen on, on 127.0.0.1. Default: a free one. */
  port?: number;
}

export interface FrameRelay {
  /** The shell page: open it in a browser. */
  readonly url: string;
  /** How many shell pages are connected now. */
  sessions(): number;
  /** Stop serving: every page's frames are detached and its stream ends. */
  close(): Promise<void>;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake Pomade</title>
<link rel="stylesheet" href="kit/tokens.css">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; overflow: hidden; font-family: var(--font-ui); font-size: var(--fs-base); line-height: var(--lh); color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; }
button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.strip { display: flex; flex: none; flex-direction: column; align-items: center; gap: var(--space-2); width: var(--strip-w); padding: var(--space-2) 0; border-right: 1px solid var(--border); background: var(--panel); }
.stripButton { position: relative; display: inline-flex; align-items: center; justify-content: center; width: var(--strip-btn); height: var(--strip-btn); padding: 0; border: none; border-radius: var(--radius-md); background: transparent; color: var(--text-muted); font-size: var(--fs-sm); font-weight: var(--fw-semibold); cursor: pointer; }
.stripButton:hover { background: var(--hover-bg); }
.stripButton[aria-pressed="true"] { background: var(--active-bg); }
.stripButton[aria-pressed="true"]::before { content: ""; position: absolute; left: -6px; top: 25%; width: 2px; height: 50%; border-radius: 0 1px 1px 0; background: var(--accent); }
.stripButton .icon { width: var(--strip-icon); height: var(--strip-icon); }
.panel { position: relative; display: flex; flex: none; flex-direction: column; width: var(--sidebar-w); border-right: 1px solid var(--border); background: var(--bg); }
.panelHeader { flex: none; padding: var(--space-3) var(--space-3) var(--space-2) var(--space-4); color: var(--text-faint); font-size: var(--fs-xs); font-weight: var(--fw-semibold); letter-spacing: 0.06em; text-transform: uppercase; }
.panel > iframe { display: block; flex: 1; width: 100%; min-height: 0; border: 0; }
.main { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.tabStrip { display: flex; flex: none; align-items: flex-end; gap: 2px; height: var(--tabstrip-h); padding: 0 var(--space-2); border-bottom: 1px solid var(--border); background: var(--panel); }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; height: 30px; padding: 0 var(--space-2) 0 var(--space-3); border: 1px solid transparent; border-bottom: none; border-radius: var(--radius-md) var(--radius-md) 0 0; background: transparent; color: var(--text-muted); font-size: var(--fs-sm); cursor: pointer; }
.tab:hover { background: var(--hover-bg); }
.tab[aria-selected="true"] { border-color: var(--border); background: var(--panel-raised); color: var(--text); }
.tab .icon { flex: none; width: 14px; height: 14px; }
.tabLabel { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tabClose { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px; border-radius: var(--radius-sm); color: var(--text-faint); }
.tabClose:hover { background: var(--hover-bg); color: var(--text); }
.newTab { align-self: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; }
.newTab:hover { background: var(--hover-bg); color: var(--text); }
.panes { position: relative; flex: 1; min-height: 0; background: var(--panel-raised); }
.panes > iframe { position: absolute; inset: 0; display: block; width: 100%; height: 100%; border: 0; }
.empty { margin: 0; padding: var(--space-6); color: var(--text-faint); font-size: var(--fs-sm); text-align: center; }
html[data-relay="closed"] body::after { content: "The fake host's relay closed"; position: fixed; left: 50%; bottom: var(--space-4); transform: translateX(-50%); padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); background: var(--danger); color: var(--accent-contrast); font-size: var(--fs-sm); }
</style>
</head>
<body>
<script type="module" src="kit/${SHELL_SCRIPT}"></script>
</body>
</html>
`;

interface Session {
  readonly id: string;
  readonly frames: Map<RelayFrameId, FrameConnection>;
  write(message: RelayToShell): void;
  /** The stream ended (the page went away, or the relay closes): detach its frames. */
  end(): void;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("frame relay: no port"));
      else resolvePort(address.port);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Serve a shell page hosting the app's frames against `fake` (normally also served to the app's
 * backend with `serveFakeHost`): the app's strip icons, the side panel (the first panel icon's
 * frame shown, another's on its icon's click), and the tab strip with the app's own tabs
 * (`fake.appTabs` — opened by `tabs.openApp`, a strip icon that opens a tab, the "+" button, or
 * `fake.openAppTab`; focused, retitled and closed as the fake host's tab model says; each with a
 * frame showing it). Frames are mounted as `mountApp` mounts them (clipboard-write; an overlay a
 * frame opens sits over a scrim and takes focus). Needs the built kit (`dist/`).
 */
export async function serveFrameRelay(fake: FakeHost, options: FrameRelayOptions): Promise<FrameRelay> {
  if (!existsSync(resolve(KIT_DIST, SHELL_SCRIPT))) throw new Error(`frame relay: the built kit is missing (${resolve(KIT_DIST, SHELL_SCRIPT)}): run \`npm run build\``);
  const appUrl = new URL(options.app).href;
  const sessions = new Map<string, Session>();

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const unfollow = fake.onAppTab((change) => session.write({ type: "appTab", change }));
    const session: Session = {
      id: randomUUID(),
      frames: new Map(),
      write(message) {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
      },
      end() {
        if (!sessions.delete(session.id)) return;
        unfollow();
        for (const frame of session.frames.values()) frame.detach();
        session.frames.clear();
        if (!res.writableEnded) res.end();
      },
    };
    sessions.set(session.id, session);
    req.on("close", () => session.end());
    const { id, name, icon, strip } = fake.manifest;
    session.write({ type: "ready", session: session.id, app: { id, name, icon: icon ?? null, strip: strip ?? [], url: appUrl } });
    // The tabs open before the page connected, as Pomade restores them at launch.
    for (const tab of fake.appTabs) session.write({ type: "appTab", change: { change: "open", tab } });
  };

  const handle = (session: Session, message: ShellToRelay): void => {
    const { write } = session;
    switch (message.type) {
      case "attach": {
        const { frame } = message;
        session.frames.get(frame)?.detach();
        try {
          session.frames.set(
            frame,
            fake.attach((data) => write({ type: "post", frame, message: data }), {
              ...message.options,
              onClose: () => write({ type: "close", frame }),
              onOverlayOpen: (overlay) => write({ type: "overlayOpen", frame, overlay }),
              onOverlayResize: (height) => write({ type: "overlayResize", frame, height }),
            }),
          );
        } catch {
          // The tab closed while the page was mounting its frame: the frame closes too.
          session.frames.delete(frame);
          write({ type: "close", frame });
        }
        return;
      }
      case "receive":
        session.frames.get(message.frame)?.receive(message.data);
        return;
      case "navigate":
        session.frames.get(message.frame)?.navigate(message.route);
        return;
      case "hidden":
        session.frames.get(message.frame)?.setHidden(message.hidden);
        return;
      case "detach":
        session.frames.get(message.frame)?.detach();
        session.frames.delete(message.frame);
        return;
      case "openAppTab":
        fake.openAppTab(message.icon === undefined ? {} : { icon: message.icon });
        return;
      case "closeAppTab":
        if (fake.appTabs.some((t) => t.tabId === message.tabId)) fake.closeAppTab(message.tabId);
        return;
    }
  };

  const receive = async (req: IncomingMessage, res: ServerResponse, sessionId: string | null): Promise<void> => {
    const session = sessionId === null ? undefined : sessions.get(sessionId);
    if (!session) {
      res.writeHead(410).end();
      return;
    }
    let messages: ShellToRelay[];
    try {
      messages = JSON.parse(await readBody(req)) as ShellToRelay[];
      if (!Array.isArray(messages)) throw new Error("not a batch");
    } catch {
      res.writeHead(400).end();
      return;
    }
    for (const message of messages) handle(session, message);
    res.writeHead(204).end();
  };

  const asset = async (res: ServerResponse, path: string): Promise<void> => {
    const file = resolve(KIT_DIST, path);
    const type = ASSET_TYPES[extname(file)];
    if (!file.startsWith(KIT_DIST.endsWith(sep) ? KIT_DIST : KIT_DIST + sep) || type === undefined) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/") res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
    else if (req.method === "GET" && url.pathname === "/events") openStream(req, res);
    else if (req.method === "POST" && url.pathname === "/send") void receive(req, res, url.searchParams.get("session"));
    else if (req.method === "GET" && url.pathname.startsWith("/kit/")) void asset(res, decodeURIComponent(url.pathname.slice("/kit/".length)));
    else res.writeHead(404).end();
  });
  const port = await listen(server, options.port ?? 0);

  return {
    url: `http://127.0.0.1:${port}/`,
    sessions: () => sessions.size,
    async close() {
      for (const session of [...sessions.values()]) session.end();
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      server.closeAllConnections();
      await closed;
    },
  };
}
