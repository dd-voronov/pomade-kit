// Launch Pomade and wait until it is ready (HOST-API §2 "Backends", always-on): an always-on backend
// or a command that needs Pomade starts it the way Pomade recorded (`host.json` `launch`) and waits
// for the socket handshake.

import { spawn } from "node:child_process";

import type { RejectReason } from "../protocol/index.js";
import { readHostRecord, type Env } from "./home.js";
import { connectSocket, type SocketConnectOptions, type SocketConnectResult } from "./socket.js";

export interface LaunchOptions extends SocketConnectOptions {
  /** How long to wait for Pomade to answer after launching it. Default 60000 ms. */
  readyTimeoutMs?: number;
  /** How often to try the socket while waiting. Default 250 ms. */
  pollMs?: number;
}

export type LaunchResult =
  | (SocketConnectResult & { status: "connected"; /** True when this call started Pomade. */ launched: boolean; /** The started process (a dev build run directly); absent for `open -a`. */ pid?: number })
  | { status: "rejected"; reason: RejectReason; hostApi: number }
  | { status: "failed"; reason: string };

/**
 * Connect to Pomade, launching it first when it is not running. Resolves `connected` (with
 * `launched`), `rejected`, or `failed` (nothing recorded to launch, or no answer in time).
 */
export async function launchPomade(options: LaunchOptions = {}): Promise<LaunchResult> {
  const env: Env = options.env ?? process.env;
  const first = await connectSocket(options);
  if (first.status === "connected") return { ...first, launched: false };
  if (first.status === "rejected") return first;
  const record = readHostRecord(env);
  if (!record) return { status: "failed", reason: "this Pomade recorded no way to launch it (no host.json)" };
  const [program, ...args] = record.launch.argv as [string, ...string[]];
  // Pomade's own runtime runs this backend in Node mode; the app it launches must not inherit that.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") childEnv[k] = v;
  Object.assign(childEnv, record.launch.env);
  let pid: number | undefined;
  try {
    const child = spawn(program, args, { detached: true, stdio: "ignore", env: childEnv });
    pid = child.pid;
    child.on("error", () => undefined);
    child.unref();
  } catch (err) {
    return { status: "failed", reason: `could not launch Pomade: ${(err as Error).message}` };
  }
  const deadline = Date.now() + (options.readyTimeoutMs ?? 60000);
  const socketOptions: SocketConnectOptions = { ...options, socketPath: options.socketPath ?? record.socket, timeoutMs: options.timeoutMs ?? 2000 };
  while (Date.now() < deadline) {
    const r = await connectSocket(socketOptions);
    if (r.status === "connected") return { ...r, launched: true, ...(pid !== undefined && program !== "/usr/bin/open" ? { pid } : {}) };
    if (r.status === "rejected") return r;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
  return { status: "failed", reason: "Pomade did not become ready in time" };
}
