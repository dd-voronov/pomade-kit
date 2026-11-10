// The keeper (pomade:E-034): a process that holds an app's terminal sessions so they outlive Pomade,
// and serves the attach protocol (`pomade-kit/protocol` attach.ts) on a unix socket. The owning
// app's always-on backend starts it (`startKeeper` in `pomade-kit/node`); Pomade's attached tabs
// and the owner connect to it.
//
// Per session the keeper keeps the PTY (through the exit-status shim), a headless xterm that is the
// terminal of record — it parses every byte and answers the program's terminal queries — and a
// bounded ring of recent raw output for clients resuming after a gap. Attaching sends the
// serialized screen, never a replay of recorded bytes.
//
// An update hands the open PTY masters to a new keeper process (`upgrade`): the old one stops
// reading, drains what it already read, writes the sessions' state to a hand-off file and starts
// the new keeper with the masters as inherited fds; it exits once the new keeper answers, and goes
// back to serving if it never does.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  ATTACH_PROTOCOL,
  OWNER_ONLY,
  POMADE_ENV,
  createLineDecoder,
  encodeLine,
  parseKeeperRequest,
  socketPathProblem,
  type ExitReason,
  type KeeperErrorCode,
  type KeeperMessage,
  type KeeperRequest,
  type KeeperRole,
  type SessionAction,
  type SessionExit,
  type SessionInfo,
  type SpawnSpec,
} from "../protocol/index.js";
import { SHIM, loginShell, sessionEnv } from "./env.js";
import { adoptPty, isAlive, spawnPty, type PtyHold } from "./pty.js";
import { Screen } from "./screen.js";

/** The environment variable naming the hand-off file a new keeper adopts its sessions from. */
export const HANDOFF_ENV = "POMADE_KEEPER_HANDOFF";

export interface KeeperOptions {
  /** The owning app's id. Default `POMADE_APP_ID`. */
  app?: string;
  /** Where to listen. Default `POMADE_KEEPER_SOCKET` (`<userData>/run/keepers/<app>.sock`). */
  socketPath?: string;
  /** Session records, exit statuses, hand-off files and the log. Default
   *  `<userData>/app-state/<app>/keeper`, next to the socket's user-data folder. */
  stateDir?: string;
  /** What an `owner` hello must present. Default: the content of `POMADE_APP_KEY_FILE`. `null`
   *  accepts the owner without a key (tests). */
  ownerKey?: string | null;
  /** Reported in `welcome` (the owner compares it with its own to decide on an update). */
  version?: string;
  /** Scrollback lines each session's terminal keeps. Default 1000. */
  scrollback?: number;
  /** Raw output characters each session keeps for resuming clients. Default 1 MiB. */
  ringChars?: number;
  /** A client whose unsent bytes pass this falls behind: its output is dropped and it gets a fresh
   *  snapshot once it catches up. Default 4 MiB. */
  highWaterBytes?: number;
  /** Exited sessions kept for clients to see how they ended; older ones are forgotten. Default 50. */
  exitedMax?: number;
  /** The keeper's environment (sessions start from it). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where log lines go. Default `<stateDir>/keeper.log`. */
  log?: (line: string) => void;
  /** Called when this keeper has handed its sessions to a new one. Default `process.exit`. */
  exit?: (code: number) => void;
}

export interface Keeper {
  readonly socketPath: string;
  readonly stateDir: string;
  /** Every session the keeper holds or remembers, as `list` answers. */
  sessions(): SessionInfo[];
  /** Stop serving and end every session (closing a PTY hangs up its programs). */
  close(): Promise<void>;
}

const DEFAULTS = { scrollback: 1000, ringChars: 1024 * 1024, highWaterBytes: 4 * 1024 * 1024, exitedMax: 50 };
/** An interrupt typed this shortly before the exit makes it "stopped by you". */
const CTRL_C_WINDOW_MS = 5000;
const STOP_GRACE_MS = 3000;
const HELLO_TIMEOUT_MS = 5000;
/** How long an update waits for the new keeper to answer before taking its sessions back. */
const HANDOFF_READY_MS = 15000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

