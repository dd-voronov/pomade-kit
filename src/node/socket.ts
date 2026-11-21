// The Host API over Pomade's local socket (HOST-API §3 "Socket"): how an app's backend or command
// connects. Same handshake, same typed client as a frame's `connect()`; only the channel and the
// identity in `hello` differ.

import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

import {
  CHANNEL,
  CLIENT_ROLES,
  HOST_API_VERSION,
  POMADE_ENV,
  createLineDecoder,
  encodeLine,
  parseHostMessage,
  type ClientRole,
  type RejectReason,
} from "../protocol/index.js";
import { createClient, type HostClient } from "../sdk/client.js";
import type { Transport } from "../sdk/transport.js";
import { readHostRecord, type Env } from "./home.js";

/** How long to wait for `welcome` once connected. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface SocketConnectOptions {
  /** Default: `POMADE_SOCKET`, else the socket in the host record (`POMADE_HOME`/host.json). */
  socketPath?: string;
  /** Default: `POMADE_APP_ID`. */
  appId?: string;
  /** The app's key. Default: read from `keyFile`. */
  key?: string;
  /** Default: `POMADE_APP_KEY_FILE`. */
  keyFile?: string;
  /** Default: `POMADE_CLIENT`, else `"command"`. */
  role?: ClientRole;
  /** Where the defaults are read. Default `process.env`. */
  env?: Env;
  /** How long to wait for Pomade's answer once connected. Default 5000 ms. */
  timeoutMs?: number;
}

export type SocketConnectResult =
  | { status: "connected"; host: HostClient }
  /** Nothing is listening on the socket (Pomade is closed), or it did not answer in time. */
  | { status: "not-running"; reason: string }
  /** `unauthorized`: the id, key or role is not one Pomade issued; otherwise a version mismatch. */
  | { status: "rejected"; reason: RejectReason; hostApi: number };

/** A transport over a connected socket: one JSON message per line. */
export function socketTransport(socket: Socket): Transport {
  const listeners = new Set<(data: unknown) => void>();
  const ends = new Set<() => void>();
  const decoder = createLineDecoder();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const cb of [...ends]) cb();
    ends.clear();
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const m of messages) for (const listener of [...listeners]) listener(m);
  });
  socket.on("close", end);
  socket.on("error", () => socket.destroy());
  return {
    send(message) {
      if (!socket.destroyed) socket.write(encodeLine(message));
    },
    listen(onMessage) {
      listeners.add(onMessage);
      return () => listeners.delete(onMessage);
    },
    onEnd(onEnd) {
      if (ended) {
        onEnd();
        return () => undefined;
      }
      ends.add(onEnd);
      return () => ends.delete(onEnd);
    },
  };
}

function required(value: string | undefined, what: string, env: string): string {
  if (value === undefined || value === "") {
    throw new Error(`pomade-kit: no ${what} — set ${env} or pass it to connectSocket()`);
  }
  return value;
}

interface Resolved {
  socketPath: string | null;
  appId: string;
  key: string;
  role: ClientRole;
}

function resolveOptions(options: SocketConnectOptions): Resolved {
  const env = options.env ?? process.env;
  const appId = required(options.appId ?? env[POMADE_ENV.appId], "app id", POMADE_ENV.appId);
  let key = options.key;
  if (key === undefined) {
    const keyFile = required(options.keyFile ?? env[POMADE_ENV.keyFile], "key file", POMADE_ENV.keyFile);
    key = readFileSync(keyFile, "utf8").trim();
  }
  const roleValue = options.role ?? env[POMADE_ENV.role] ?? "command";
  if (!(CLIENT_ROLES as readonly string[]).includes(roleValue)) {
    throw new Error(`pomade-kit: ${POMADE_ENV.role} must be one of ${CLIENT_ROLES.join(", ")} (got ${JSON.stringify(roleValue)})`);
  }
  const socketPath = options.socketPath || env[POMADE_ENV.socket] || readHostRecord(env)?.socket || null;
  return { socketPath, appId, key, role: roleValue as ClientRole };
}

