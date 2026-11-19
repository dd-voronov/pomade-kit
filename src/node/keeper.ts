// The attach protocol's client side under Node (pomade:E-034): connect to a keeper, start one, and
// follow one session across keeper updates and restarts. Pomade's attached tabs and the owning
// app's backend use the same client.

import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";

import {
  ATTACH_PROTOCOL,
  POMADE_ENV,
  createLineDecoder,
  encodeLine,
  parseKeeperMessage,
  socketPathProblem,
  type KeeperErrorCode,
  type KeeperMessage,
  type KeeperRole,
  type SessionAction,
  type SessionExit,
  type SessionInfo,
  type SpawnSpec,
} from "../protocol/index.js";

/** A keeper's refusal of a request. */
export class KeeperError extends Error {
  constructor(
    readonly code: KeeperErrorCode | "closed",
    message: string,
  ) {
    super(message);
    this.name = "KeeperError";
  }
}

export interface KeeperConnectOptions {
  socketPath: string;
  /** The caller's app id (`pomade` for Pomade itself). */
  app: string;
  /** Default `viewer`. */
  role?: KeeperRole;
  /** The owner's key (the app's key file content). */
  key?: string;
  /** How long to wait for `welcome`. Default 3000 ms. */
  timeoutMs?: number;
}

export type KeeperConnectResult =
  | { status: "connected"; keeper: KeeperClient }
  /** Nothing listens on the socket, or it did not answer in time. */
  | { status: "not-running"; reason: string }
  | { status: "rejected"; code: "unauthorized" | "version-mismatch"; message: string };

type Event = Exclude<KeeperMessage, { type: "welcome" | "reject" | "result" } | { type: "error"; rid: string }>;

/** One connection to a keeper. Requests resolve with the keeper's answer or reject with a
 *  `KeeperError`; session events arrive through `onEvent`. */
export interface KeeperClient {
  readonly keeper: { version: string; pid: number };
  list(): Promise<SessionInfo[]>;
  /** The owner only: the sessions now, and from then on every session's `info` (it started, or
   *  its title or actions changed) and `exit` as events — without its output. Lasts as long as
   *  this connection; after a keeper update, watch again on the new connection. */
  watch(): Promise<SessionInfo[]>;
  /** The owner only. */
  spawn(spec: SpawnSpec): Promise<SessionInfo>;
  /** Attach: a `snapshot` (or a `delta` for `since`) arrives as an event before this resolves, then
   *  the session's `output`, `resized`, `exit` and `info` events. */
  attach(
    session: string,
    options?: { cols?: number; rows?: number; since?: { startedAt: number; seq: number }; scrollback?: number },
  ): Promise<void>;
  input(session: string, data: string): void;
  paste(session: string, text: string): void;
  resize(session: string, cols: number, rows: number): void;
  detach(session: string): void;
  stop(session: string, options?: { reason?: "stopped" | "stopped-by-you" | "time-limit"; graceMs?: number }): Promise<void>;
  /** The owner only. */
  update(session: string, patch: { title?: string; actions?: SessionAction[] }): Promise<SessionInfo>;
  /** The owner only: drop an ended session. */
  forget(session: string): Promise<void>;
  /** The owner only: hand the sessions to a new keeper running `entry` (absolute) with Pomade's
   *  runtime. This connection then closes; reconnect to reach the new keeper. */
  upgrade(entry: string, args?: string[]): Promise<void>;
  onEvent(cb: (event: Event) => void): () => void;
  /** The connection ended (the keeper quit, restarted or crashed). */
  onClose(cb: () => void): () => void;
  close(): void;
}

