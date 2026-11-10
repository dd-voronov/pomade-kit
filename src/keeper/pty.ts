// The keeper's hold on a PTY: a session it spawned (node-pty, a peer dependency), or one it adopted
// from the keeper it replaced (the PTY master fd, inherited). Both look the same to the keeper.

import { accessSync, chmodSync, constants, existsSync, write as fsWrite } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tty from "node:tty";

const require = createRequire(import.meta.url);

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): NodePtyProcess;
}
interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
/** node-pty's own fields this module relies on (private, pinned with node-pty 1.x). */
interface NodePtyInternals {
  _fd: number;
  _socket: tty.ReadStream;
}

let loaded: { pty: NodePty; resize: (fd: number, cols: number, rows: number) => void } | null = null;

/**
 * Load node-pty once. Its prebuilt `spawn-helper` can lose its executable bit when a package
 * manager unpacks it (`posix_spawnp failed`), so the bit is restored here before the first spawn.
 */
function nodePty(): NonNullable<typeof loaded> {
  if (loaded) return loaded;
  let root: string;
  try {
    root = dirname(require.resolve("node-pty/package.json"));
  } catch {
    throw new Error("pomade-kit/keeper needs node-pty (a peer dependency): install it next to pomade-kit");
  }
  for (const dir of ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = join(root, dir, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* read-only install: node-pty reports the spawn failure itself */
      }
    }
  }
  const pty = require("node-pty") as NodePty;
  const native = (require("node-pty/lib/utils") as { loadNativeModule(name: string): { module: { resize(fd: number, c: number, r: number): void } } })
    .loadNativeModule("pty").module;
  loaded = { pty, resize: (fd, c, r) => native.resize(fd, c, r) };
  return loaded;
}

/** What the keeper does with a PTY, however it got it. */
export interface PtyHold {
  readonly pid: number;
  /** The PTY master's fd (handed to the next keeper on an update). */
  readonly fd: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Signal the session's process group (falls back to the process). */
  kill(signal: NodeJS.Signals): void;
  /** Stop reading for a hand-off. Bytes this process already read are passed to `drain`; the rest
   *  stay in the kernel for the next keeper. */
  freeze(drain: (data: string) => void): void;
  /** Read again (a hand-off that did not happen). */
  thaw(): void;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

// A paused stream still holds bytes it already read from the kernel, and they would vanish with
// this process. So stop the handle reading first, then drain the stream's own buffer.
function freezeStream(stream: tty.ReadStream, drain: (data: string) => void): void {
  stream.pause();
  const handle = (stream as unknown as { _handle?: { readStop?(): void } })._handle;
  handle?.readStop?.();
  let chunk: unknown;
  while ((chunk = stream.read()) !== null) drain(typeof chunk === "string" ? chunk : String(chunk));
}

function thawStream(stream: tty.ReadStream): void {
  const handle = (stream as unknown as { _handle?: { readStart?(): void } })._handle;
  handle?.readStart?.();
  stream.resume();
}

export interface SpawnedPty {
  hold: PtyHold;
  onData(cb: (data: string) => void): void;
  /** After the last output has been delivered. */
  onExit(cb: (exitCode: number, signal: number | undefined) => void): void;
}

export function spawnPty(file: string, args: string[], options: { cols: number; rows: number; cwd: string; env: Record<string, string> }): SpawnedPty {
  const { pty, resize } = nodePty();
  const p = pty.spawn(file, args, { name: "xterm-256color", ...options });
  const internals = p as unknown as NodePtyInternals;
  const hold: PtyHold = {
    pid: p.pid,
    fd: internals._fd,
    write: (d) => p.write(d),
    resize: (c, r) => {
      try {
        p.resize(c, r);
      } catch {
        resize(internals._fd, c, r);
      }
    },
    kill: (signal) => killGroup(p.pid, signal),
    freeze: (drain) => freezeStream(internals._socket, drain),
    thaw: () => thawStream(internals._socket),
  };
  return {
    hold,
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(({ exitCode, signal }) => cb(exitCode, signal)),
  };
}

export interface AdoptedPty {
  hold: PtyHold;
  onData(cb: (data: string) => void): void;
  /** The PTY hung up: every process on its terminal side is gone. */
  onEnd(cb: () => void): void;
}

/** Take over a PTY master fd inherited from the previous keeper. This keeper is not the session's
 *  parent: the end is seen as a hang-up, the status comes from the shim's file. */
export function adoptPty(fd: number, pid: number): AdoptedPty {
  const { resize } = nodePty();
  const stream = new tty.ReadStream(fd);
  stream.setEncoding("utf8");
  const queue: Buffer[] = [];
  let writing = false;
  const pump = (): void => {
    if (writing) return;
    const buf = queue[0];
    if (!buf) return;
    writing = true;
    fsWrite(fd, buf, 0, buf.length, null, (err, n) => {
      writing = false;
      if (err && err.code === "EAGAIN") {
        setTimeout(pump, 5);
        return;
      }
      if (err) {
        queue.length = 0;
        return;
      }
      if (n < buf.length) queue[0] = buf.subarray(n);
      else queue.shift();
      pump();
    });
  };
  let ended = false;
  const endListeners: (() => void)[] = [];
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const cb of endListeners) cb();
  };
  stream.on("error", end);
  stream.on("end", end);
  stream.on("close", end);
  const hold: PtyHold = {
    pid,
    fd,
    write: (d) => {
      queue.push(Buffer.from(d, "utf8"));
      pump();
    },
    resize: (c, r) => {
      try {
        resize(fd, c, r);
      } catch {
        /* the PTY is gone; the end follows */
      }
    },
    kill: (signal) => killGroup(pid, signal),
    freeze: (drain) => freezeStream(stream, drain),
    thaw: () => thawStream(stream),
  };
  return {
    hold,
    onData: (cb) => stream.on("data", (d: string) => cb(d)),
    onEnd: (cb) => endListeners.push(cb),
  };
}

/** True while `pid` exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