interface Attachment {
  /** Output queued while this client's snapshot is cut; `null` once it is sent. */
  pending: { data: string; seq: number }[] | null;
  /** The client fell behind: its output is dropped until a fresh snapshot. */
  lagging: boolean;
}

interface Client {
  sock: Socket;
  app: string;
  role: KeeperRole | null;
  attached: Map<string, Attachment>;
}

interface Session {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  actions: SessionAction[];
  exit: SessionExit | null;
  screen: Screen;
  hold: PtyHold | null;
  /** Output characters since the session started (the `seq` of its last output). */
  seq: number;
  ring: string[];
  ringLen: number;
  viewers: Map<Client, Attachment>;
  lastCtrlC: number;
  stopReason: ExitReason | null;
  killTimer: NodeJS.Timeout | null;
  /** True while a hand-off's screen is redrawn: the terminal's answers to it never reach the program. */
  restoring: boolean;
  log: string | null;
  logStream: WriteStream | null;
}

/** A session as the hand-off file carries it to the next keeper. */
interface HandoffSession {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  cols: number;
  rows: number;
  actions: SessionAction[];
  exit: SessionExit | null;
  seq: number;
  ring: string;
  screen: string;
  lastCtrlC: number;
  stopReason: ExitReason | null;
  log: string | null;
  /** The inherited fd holding its PTY master; `null` for an ended session. */
  fdIndex: number | null;
}

interface SessionRecord {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  actions: SessionAction[];
  exit: SessionExit | null;
}

function signalName(n: number): string | null {
  for (const [name, num] of Object.entries(osConstants.signals)) if (num === n) return name;
  return null;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function readKey(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** True when a keeper answers on `socketPath`. */
function answers(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const decoder = createLineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
    sock.on("connect", () => sock.write(encodeLine({ type: "hello", protocol: ATTACH_PROTOCOL, client: { app: "pomade", role: "viewer" } })));
    sock.on("data", (chunk: string) => {
      for (const m of decoder.push(chunk)) {
        const t = (m as { type?: unknown }).type;
        if (t === "welcome" || t === "reject") done(true);
      }
    });
  });
}

/**
 * Run a keeper in this process: listen on its socket, adopt the sessions a previous keeper handed
 * over (`POMADE_KEEPER_HANDOFF`), and report sessions a crashed keeper left behind as
 * `lost-in-keeper-crash`. Rejects when the socket path is too long or another keeper serves it.
 */
