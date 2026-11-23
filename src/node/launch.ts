// Launch Pomade and wait until it is ready (HOST-API §2 "Backends", always-on): an always-on backend
// or a command that needs Pomade starts it the way Pomade recorded (`host.json` `launch`) and waits
// for the socket handshake. A launch that never gets ready leaves nothing running: the process it
// started directly is stopped with its process group.

import { spawn } from "node:child_process";

import type { RejectReason } from "../protocol/index.js";
import { readHostRecord, type Env } from "./home.js";
import { connectSocket, type SocketConnectOptions, type SocketConnectResult } from "./socket.js";

export interface LaunchOptions extends SocketConnectOptions {
  /** How long to wait for Pomade to answer after launching it. Default 60000 ms. */
  readyTimeoutMs?: number;
  /** How often to try the socket while waiting. Default 250 ms. */
  pollMs?: number;
  /** A started Pomade that never got ready: how long it has to quit after SIGTERM before SIGKILL. Default 5000 ms. */
  stopGraceMs?: number;
}

export type LaunchResult =
  | (SocketConnectResult & { status: "connected"; /** True when this call started Pomade. */ launched: boolean; /** The started process (a dev build run directly); absent for `open -a`. */ pid?: number })
  | { status: "rejected"; reason: RejectReason; hostApi: number }
  | { status: "failed"; reason: string };

/** macOS's `open`: it hands the app to Launch Services and exits; the app is not its child. */
const OPEN = "/usr/bin/open";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* the group is gone */
  }
}

/**
 * Connect to Pomade, launching it first when it is not running. Resolves `connected` (with
 * `launched`), `rejected`, or `failed`: nothing recorded to launch, the launch could not start or
 * ended before Pomade answered (at once, with the reason), or no answer in time. A process this call
 * started directly that never got ready is stopped — SIGTERM to its process group, SIGKILL after
 * `stopGraceMs` — before `failed` resolves. A launch through `open -a` hands Pomade to macOS and has
 * nothing of its own to stop.
 */
export async function launchPomade(options: LaunchOptions = {}): Promise<LaunchResult> {
  const env: Env = options.env ?? process.env;
  const first = await connectSocket(options);
  if (first.status === "connected") return { ...first, launched: false };
  if (first.status === "rejected") return first;
  const record = readHostRecord(env);
  if (!record) return { status: "failed", reason: "this Pomade recorded no way to launch it (no host.json)" };
  const [program, ...args] = record.launch.argv as [string, ...string[]];
  const direct = program !== OPEN;
  // Pomade's own runtime runs this backend in Node mode; the app it launches must not inherit that.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") childEnv[k] = v;
  Object.assign(childEnv, record.launch.env);
  const child = { pid: undefined as number | undefined, error: null as Error | null, ended: null as { code: number | null; signal: NodeJS.Signals | null } | null };
  // Set by the process's events, so read through a call (not narrowed between awaits).
  const hasEnded = (): boolean => child.ended !== null;
  try {
    const proc = spawn(program, args, { detached: true, stdio: "ignore", env: childEnv });
    child.pid = proc.pid;
    proc.on("error", (err) => (child.error = err));
    proc.on("exit", (code, signal) => (child.ended = { code, signal }));
    proc.unref();
  } catch (err) {
    return { status: "failed", reason: `could not launch Pomade: ${(err as Error).message}` };
  }
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60000);
  const socketOptions: SocketConnectOptions = { ...options, socketPath: options.socketPath ?? record.socket, timeoutMs: options.timeoutMs ?? 2000 };
  for (;;) {
    const r = await connectSocket(socketOptions);
    if (r.status === "connected") return { ...r, launched: true, ...(child.pid !== undefined && direct ? { pid: child.pid } : {}) };
    if (r.status === "rejected") return r;
    if (child.error) return { status: "failed", reason: `could not launch Pomade: ${child.error.message}` };
    const ended = child.ended;
    // `open` exits once macOS took the app; only its failure ends the wait.
    if (ended && (direct || ended.code !== 0)) {
      // What it left in its group (a helper it started) goes with it.
      if (direct && child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      const how = ended.signal ? `signal ${ended.signal}` : `code ${ended.code}`;
      return { status: "failed", reason: `${direct ? "Pomade" : "open"} exited before Pomade was ready (${how})` };
    }
    if (Date.now() >= deadline) break;
    await sleep(options.pollMs ?? 250);
  }
  if (direct && child.pid !== undefined && !hasEnded()) {
    const pid = child.pid;
    killGroup(pid, "SIGTERM");
    const graceEnd = Date.now() + (options.stopGraceMs ?? 5000);
    while (!hasEnded() && Date.now() < graceEnd) await sleep(25);
    // Its helpers (Electron's renderer and GPU processes) share the group: none outlives the launch.
    killGroup(pid, "SIGKILL");
    return { status: "failed", reason: "Pomade did not become ready in time; the process it started was stopped" };
  }
  return { status: "failed", reason: "Pomade did not become ready in time" };
}