function clientOver(sock: Socket, decoder: ReturnType<typeof createLineDecoder>, keeper: { version: string; pid: number }, early: unknown[]): KeeperClient {
  let seq = 0;
  const waiting = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  const events = new Set<(e: Event) => void>();
  const closes = new Set<() => void>();
  let closed = false;

  const dispatch = (raw: unknown): void => {
    const m = parseKeeperMessage(raw);
    if (!m) return;
    if (m.type === "result") {
      waiting.get(m.rid)?.resolve(m.value);
      waiting.delete(m.rid);
      return;
    }
    if (m.type === "error" && m.rid !== undefined) {
      waiting.get(m.rid)?.reject(new KeeperError(m.code, m.message));
      waiting.delete(m.rid);
      return;
    }
    if (m.type === "welcome" || m.type === "reject") return;
    for (const cb of [...events]) cb(m as Event);
  };
  sock.on("data", (chunk: string) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      sock.destroy();
      return;
    }
    for (const m of messages) dispatch(m);
  });
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const w of waiting.values()) w.reject(new KeeperError("closed", "the keeper connection closed"));
    waiting.clear();
    for (const cb of [...closes]) cb();
  };
  sock.on("close", end);
  sock.on("error", () => sock.destroy());

  const write = (m: object): void => {
    if (!sock.destroyed) sock.write(encodeLine(m));
  };
  const request = <T>(m: object): Promise<T> => {
    if (closed) return Promise.reject(new KeeperError("closed", "the keeper connection closed"));
    const rid = String(++seq);
    return new Promise<T>((resolve, reject) => {
      waiting.set(rid, { resolve: resolve as (v: unknown) => void, reject });
      write({ ...m, rid });
    });
  };

  const client: KeeperClient = {
    keeper,
    list: () => request<SessionInfo[]>({ type: "list" }),
    watch: () => request<SessionInfo[]>({ type: "watch" }),
    spawn: (spec) => request<SessionInfo>({ type: "spawn", spec }),
    attach: async (session, options = {}) => {
      await request({ type: "attach", session, ...options });
    },
    input: (session, data) => write({ type: "input", session, data }),
    paste: (session, text) => write({ type: "paste", session, text }),
    resize: (session, cols, rows) => write({ type: "resize", session, cols, rows }),
    detach: (session) => write({ type: "detach", session }),
    stop: async (session, options = {}) => {
      await request({ type: "stop", session, ...options });
    },
    update: (session, patch) => request<SessionInfo>({ type: "update", session, ...patch }),
    forget: async (session) => {
      await request({ type: "forget", session });
    },
    upgrade: async (entry, args) => {
      await request({ type: "upgrade", entry, ...(args ? { args } : {}) });
    },
    onEvent(cb) {
      events.add(cb);
      return () => events.delete(cb);
    },
    onClose(cb) {
      if (closed) {
        cb();
        return () => undefined;
      }
      closes.add(cb);
      return () => closes.delete(cb);
    },
    close: () => sock.end(),
  };
  // Messages that arrived in the same read as `welcome`, after the caller has its client.
  if (early.length > 0) {
    setTimeout(() => {
      for (const m of early) dispatch(m);
    }, 0);
  }
  return client;
}

/** Connect to a keeper and say hello. Never throws: a missing keeper is `not-running`. */
export function connectKeeper(options: KeeperConnectOptions): Promise<KeeperConnectResult> {
  const tooLong = socketPathProblem(options.socketPath);
  if (tooLong) return Promise.resolve({ status: "not-running", reason: tooLong });
  return new Promise((resolve) => {
    const sock = createConnection(options.socketPath);
    const decoder = createLineDecoder();
    sock.setEncoding("utf8");
    let settled = false;
    const settle = (r: KeeperConnectResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off("data", onData);
      if (r.status !== "connected") sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => settle({ status: "not-running", reason: "the keeper did not answer" }), options.timeoutMs ?? 3000);
    const onData = (chunk: string): void => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        settle({ status: "not-running", reason: "the keeper sent garbage" });
        return;
      }
      for (const [i, raw] of messages.entries()) {
        const m = parseKeeperMessage(raw);
        if (m?.type === "reject") return settle({ status: "rejected", code: m.code, message: m.message });
        if (m?.type === "welcome") {
          return settle({ status: "connected", keeper: clientOver(sock, decoder, m.keeper, messages.slice(i + 1)) });
        }
      }
    };
    sock.on("data", onData);
    sock.once("error", (err: NodeJS.ErrnoException) => settle({ status: "not-running", reason: err.code ?? err.message }));
    sock.once("close", () => settle({ status: "not-running", reason: "the connection closed" }));
    sock.once("connect", () => {
      const client: { app: string; role: KeeperRole; key?: string } = { app: options.app, role: options.role ?? "viewer" };
      if (options.key !== undefined) client.key = options.key;
      sock.write(encodeLine({ type: "hello", protocol: ATTACH_PROTOCOL, client }));
    });
  });
}

