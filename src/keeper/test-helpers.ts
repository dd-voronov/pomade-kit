// Shared by the keeper tests: short temp folders (macOS caps socket paths at 104 bytes), keepers in
// this process or in their own, clients that collect what a session sends, and the cell-by-cell
// screen comparison from the pomade:E-034 spike.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach } from "vitest";

import type { KeeperMessage, SessionExit } from "../protocol/index.js";
import { Terminal, type Terminal as HeadlessTerminal } from "../scanners/xterm-headless.js";
import { connectKeeper, type KeeperClient } from "../node/keeper.js";
import { runKeeper, type Keeper, type KeeperOptions } from "./keeper.js";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const ENTRY = join(FIXTURES, "keeper-entry.mjs");

/** Sessions run `/bin/sh` as the login shell, so no test reads the user's shell profile. */
export const TEST_ENV: NodeJS.ProcessEnv = { ...process.env, SHELL: "/bin/sh" };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(probe: () => T | Promise<T>, what: string, ms = 10000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Run `fn` in teardown. */
export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function tmpDir(): string {
  const dir = mkdtempSync("/tmp/pk-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface InProcess {
  keeper: Keeper;
  socketPath: string;
  stateDir: string;
  dir: string;
}

export async function keeperInProcess(options: Partial<KeeperOptions> = {}, dir = tmpDir()): Promise<InProcess> {
  const socketPath = join(dir, "k.sock");
  const stateDir = join(dir, "state");
  const keeper = await runKeeper({ app: "hello", socketPath, stateDir, ownerKey: null, env: TEST_ENV, log: () => undefined, ...options });
  cleanups.push(() => keeper.close());
  return { keeper, socketPath, stateDir, dir };
}

/** The built library must be current: process-level tests run `dist/` (a new keeper is a new process). */
export function requireFreshDist(): void {
  const root = resolve(FIXTURES, "../../..");
  const built = join(root, "dist/keeper/keeper.js");
  if (!existsSync(built)) throw new Error("run `npm run build` first: the keeper process tests run dist/");
  const newest = (dir: string): number =>
    Math.max(...readdirSync(dir).map((f) => (f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-helpers.ts" ? statSync(join(dir, f)).mtimeMs : 0)));
  if (newest(join(root, "src/keeper")) > statSync(built).mtimeMs) throw new Error("dist/ is older than src/keeper: run `npm run build`");
}

export interface Spawned {
  child: ChildProcess;
  socketPath: string;
  stateDir: string;
  dir: string;
}

/** A keeper in its own process (the built library), killed in teardown with whatever it holds. */
export async function keeperProcess(env: NodeJS.ProcessEnv = {}, dir = tmpDir()): Promise<Spawned> {
  requireFreshDist();
  const socketPath = join(dir, "k.sock");
  const stateDir = join(dir, "state");
  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio: "ignore",
    env: { ...TEST_ENV, POMADE_APP_ID: "hello", POMADE_KEEPER_SOCKET: socketPath, KEEPER_TEST_STATE: stateDir, ...env },
  });
  child.unref();
  track(stateDir, "keeper", child.pid);
  cleanups.push(() => killKeepers(stateDir));
  await waitFor(async () => {
    const r = await connectKeeper({ socketPath, app: "test", timeoutMs: 500 });
    if (r.status !== "connected") return false;
    r.keeper.close();
    return true;
  }, "the keeper process to answer");
  return { child, socketPath, stateDir, dir };
}

/** Kill every keeper process that served `stateDir` (an update starts new ones) and their sessions. */
export function killKeepers(stateDir: string): void {
  const pids = new Set<number>();
  for (const pid of keeperPids.get(stateDir) ?? []) pids.add(pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const recorded = new Set(sessionPids.get(stateDir) ?? []);
  try {
    for (const name of readdirSync(join(stateDir, "sessions"))) {
      const pid = (JSON.parse(readFileSync(join(stateDir, "sessions", name), "utf8")) as { pid?: number | null }).pid;
      if (pid) recorded.add(pid);
    }
  } catch {
    /* no records */
  }
  for (const pid of recorded) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}
const keeperPids = new Map<string, Set<number>>();
const sessionPids = new Map<string, Set<number>>();
/** Remember a process to kill in teardown. */
export function track(stateDir: string, kind: "keeper" | "session", pid: number | null | undefined): void {
  if (!pid) return;
  const map = kind === "keeper" ? keeperPids : sessionPids;
  const set = map.get(stateDir) ?? new Set<number>();
  set.add(pid);
  map.set(stateDir, set);
}

export interface Connected {
  k: KeeperClient;
  /** Every session event, in order. */
  events: KeeperMessage[];
  /** Output text per session (after any snapshot), concatenated. */
  output(session: string): string;
  exitOf(session: string): SessionExit | undefined;
}

export async function connect(socketPath: string, role: "owner" | "viewer" = "owner", key?: string): Promise<Connected> {
  const r = await connectKeeper({ socketPath, app: role === "owner" ? "hello" : "pomade", role, ...(key !== undefined ? { key } : {}) });
  if (r.status !== "connected") throw new Error(`connect: ${r.status} ${"reason" in r ? r.reason : r.message}`);
  const events: KeeperMessage[] = [];
  r.keeper.onEvent((e) => events.push(e));
  cleanups.push(() => r.keeper.close());
  return {
    k: r.keeper,
    events,
    output: (session) =>
      events
        .filter((e): e is Extract<KeeperMessage, { type: "output" }> => e.type === "output" && e.session === session)
        .map((e) => e.data)
        .join(""),
    exitOf: (session) => {
      const e = events.find((x): x is Extract<KeeperMessage, { type: "exit" }> => x.type === "exit" && x.session === session);
      return e?.exit;
    },
  };
}

/** A headless terminal standing in for Pomade's pane; counts the answers it produces. */
export function viewTerm(cols: number, rows: number): { term: HeadlessTerminal; answers: string[]; write(d: string): Promise<void> } {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  const answers: string[] = [];
  term.onData((d) => answers.push(d));
  return { term, answers, write: (d) => new Promise((r) => term.write(d, r)) };
}

interface CoreState {
  buffer: { scrollTop: number; scrollBottom: number };
  coreMouseService: { activeEncoding: string };
  coreService: { isCursorHidden: boolean };
}

/** Everything a viewer can see or that affects what the program receives next, cell by cell. */
export function screenState(term: HeadlessTerminal): Record<string, unknown> {
  const b = term.buffer.active;
  const cell = b.getNullCell();
  const cells: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.baseY + y);
    for (let x = 0; x < term.cols; x++) {
      line?.getCell(x, cell);
      cells.push(
        [cell.getChars() || " ", cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
          cell.isBold(), cell.isInverse(), cell.isUnderline(), cell.isItalic(), cell.isDim()].join(","),
      );
    }
  }
  const core = (term as unknown as { _core: CoreState })._core;
  return {
    buffer: b.type,
    cursor: [b.cursorX, b.cursorY],
    cursorHidden: core.coreService.isCursorHidden,
    scrollRegion: [core.buffer.scrollTop, core.buffer.scrollBottom],
    modes: { ...term.modes },
    mouseEncoding: core.coreMouseService.activeEncoding,
    cells,
  };
}

export function isAliveForTest(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
