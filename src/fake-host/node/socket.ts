// The fake host's socket side (HOST-API §3 "Socket"): a unix socket an app's backend and commands
// connect to as to Pomade — the same line framing, the identity in `hello` checked against a key
// file issued the way Pomade issues it, the same handshake, calls, broker requests and events.
// Every authenticated connection is a backend or command session of the in-memory fake host, so a
// frame's `apps.call` reaches the backend that called `api.serve`, as in Pomade.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import {
  CHANNEL,
  POMADE_ENV,
  createLineDecoder,
  encodeLine,
  keeperSocketPath,
  parseAppMessage,
  socketPathProblem,
  type ClientRole,
  type HostToAppMessage,
  type SocketClient,
} from "../../protocol/index.js";
import type { FakeHost, FrameConnection } from "../fake-host.js";

/** Where Pomade keeps its socket and the app keys, relative to its user data. */
const SOCKET_FILE = "run/pomade.sock";
const APP_KEYS_DIR = "app-keys";
const APP_STATE_DIR = "app-state";
/** A connection that has not been welcomed by then is closed, as by Pomade. */
const HELLO_TIMEOUT_MS = 5000;

export interface FakeSocketOptions {
  /** The Pomade user-data folder the fake stands for: the socket is `<userData>/run/pomade.sock`
   *  (≤ 103 bytes on macOS), the app's key `<userData>/app-keys/<appId>`. Created as needed. */
  userData: string;
  /** How long a connection may stay without a welcome. Default 5000 ms, as Pomade. */
  helloTimeoutMs?: number;
  /** The app's state folder (`POMADE_APP_STATE`). Default `<userData>/app-state/<appId>`, as
   *  Pomade lays it out. Created as needed; never removed. */
  appState?: string;
}

/** A welcomed socket client of the fake host. */
export interface FakeSocketClient {
  role: ClientRole;
}

export interface FakeSocket {
  /** `<userData>/run/pomade.sock`. */
  readonly socketPath: string;
  /** The app's key file, `<userData>/app-keys/<appId>` (mode 0600). Deleting it revokes the key:
   *  the next `hello` is refused. */
  readonly keyFile: string;
  /** The app's key (the key file's content). */
  readonly key: string;
  /** The app's state folder (`FakeSocketOptions.appState`); it exists once the server is up. */
  readonly appState: string;
  /** The environment Pomade gives the app's backend (`"backend"`, the default) or one of its
   *  commands: `POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT`, `POMADE_SOCKET`,
   *  `POMADE_APP_STATE`, `POMADE_WORKSPACE` (the fake's `workspaceRoot`) and, for a backend,
   *  `POMADE_KEEPER_SOCKET`.
   *  Add it to a spawned process's environment. */
  env(role?: ClientRole): Record<string, string>;
  /** The welcomed connections now, in connection order. */
  clients(): FakeSocketClient[];
  /** Pomade quits: every connection closes and the socket file is removed. The key file stays. */
  close(): Promise<void>;
}

interface Connection {
  socket: Socket;
  /** The fake host session while welcomed. */
  session: FrameConnection | null;
  role: ClientRole | null;
}

/** Is the identity the one Pomade issued for this app, in a role the app has? */
async function authenticate(fake: FakeHost, keyFile: string, client: SocketClient | undefined): Promise<ClientRole | null> {
  if (!client || client.appId !== fake.manifest.id) return null;
  let issued: string;
  try {
    issued = (await readFile(keyFile, "utf8")).trim();
  } catch {
    return null;
  }
  if (issued === "" || client.key !== issued) return null;
  // A backend's identity is only for an app that declares one; a command's, for one that ships commands.
  if (client.role === "backend" && fake.manifest.backend === undefined) return null;
  if (client.role === "command" && (fake.manifest.commands ?? []).length === 0) return null;
  return client.role;
}