export interface StartKeeperOptions {
  /** The keeper's entry: a script that calls `runKeeper()` (absolute). */
  entry: string;
  /** Default `POMADE_KEEPER_SOCKET`. */
  socketPath?: string;
  /** Arguments after the entry. */
  args?: string[];
  /** The keeper's environment. Default this process's, which carries the app's identity
   *  (`POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_KEEPER_SOCKET`). */
  env?: NodeJS.ProcessEnv;
  /** The caller's app id for the probe. Default `POMADE_APP_ID`. */
  app?: string;
  /** How long to wait for the started keeper to answer. Default 10000 ms. */
  readyTimeoutMs?: number;
  /** A file (absolute) the keeper's stdout and stderr are appended to. Default: discarded. */
  logFile?: string;
}

export type StartKeeperResult = { status: "running"; started: boolean; pid: number } | { status: "failed"; reason: string };

/**
 * Make sure the app's keeper runs: when nothing answers on its socket, start `entry` as a detached
 * process on this runtime (Pomade's Electron in Node mode for a backend), so it outlives the
 * caller, and wait until it answers.
 */
export async function startKeeper(options: StartKeeperOptions): Promise<StartKeeperResult> {
  const env = options.env ?? process.env;
  const socketPath = options.socketPath ?? env[POMADE_ENV.keeperSocket];
  if (!socketPath) return { status: "failed", reason: `no socket — pass "socketPath" or set ${POMADE_ENV.keeperSocket}` };
  const tooLong = socketPathProblem(socketPath);
  if (tooLong) return { status: "failed", reason: tooLong };
  const app = options.app ?? env[POMADE_ENV.appId] ?? "pomade";
  const probe = async (): Promise<number | null> => {
    const r = await connectKeeper({ socketPath, app, timeoutMs: 1000 });
    if (r.status !== "connected") return null;
    const pid = r.keeper.keeper.pid;
    r.keeper.close();
    return pid;
  };
  const running = await probe();
  if (running !== null) return { status: "running", started: false, pid: running };
  const { openSync, closeSync } = await import("node:fs");
  let out: number | "ignore" = "ignore";
  if (options.logFile) {
    try {
      out = openSync(options.logFile, "a");
    } catch {
      out = "ignore";
    }
  }
  const childEnv: NodeJS.ProcessEnv = { ...env, [POMADE_ENV.keeperSocket]: socketPath };
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [options.entry, ...(options.args ?? [])], { detached: true, stdio: ["ignore", out, out], env: childEnv });
    pid = child.pid;
    child.on("error", () => undefined);
    child.unref();
  } catch (err) {
    return { status: "failed", reason: `could not start the keeper: ${(err as Error).message}` };
  } finally {
    if (typeof out === "number") closeSync(out);
  }
  const deadline = Date.now() + (options.readyTimeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const answered = await probe();
    if (answered !== null) return { status: "running", started: true, pid: answered };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { status: "failed", reason: `the keeper (pid ${pid ?? "?"}) did not answer in time` };
}

/** Where a followed session stands. */
export type FollowState =
  | { kind: "connecting" }
  | { kind: "attached"; info: SessionInfo }
  /** The keeper does not answer (not running, or restarting); retried. */
  | { kind: "unreachable"; reason: string }
  /** The keeper answers but holds no such session; retried, in case it comes back. */
  | { kind: "gone" }
  /** The keeper refused this client; not retried. */
  | { kind: "rejected"; message: string };

export interface FollowHandlers {
  onState?(state: FollowState): void;
  /** Draw `data` into an empty terminal of `info.cols` × `info.rows` (a fresh attach, or `resync`
   *  after falling behind). */
  onSnapshot?(data: string, info: SessionInfo, resync: boolean): void;
  /** Output missed during a reconnect: write it on top of the current screen. */
  onDelta?(data: string, info: SessionInfo): void;
  onOutput?(data: string): void;
  onResized?(cols: number, rows: number): void;
  onExit?(exit: SessionExit): void;
  onInfo?(info: SessionInfo): void;
}

export interface FollowOptions extends Omit<KeeperConnectOptions, "timeoutMs"> {
  session: string;
  /** The terminal size to attach with (the session is resized to it). */
  cols?: number;
  rows?: number;
  /** First retry delay; doubles up to `maxDelayMs`. Default 100 ms. */
  minDelayMs?: number;
  /** Default 3000 ms. */
  maxDelayMs?: number;
}