/**
 * Connect to the running Pomade over its socket and perform the handshake. Resolves with a
 * client, `not-running` (Pomade is closed — fall back or launch it), or `rejected`. Throws only
 * when the caller's identity is not configured (no app id or key).
 */
export function connectSocket(options: SocketConnectOptions = {}): Promise<SocketConnectResult> {
  const { socketPath, appId, key, role } = resolveOptions(options);
  if (socketPath === null) return Promise.resolve({ status: "not-running", reason: "no Pomade socket is recorded" });
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (result: SocketConnectResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (result.status !== "connected") socket.destroy();
      resolve(result);
    };
    const deadline = setTimeout(
      () => settle({ status: "not-running", reason: "Pomade did not answer" }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    socket.once("error", (err: NodeJS.ErrnoException) => settle({ status: "not-running", reason: err.code ?? err.message }));
    socket.once("close", () => settle({ status: "not-running", reason: "the connection closed" }));
    socket.once("connect", () => {
      const transport = socketTransport(socket);
      const unlisten = transport.listen((data) => {
        const msg = parseHostMessage(data);
        if (msg?.type === "reject") {
          unlisten();
          settle({ status: "rejected", reason: msg.reason, hostApi: msg.hostApi });
        } else if (msg?.type === "welcome") {
          unlisten();
          const { hostApi, pomadeVersion, appId: id, surface, route, project, theme } = msg;
          settle({ status: "connected", host: createClient(transport, { hostApi, pomadeVersion, appId: id, surface, route, project, theme }, () => socket.end()) });
        }
      });
      transport.send({ channel: CHANNEL, type: "hello", hostApi: HOST_API_VERSION, client: { appId, key, role } });
    });
  });
}

export interface StayConnectedHandlers {
  /** A new connection, after start and after every reconnect. It may be async: when the connection
   *  ends while it runs, its rejection (a call rejected as the client closed) is dropped — the
   *  reconnect runs it again; any other rejection is left unhandled, as a thrown error would be. */
  onConnect(host: HostClient): void | Promise<void>;
  /** The connection ended (Pomade quit or restarted); a reconnect follows. */
  onDisconnect?(): void;
  /** Pomade refused the hello (wrong key, version mismatch); retried at the longest interval. */
  onRejected?(reason: RejectReason): void;
}

export interface StayConnectedOptions extends SocketConnectOptions {
  /** First retry delay; doubles up to `maxDelayMs`. Default 250 ms. */
  minDelayMs?: number;
  /** Default 5000 ms. */
  maxDelayMs?: number;
}

/**
 * Keep a backend connected: connect, and reconnect with back-off whenever the connection ends or
 * Pomade is not running. Returns `stop()`, which closes the current client and stops retrying.
 */
export function stayConnected(options: StayConnectedOptions, handlers: StayConnectedHandlers): { stop(): void } {
  const min = options.minDelayMs ?? 250;
  const max = options.maxDelayMs ?? 5000;
  let delay = min;
  let stopped = false;
  let current: HostClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const retry = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void attempt(), ms);
  };
  const attempt = async (): Promise<void> => {
    timer = null;
    let result: SocketConnectResult;
    try {
      result = await connectSocket(options);
    } catch {
      // The identity is not readable yet (a key file being issued): try again later.
      retry(max);
      return;
    }
    if (stopped) {
      if (result.status === "connected") result.host.close();
      return;
    }
    if (result.status === "connected") {
      delay = min;
      current = result.host;
      result.host.onClose(() => {
        current = null;
        if (stopped) return;
        handlers.onDisconnect?.();
        retry(min);
      });
      const host = result.host;
      const connected = handlers.onConnect(host);
      if (connected instanceof Promise) {
        void connected.catch((err: unknown) => {
          if (current === host) throw err;
        });
      }
      return;
    }
    if (result.status === "rejected") {
      handlers.onRejected?.(result.reason);
      retry(max);
      return;
    }
    retry(delay);
    delay = Math.min(delay * 2, max);
  };

  void attempt();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.close();
    },
  };
}