/** Issue the app's key the way Pomade does: 32 random bytes, hex, in a 0600 file in a 0700 folder; an existing key is kept. */
async function issueKey(userData: string, appId: string): Promise<{ keyFile: string; key: string }> {
  const dir = join(userData, APP_KEYS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const keyFile = join(dir, appId);
  const existing = await readFile(keyFile, "utf8").then(
    (text) => text.trim(),
    () => "",
  );
  if (existing !== "") return { keyFile, key: existing };
  const key = randomBytes(32).toString("hex");
  await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  return { keyFile, key };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Serve `fake` on a unix socket, as Pomade serves its Host API to app backends and commands. The
 * app's key is issued under `userData` (kept when one is there). A connection's `hello` must carry
 * the app's id, its key and a role the manifest has (`backend` needs `backend`, `command` needs
 * `commands`), else it is refused with `unauthorized` — Pomade's own platform client included, as
 * the fake hosts one app. A welcomed connection is a session of the fake host with surface
 * `backend` or `command`: it gets no event it did not subscribe to, the frame-only methods are
 * `capability-denied`, its default project is the Workspace scope, and its `api.serve` takes
 * precedence over a frame's.
 */
export async function serveFakeHost(fake: FakeHost, options: FakeSocketOptions): Promise<FakeSocket> {
  const userData = options.userData.replace(/\/+$/, "");
  const socketPath = join(userData, SOCKET_FILE);
  const tooLong = socketPathProblem(socketPath);
  if (tooLong) throw new Error(`fake host: ${tooLong}`);
  const appId = fake.manifest.id;
  const { keyFile, key } = await issueKey(userData, appId);
  // As Pomade: the state folder exists before a backend or command is started with it.
  const appState = options.appState ?? join(userData, APP_STATE_DIR, appId);
  await mkdir(appState, { recursive: true });
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const connections = new Set<Connection>();

  const send = (c: Connection, message: HostToAppMessage): void => {
    if (!c.socket.destroyed) c.socket.write(encodeLine(message));
  };
  const endSession = (c: Connection): void => {
    c.session?.detach();
    c.session = null;
    c.role = null;
  };

  const onHello = async (c: Connection, hostApi: number, client: SocketClient | undefined, hello: unknown): Promise<void> => {
    endSession(c);
    if (hostApi !== fake.hostApi) {
      send(c, { channel: CHANNEL, type: "reject", reason: hostApi > fake.hostApi ? "needs-newer-pomade" : "app-too-old", hostApi: fake.hostApi });
      return;
    }
    const role = await authenticate(fake, keyFile, client);
    if (c.socket.destroyed) return;
    if (role === null) {
      send(c, { channel: CHANNEL, type: "reject", reason: "unauthorized", hostApi: fake.hostApi });
      return;
    }
    c.role = role;
    c.session = fake.attach((message) => send(c, message), { surface: role });
    c.session.receive(hello);
  };

  const onConnection = (socket: Socket): void => {
    const c: Connection = { socket, session: null, role: null };
    connections.add(c);
    const decoder = createLineDecoder();
    const helloTimer = setTimeout(() => {
      if (!c.session) socket.destroy();
    }, helloTimeoutMs);
    // Messages are handled in order: a call right after `hello` waits for the handshake.
    let queue: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const data of messages) {
        const msg = parseAppMessage(data);
        if (!msg) continue;
        if (msg.type === "hello") {
          queue = queue.then(() => onHello(c, msg.hostApi, msg.client, data));
          continue;
        }
        queue = queue.then(() => {
          if (c.session) c.session.receive(data);
          else if (msg.type === "call") send(c, { channel: CHANNEL, type: "result", id: msg.id, ok: false, error: { code: "not-ready", message: "call before welcome" } });
        });
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      endSession(c);
      connections.delete(c);
    });
  };

  await mkdir(join(userData, "run"), { recursive: true, mode: 0o700 });
  await chmod(join(userData, "run"), 0o700);
  await rm(socketPath, { force: true });
  const server = createServer(onConnection);
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    keyFile,
    key,
    appState,
    env(role: ClientRole = "backend") {
      return {
        [POMADE_ENV.appId]: appId,
        [POMADE_ENV.keyFile]: keyFile,
        [POMADE_ENV.role]: role,
        [POMADE_ENV.socket]: socketPath,
        [POMADE_ENV.appState]: appState,
        [POMADE_ENV.workspace]: fake.workspaceRoot,
        ...(role === "backend" ? { [POMADE_ENV.keeperSocket]: keeperSocketPath(userData, appId) } : {}),
      };
    },
    clients() {
      return [...connections].flatMap((c) => (c.role !== null && c.session ? [{ role: c.role }] : []));
    },
    async close() {
      for (const c of connections) c.socket.destroy();
      // Node removes the socket file as the server closes.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