export interface Follower {
  readonly state: FollowState;
  input(data: string): void;
  paste(text: string): void;
  /** Resize the session (and attach with this size after a reconnect). */
  resize(cols: number, rows: number): void;
  stop(options?: { reason?: "stopped" | "stopped-by-you" | "time-limit"; graceMs?: number }): Promise<void>;
  /** Ask for a fresh snapshot. */
  resync(): void;
  /** Detach and stop following; the session keeps running. */
  close(): void;
}

/**
 * Follow one session: attach, and after the connection ends (the keeper updated, restarted or
 * crashed) reconnect with back-off and attach again — with the output missed meanwhile (`delta`)
 * when the keeper still holds it, else with a fresh snapshot.
 */
export function followSession(options: FollowOptions, handlers: FollowHandlers): Follower {
  const min = options.minDelayMs ?? 100;
  const max = options.maxDelayMs ?? 3000;
  let delay = min;
  const life = { closed: false };
  const isClosed = (): boolean => life.closed;
  let client: KeeperClient | null = null;
  let timer: NodeJS.Timeout | null = null;
  let size = options.cols !== undefined && options.rows !== undefined ? { cols: options.cols, rows: options.rows } : null;
  let seen: { startedAt: number; seq: number } | null = null;
  let state: FollowState = { kind: "connecting" };
  const setState = (next: FollowState): void => {
    state = next;
    handlers.onState?.(next);
  };

  const retry = (ms: number): void => {
    if (life.closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, ms);
  };

  const connect = async (): Promise<void> => {
    if (life.closed) return;
    const r = await connectKeeper({ ...options, timeoutMs: 2000 });
    // `close()` may have run while connecting.
    if (isClosed()) {
      if (r.status === "connected") r.keeper.close();
      return;
    }
    if (r.status === "rejected") {
      setState({ kind: "rejected", message: r.message });
      return;
    }
    if (r.status === "not-running") {
      setState({ kind: "unreachable", reason: r.reason });
      retry(delay);
      delay = Math.min(delay * 2, max);
      return;
    }
    const k = r.keeper;
    client = k;
    let restartAfter: number | null = null;
    k.onEvent((e) => {
      if (e.type === "keeper-restarting") {
        restartAfter = e.reconnectAfterMs;
        return;
      }
      if (!("session" in e) || e.session !== options.session) return;
      switch (e.type) {
        case "snapshot":
          seen = { startedAt: e.info.startedAt, seq: e.seq };
          handlers.onSnapshot?.(e.data, e.info, e.resync);
          setState({ kind: "attached", info: e.info });
          break;
        case "delta":
          seen = { startedAt: e.info.startedAt, seq: e.seq };
          handlers.onDelta?.(e.data, e.info);
          setState({ kind: "attached", info: e.info });
          break;
        case "output":
          if (seen) seen.seq = e.seq;
          handlers.onOutput?.(e.data);
          break;
        case "resized":
          size = { cols: e.cols, rows: e.rows };
          handlers.onResized?.(e.cols, e.rows);
          break;
        case "exit":
          handlers.onExit?.(e.exit);
          break;
        case "info":
          handlers.onInfo?.(e.info);
          if (state.kind === "attached") setState({ kind: "attached", info: e.info });
          break;
      }
    });
    k.onClose(() => {
      client = null;
      if (life.closed) return;
      if (state.kind === "gone") {
        retry(max);
        return;
      }
      setState({ kind: "connecting" });
      delay = min;
      retry(restartAfter ?? min);
    });
    try {
      await k.attach(options.session, { ...(size ?? {}), ...(seen ? { since: seen } : {}) });
      delay = min;
    } catch (err) {
      if (err instanceof KeeperError && err.code === "unknown-session") {
        setState({ kind: "gone" });
        k.close();
        // `onClose` retries; a session that comes back (the owner starts it again) is attached then.
        return;
      }
    }
  };

  void connect();
  return {
    get state() {
      return state;
    },
    input: (data) => client?.input(options.session, data),
    paste: (text) => client?.paste(options.session, text),
    resize(cols, rows) {
      size = { cols, rows };
      client?.resize(options.session, cols, rows);
    },
    async stop(stopOptions) {
      if (!client) throw new KeeperError("closed", "not connected to the keeper");
      await client.stop(options.session, stopOptions);
    },
    resync() {
      seen = null;
      void client?.attach(options.session, { ...(size ?? {}) }).catch(() => undefined);
    },
    close() {
      life.closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (client) {
        client.detach(options.session);
        client.close();
      }
      client = null;
    },
  };
}