export async function runKeeper(options: KeeperOptions = {}): Promise<Keeper> {
  const env = options.env ?? process.env;
  const app = options.app ?? env[POMADE_ENV.appId];
  if (!app) throw new Error(`pomade-kit/keeper: no app id — pass "app" or set ${POMADE_ENV.appId}`);
  const socketPath = options.socketPath ?? env[POMADE_ENV.keeperSocket];
  if (!socketPath) throw new Error(`pomade-kit/keeper: no socket — pass "socketPath" or set ${POMADE_ENV.keeperSocket}`);
  const tooLong = socketPathProblem(socketPath);
  if (tooLong) throw new Error(`pomade-kit/keeper: ${tooLong}`);
  const stateDir = options.stateDir ?? join(dirname(dirname(dirname(socketPath))), "app-state", app, "keeper");
  const ownerKey = options.ownerKey === undefined ? readKey(env[POMADE_ENV.keyFile]) : options.ownerKey;
  const version = options.version ?? "0";
  const scrollback = options.scrollback ?? DEFAULTS.scrollback;
  const ringChars = options.ringChars ?? DEFAULTS.ringChars;
  const highWater = options.highWaterBytes ?? DEFAULTS.highWaterBytes;
  const exitedMax = options.exitedMax ?? DEFAULTS.exitedMax;
  const exitProcess = options.exit ?? ((code: number) => process.exit(code));

  mkdirSync(join(stateDir, "status"), { recursive: true });
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  const logFile = join(stateDir, "keeper.log");
  const log =
    options.log ??
    ((line: string) => {
      try {
        if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) renameSync(logFile, `${logFile}.1`);
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
      } catch {
        /* logging never stops the keeper */
      }
    });

  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    chmodSync(socketDir, 0o700);
  }
  if (existsSync(socketPath)) {
    if (await answers(socketPath)) throw new Error(`pomade-kit/keeper: a keeper already serves ${socketPath}`);
    unlinkSync(socketPath);
  }

  const sessions = new Map<string, Session>();
  const clients = new Set<Client>();
  let server: Server | null = null;
  let handingOff = false;
  /** Sessions that ended while a hand-off was under way: handed over as ended, or finished here if
   *  the hand-off falls through. */
  const endedDuringHandoff = new Map<Session, { code: number | null; signal: string | null }>();

  // ── records ─────────────────────────────────────────────────────────────────
  const statusFile = (id: string): string => join(stateDir, "status", id);
  const recordFile = (id: string): string => join(stateDir, "sessions", `${id}.json`);
  const writeRecord = (s: Session): void => {
    const rec: SessionRecord = {
      id: s.id,
      title: s.title,
      command: s.command,
      cwd: s.cwd,
      pid: s.pid,
      startedAt: s.startedAt,
      actions: s.actions,
      exit: s.exit,
    };
    const file = recordFile(s.id);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(rec));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      log(`record ${s.id}: ${(err as Error).message}`);
    }
  };
  const removeRecord = (id: string): void => {
    rmSync(recordFile(id), { force: true });
    rmSync(statusFile(id), { force: true });
  };
  const readStatus = (id: string): number | null => {
    try {
      const n = Number(readFileSync(statusFile(id), "utf8").trim());
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  };

  // ── messages ────────────────────────────────────────────────────────────────
  const send = (c: Client, m: KeeperMessage): void => {
    if (!c.sock.destroyed) c.sock.write(encodeLine(m));
  };
  const fail = (c: Client, rid: string | undefined, code: KeeperErrorCode, message: string): void =>
    send(c, rid === undefined ? { type: "error", code, message } : { type: "error", rid, code, message });

  const info = (s: Session): SessionInfo => ({
    id: s.id,
    title: s.title,
    command: s.command,
    cwd: s.cwd,
    pid: s.exit ? null : s.pid,
    startedAt: s.startedAt,
    cols: s.screen.cols,
    rows: s.screen.rows,
    state: s.exit ? "exited" : "running",
    exit: s.exit,
    clients: s.viewers.size,
    actions: s.actions,
  });

  const sendOutput = (c: Client, s: Session, att: Attachment, data: string, seq: number): void => {
    if (att.lagging) return;
    if (c.sock.writableLength > highWater) {
      att.lagging = true;
      log(`client ${c.app} fell behind on ${s.id}: output dropped until a fresh snapshot`);
      return;
    }
    send(c, { type: "output", session: s.id, data, seq });
  };

  const ringText = (s: Session): string => {
    if (s.ring.length > 1) s.ring = [s.ring.join("")];
    return s.ring[0] ?? "";
  };

  const onOutput = (s: Session, data: string): void => {
    s.screen.write(data);
    s.seq += data.length;
    s.ring.push(data);
    s.ringLen += data.length;
    while (s.ring.length > 1 && s.ringLen - (s.ring[0]?.length ?? 0) >= ringChars) s.ringLen -= s.ring.shift()?.length ?? 0;
    s.logStream?.write(data);
    for (const [c, att] of s.viewers) {
      if (att.pending) att.pending.push({ data, seq: s.seq });
      else sendOutput(c, s, att, data, s.seq);
    }
  };

  /** Cut a snapshot for `c` once the terminal has parsed everything so far; output arriving
   *  meanwhile is queued and follows it, so the client misses nothing and sees nothing twice. */
  const snapshotTo = (c: Client, s: Session, att: Attachment, resync: boolean, lines: number | undefined, then?: () => void): void => {
    att.pending = [];
    const seq = s.seq;
    s.screen.write("", () => {
      if (s.viewers.get(c) !== att || sessions.get(s.id) !== s) return;
      const data = s.screen.serialize(lines);
      const queued = att.pending ?? [];
      att.pending = null;
      send(c, { type: "snapshot", session: s.id, info: info(s), data, seq, resync });
      for (const q of queued) sendOutput(c, s, att, q.data, q.seq);
      if (s.exit) send(c, { type: "exit", session: s.id, exit: s.exit });
      then?.();
    });
  };

  const broadcastInfo = (s: Session): void => {
    for (const c of s.viewers.keys()) send(c, { type: "info", session: s.id, info: info(s) });
  };

  // ── session lifecycle ───────────────────────────────────────────────────────
  const newSession = (
    fields: Pick<Session, "id" | "title" | "command" | "cwd" | "pid" | "startedAt" | "actions" | "exit" | "log">,
    cols: number,
    rows: number,
    hold: PtyHold | null,
  ): Session => {
    const s: Session = {
      ...fields,
      screen: new Screen(cols, rows, scrollback),
      hold,
      seq: 0,
      ring: [],
      ringLen: 0,
      viewers: new Map(),
      lastCtrlC: 0,
      stopReason: null,
      killTimer: null,
      restoring: false,
      logStream: null,
    };
    // The terminal of record answers the program's queries; clients never send their own answers.
    s.screen.onAnswer((answer) => {
      if (!s.restoring && !s.exit && s.hold) s.hold.write(answer);
    });
    if (s.log && !s.exit) {
      mkdirSync(dirname(s.log), { recursive: true });
      s.logStream = createWriteStream(s.log, { flags: "a" });
      s.logStream.on("error", (err) => log(`log ${s.id}: ${err.message}`));
    }
    return s;
  };

  const classify = (s: Session, code: number | null, signal: string | null, at: number): ExitReason => {
    if (s.stopReason) return s.stopReason;
    if (s.lastCtrlC && at - s.lastCtrlC < CTRL_C_WINDOW_MS) return "stopped-by-you";
    return code === 0 && signal === null ? "exited" : "crashed";
  };

  const pruneExited = (): void => {
    const exited = [...sessions.values()].filter((x) => x.exit && x.viewers.size === 0);
    exited.sort((a, b) => (a.exit?.at ?? 0) - (b.exit?.at ?? 0));
    while (exited.length > exitedMax) {
      const old = exited.shift();
      if (!old) break;
      sessions.delete(old.id);
      old.screen.dispose();
      removeRecord(old.id);
    }
  };

  const exitOf = (s: Session, code: number | null, signal: string | null): SessionExit => {
    const at = Date.now();
    const sig = signal === null && code !== null && code > 128 && code < 160 ? signalName(code - 128) : signal;
    return { code, signal: sig, reason: classify(s, code, sig, at), at };
  };

  const finishExit = (s: Session, code: number | null, signal: string | null): void => {
    if (s.exit) return;
    if (handingOff) {
      endedDuringHandoff.set(s, { code, signal });
      return;
    }
    s.exit = exitOf(s, code, signal);
    if (s.killTimer) clearTimeout(s.killTimer);
    s.killTimer = null;
    s.hold = null;
    s.logStream?.end();
    s.logStream = null;
    log(`session ${s.id} ended: ${s.exit.reason} (code ${s.exit.code}, signal ${s.exit.signal})`);
    writeRecord(s);
    for (const c of s.viewers.keys()) send(c, { type: "exit", session: s.id, exit: s.exit });
    pruneExited();
  };

  /** Wire a spawned PTY's output and exit into its session. */
  const spawnSession = (spec: SpawnSpec, previous: Session | undefined): Session => {
    const id = spec.id ?? randomBytes(5).toString("hex");
    if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new Error(`no such folder: ${spec.cwd}`);
    const cols = spec.cols ?? previous?.screen.cols ?? 80;
    const rows = spec.rows ?? previous?.screen.rows ?? 24;
    let program = spec.command !== undefined ? [loginShell(env), "-l", "-c", spec.command] : [...(spec.argv ?? [])];
    if (spec.background) program = ["/usr/sbin/taskpolicy", "-b", ...program];
    rmSync(statusFile(id), { force: true });
    const pty = spawnPty("/bin/sh", ["-c", SHIM, "pomade-keeper", statusFile(id), ...program], {
      cols,
      rows,
      cwd: spec.cwd,
      env: sessionEnv(env, spec.env),
    });
    const startedAt = Math.max(Date.now(), (previous?.startedAt ?? 0) + 1);
    const s = newSession(
      {
        id,
        title: spec.title,
        command: spec.command ?? (spec.argv ?? []).map(shellQuote).join(" "),
        cwd: spec.cwd,
        pid: pty.hold.pid,
        startedAt,
        actions: spec.actions ?? [],
        exit: null,
        log: spec.log ?? null,
      },
      cols,
      rows,
      pty.hold,
    );
    pty.onData((d) => onOutput(s, d));
    pty.onExit((exitCode, sig) => {
      const fromShim = readStatus(id);
      finishExit(s, fromShim ?? (sig ? null : exitCode), fromShim === null && sig ? signalName(sig) : null);
    });
    log(`session ${id} started: pid ${pty.hold.pid}, ${s.command}`);
    return s;
  };

  /** A session adopted from the previous keeper: the PTY master arrived as inherited fd `fd`. */
  const adoptSession = (rec: HandoffSession): Session => {
    const pty = rec.fdIndex === null || rec.exit ? null : adoptPty(rec.fdIndex, rec.pid ?? 0);
    const s = newSession(
      {
        id: rec.id,
        title: rec.title,
        command: rec.command,
        cwd: rec.cwd,
        pid: rec.pid,
        startedAt: rec.startedAt,
        actions: rec.actions,
        exit: rec.exit,
        log: rec.log,
      },
      rec.cols,
      rec.rows,
      pty?.hold ?? null,
    );
    s.seq = rec.seq;
    s.ring = rec.ring ? [rec.ring] : [];
    s.ringLen = rec.ring.length;
    s.lastCtrlC = rec.lastCtrlC;
    s.stopReason = rec.stopReason;
    s.restoring = true;
    s.screen.write(rec.screen, () => {
      s.restoring = false;
    });
    if (pty) {
      pty.onData((d) => onOutput(s, d));
      pty.onEnd(() => {
        // Not the session's parent: wait for the shim's status (or the process to be gone).
        const started = Date.now();
        const poll = (): void => {
          const code = readStatus(s.id);
          if (code !== null || !isAlive(rec.pid ?? 0) || Date.now() - started > 3000) {
            finishExit(s, code, null);
            return;
          }
          setTimeout(poll, 20);
        };
        poll();
      });
    }
    return s;
  };

  // ── requests ────────────────────────────────────────────────────────────────
  const attach = (c: Client, m: Extract<KeeperRequest, { type: "attach" }>): void => {
    const s = sessions.get(m.session);
    if (!s) return fail(c, m.rid, "unknown-session", `no session ${m.session}`);
    if (m.cols !== undefined && m.rows !== undefined && !s.exit) resize(c, s, m.cols, m.rows);
    const att: Attachment = { pending: null, lagging: false };
    s.viewers.set(c, att);
    c.attached.set(s.id, att);
    const ring = ringText(s);
    const ringStart = s.seq - ring.length;
    if (m.since !== undefined && m.since.startedAt === s.startedAt && m.since.seq >= ringStart && m.since.seq <= s.seq) {
      send(c, { type: "delta", session: s.id, info: info(s), data: ring.slice(m.since.seq - ringStart), seq: s.seq });
      if (s.exit) send(c, { type: "exit", session: s.id, exit: s.exit });
      send(c, { type: "result", rid: m.rid, value: {} });
      return;
    }
    snapshotTo(c, s, att, false, m.scrollback, () => send(c, { type: "result", rid: m.rid, value: {} }));
  };

  const detach = (c: Client, id: string): void => {
    sessions.get(id)?.viewers.delete(c);
    c.attached.delete(id);
  };

  const resize = (from: Client, s: Session, cols: number, rows: number): void => {
    if (s.exit || (s.screen.cols === cols && s.screen.rows === rows)) return;
    s.hold?.resize(cols, rows);
    s.screen.resize(cols, rows);
    for (const c of s.viewers.keys()) if (c !== from) send(c, { type: "resized", session: s.id, cols, rows });
  };

  const stop = (c: Client, m: Extract<KeeperRequest, { type: "stop" }>): void => {
    const s = sessions.get(m.session);
    if (!s) return fail(c, m.rid, "unknown-session", `no session ${m.session}`);
    if (!s.exit && s.hold) {
      s.stopReason = c.role === "owner" ? (m.reason ?? "stopped") : "stopped-by-you";
      const hold = s.hold;
      hold.kill("SIGTERM");
      if (s.killTimer) clearTimeout(s.killTimer);
      s.killTimer = setTimeout(() => {
        if (!s.exit) hold.kill("SIGKILL");
      }, m.graceMs ?? STOP_GRACE_MS);
    }
    send(c, { type: "result", rid: m.rid, value: {} });
  };

  const spawnRequest = (c: Client, m: Extract<KeeperRequest, { type: "spawn" }>): void => {
    const previous = m.spec.id !== undefined ? sessions.get(m.spec.id) : undefined;
    if (previous && !previous.exit) return fail(c, m.rid, "session-running", `session ${previous.id} is running`);
    let s: Session;
    try {
      s = spawnSession(m.spec, previous);
    } catch (err) {
      return fail(c, m.rid, "spawn-failed", (err as Error).message);
    }
    if (previous) {
      // The same id again (a restart): its clients stay attached and see the new session.
      for (const [viewer] of previous.viewers) {
        const att: Attachment = { pending: null, lagging: false };
        s.viewers.set(viewer, att);
        viewer.attached.set(s.id, att);
        snapshotTo(viewer, s, att, false, undefined);
      }
      previous.screen.dispose();
    }
    sessions.set(s.id, s);
    writeRecord(s);
    send(c, { type: "result", rid: m.rid, value: info(s) });
  };

  const handle = (c: Client, raw: unknown): void => {
    const parsed = parseKeeperRequest(raw);
    if (!parsed.ok) {
      fail(c, parsed.rid, "bad-request", parsed.message);
      return;
    }
    const m = parsed.value;
    if (m.type === "hello") {
      if (m.protocol !== ATTACH_PROTOCOL) {
        send(c, { type: "reject", protocol: ATTACH_PROTOCOL, code: "version-mismatch", message: `this keeper speaks protocol ${ATTACH_PROTOCOL}` });
        c.sock.end();
        return;
      }
      if (m.client.role === "owner" && (m.client.app !== app || (ownerKey !== null && m.client.key !== ownerKey))) {
        send(c, { type: "reject", protocol: ATTACH_PROTOCOL, code: "unauthorized", message: `not the owner of ${app}'s keeper` });
        c.sock.end();
        return;
      }
      c.app = m.client.app;
      c.role = m.client.role;
      send(c, { type: "welcome", protocol: ATTACH_PROTOCOL, app, keeper: { version, pid: process.pid } });
      return;
    }
    const rid = "rid" in m ? m.rid : undefined;
    if (c.role === null) return fail(c, rid, "bad-request", "say hello first");
    if (OWNER_ONLY.includes(m.type) && c.role !== "owner") return fail(c, rid, "not-owner", `only ${app} may ${m.type}`);
    switch (m.type) {
      case "list":
        return send(c, { type: "result", rid: m.rid, value: [...sessions.values()].map(info) });
      case "spawn":
        return spawnRequest(c, m);
      case "attach":
        return attach(c, m);
      case "detach":
        return detach(c, m.session);
      case "input": {
        const s = sessions.get(m.session);
        if (!s || s.exit || !s.hold) return;
        if (m.data.includes("\x03")) s.lastCtrlC = Date.now();
        s.hold.write(m.data);
        return;
      }
      case "paste": {
        const s = sessions.get(m.session);
        if (!s || s.exit || !s.hold) return;
        // As a terminal pastes: line breaks become CR; bracketed when the program asked for it,
        // with any bracket markers inside the text removed so it cannot end the paste early.
        let text = m.text.replace(/\r?\n/g, "\r");
        if (s.screen.bracketedPaste) text = `\x1b[200~${text.replace(/\x1b\[20[01]~/g, "")}\x1b[201~`;
        s.hold.write(text);
        return;
      }
      case "resize": {
        const s = sessions.get(m.session);
        if (s) resize(c, s, m.cols, m.rows);
        return;
      }
      case "stop":
        return stop(c, m);
      case "update": {
        const s = sessions.get(m.session);
        if (!s) return fail(c, m.rid, "unknown-session", `no session ${m.session}`);
        if (m.title !== undefined) s.title = m.title;
        if (m.actions !== undefined) s.actions = m.actions;
        writeRecord(s);
        broadcastInfo(s);
        return send(c, { type: "result", rid: m.rid, value: info(s) });
      }
      case "forget": {
        const s = sessions.get(m.session);
        if (!s) return fail(c, m.rid, "unknown-session", `no session ${m.session}`);
        if (!s.exit) return fail(c, m.rid, "session-running", `session ${s.id} is running`);
        sessions.delete(s.id);
        for (const viewer of s.viewers.keys()) viewer.attached.delete(s.id);
        s.screen.dispose();
        removeRecord(s.id);
        return send(c, { type: "result", rid: m.rid, value: {} });
      }
      case "upgrade":
        if (handingOff) return fail(c, m.rid, "upgrade-failed", "an update is already under way");
        send(c, { type: "result", rid: m.rid, value: {} });
        void handOff(m.entry, m.args ?? []);
        return;
    }
  };

  // ── serving ─────────────────────────────────────────────────────────────────
  const onConnection = (sock: Socket): void => {
    const c: Client = { sock, app: "", role: null, attached: new Map() };
    clients.add(c);
    const decoder = createLineDecoder();
    sock.setEncoding("utf8");
    const helloTimer = setTimeout(() => {
      if (c.role === null) sock.destroy();
    }, HELLO_TIMEOUT_MS);
    sock.on("data", (chunk: string) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const m of messages) handle(c, m);
    });
    // Caught up after falling behind: a fresh snapshot of every session it lagged on.
    sock.on("drain", () => {
      for (const [id, att] of c.attached) {
        const s = sessions.get(id);
        if (s && att.lagging && sock.writableLength <= highWater) {
          att.lagging = false;
          snapshotTo(c, s, att, true, undefined);
        }
      }
    });
    sock.on("error", () => sock.destroy());
    sock.on("close", () => {
      clearTimeout(helloTimer);
      clients.delete(c);
      for (const id of c.attached.keys()) sessions.get(id)?.viewers.delete(c);
      c.attached.clear();
    });
  };

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const srv = createServer(onConnection);
      srv.once("error", reject);
      srv.listen(socketPath, () => {
        srv.off("error", reject);
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          /* the folder's mode protects it */
        }
        server = srv;
        resolve();
      });
    });

  // ── update: hand the PTYs to a new keeper ──────────────────────────────────
  const handOff = async (entry: string, args: string[]): Promise<void> => {
    handingOff = true;
    log(`update: handing sessions to ${entry}`);
    // Stop accepting (connected clients are told below, once the state is written).
    server?.close();
    server = null;
    rmSync(socketPath, { force: true });
    const live = [...sessions.values()].filter((s) => !s.exit && s.hold);
    // Stop reading: unread bytes wait in the kernel for the next keeper.
    for (const s of live) s.hold?.freeze((d) => onOutput(s, d));
    await Promise.all([...sessions.values()].map((s) => s.screen.settled()));
    await Promise.all(
      live.map((s) => new Promise<void>((resolve) => (s.logStream ? s.logStream.end(() => resolve()) : resolve()))),
    );
    const fds: number[] = [];
    const recs: HandoffSession[] = [...sessions.values()].map((s) => {
      const ended = endedDuringHandoff.get(s);
      const held = !s.exit && !ended && s.hold ? s.hold : null;
      if (held) fds.push(held.fd);
      return {
        id: s.id,
        title: s.title,
        command: s.command,
        cwd: s.cwd,
        pid: s.pid,
        startedAt: s.startedAt,
        cols: s.screen.cols,
        rows: s.screen.rows,
        actions: s.actions,
        exit: s.exit ?? (ended ? exitOf(s, ended.code, ended.signal) : null),
        seq: s.seq,
        ring: ringText(s),
        screen: s.screen.serialize(),
        lastCtrlC: s.lastCtrlC,
        stopReason: s.stopReason,
        log: s.log,
        fdIndex: held ? 2 + fds.length : null,
      };
    });
    const file = join(stateDir, `handoff-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ from: process.pid, sessions: recs }));
    for (const c of clients) {
      send(c, { type: "keeper-restarting", reconnectAfterMs: 100 });
      c.sock.end();
    }
    const out = join(stateDir, "keeper.out");
    const outFd = await new Promise<number>((resolve) => {
      const ws = createWriteStream(out, { flags: "a" });
      ws.on("open", (fd) => resolve(fd));
      ws.on("error", () => resolve(-1));
    });
    const stdio: ("ignore" | number)[] = ["ignore", outFd >= 0 ? outFd : "ignore", outFd >= 0 ? outFd : "ignore", ...fds];
    const childEnv: NodeJS.ProcessEnv = { ...env, [HANDOFF_ENV]: file };
    const child = spawn(process.execPath, [entry, ...args], { detached: true, stdio, env: childEnv });
    child.on("error", () => undefined);
    const successor = { exited: false };
    child.on("exit", () => {
      successor.exited = true;
    });
    const deadline = Date.now() + HANDOFF_READY_MS;
    let ready = false;
    while (!successor.exited && Date.now() < deadline) {
      if (existsSync(socketPath) && (await answers(socketPath))) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (ready) {
      log(`update: pid ${child.pid} took ${fds.length} sessions; exiting`);
      child.unref();
      exitProcess(0);
      return;
    }
    // The new keeper never answered: take the sessions back.
    log(`update failed: ${successor.exited ? "the new keeper exited" : "no answer in time"}; resuming`);
    try {
      if (child.pid !== undefined && !successor.exited) process.kill(child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    rmSync(file, { force: true });
    rmSync(socketPath, { force: true });
    for (const s of live) {
      if (s.log && !s.exit) {
        s.logStream = createWriteStream(s.log, { flags: "a" });
        s.logStream.on("error", (err) => log(`log ${s.id}: ${err.message}`));
      }
      s.hold?.thaw();
    }
    handingOff = false;
    for (const [s, e] of endedDuringHandoff) finishExit(s, e.code, e.signal);
    endedDuringHandoff.clear();
    await listen();
  };

  // ── start ──────────────────────────────────────────────────────────────────
  const handoffFile = env[HANDOFF_ENV];
  if (handoffFile && existsSync(handoffFile)) {
    const h = JSON.parse(readFileSync(handoffFile, "utf8")) as { from: number; sessions: HandoffSession[] };
    for (const rec of h.sessions) sessions.set(rec.id, adoptSession(rec));
    rmSync(handoffFile, { force: true });
    log(`adopted ${h.sessions.length} sessions from pid ${h.from}`);
  } else {
    // Sessions a keeper was running when it died ended with it (the kernel hung up their PTYs).
    for (const name of readdirSync(join(stateDir, "sessions"))) {
      if (!name.endsWith(".json")) continue;
      let rec: SessionRecord;
      try {
        rec = JSON.parse(readFileSync(join(stateDir, "sessions", name), "utf8")) as SessionRecord;
      } catch {
        rmSync(join(stateDir, "sessions", name), { force: true });
        continue;
      }
      if (basename(name, ".json") !== rec.id) continue;
      const s = newSession({ ...rec, log: null }, 80, 24, null);
      if (!s.exit) {
        const code = readStatus(rec.id);
        s.exit = { code, signal: null, reason: "lost-in-keeper-crash", at: Date.now() };
        writeRecord(s);
        log(`session ${rec.id} was lost when the previous keeper ended`);
      }
      sessions.set(s.id, s);
    }
    pruneExited();
  }
  await listen();
  log(`keeper for ${app} listening on ${socketPath} (version ${version})`);

  return {
    socketPath,
    stateDir,
    sessions: () => [...sessions.values()].map(info),
    async close() {
      const srv = server;
      server = null;
      for (const c of clients) c.sock.destroy();
      await new Promise<void>((resolve) => (srv ? srv.close(() => resolve()) : resolve()));
      rmSync(socketPath, { force: true });
      for (const s of sessions.values()) {
        if (!s.exit && s.hold) s.hold.kill("SIGKILL");
        s.screen.dispose();
      }
    },
  };
}
