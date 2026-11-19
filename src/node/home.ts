// Where a running — or closed — Pomade can be found from Node: its home folder (`POMADE_HOME`,
// default `~/.pomade`, the stable Pomade's; `~/.pomade-dev` for the dev one), the workspace pointer and the host record it writes
// there (HOST-API §3 "Socket", §2 "Commands").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { HOME_FILES, POMADE_ENV, parseHostRecord, type HostRecord } from "../protocol/index.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface PomadeHomeOptions {
  /** Without `POMADE_HOME`: the stable Pomade's `~/.pomade` (default), or with `false` the dev Pomade's `~/.pomade-dev`. */
  stable?: boolean;
}

/** The Pomade home this process belongs to: `POMADE_HOME`, else the stable Pomade's `~/.pomade` —
 *  or the dev Pomade's `~/.pomade-dev` with `{ stable: false }`. */
export function pomadeHome(env: Env = process.env, options: PomadeHomeOptions = {}): string {
  const value = env[POMADE_ENV.home];
  return value ? resolve(value) : join(homedir(), options.stable === false ? ".pomade-dev" : ".pomade");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The workspace root, for a command or backend — with Pomade running or closed: `POMADE_WORKSPACE`
 * (absolute), else the workspace pointer Pomade records in its home (`<home>/workspace`), else
 * `null` (this Pomade never recorded one).
 */
export function resolveWorkspace(env: Env = process.env): string | null {
  const value = env[POMADE_ENV.workspace];
  if (value) return resolve(value);
  const pointer = readText(join(pomadeHome(env), HOME_FILES.workspace))?.trim();
  return pointer && isAbsolute(pointer) ? pointer : null;
}

/** The app's machine-local state folder (`POMADE_APP_STATE`, `<userData>/app-state/<id>/`): run
 *  history, captured output, caches. `null` outside an app's backend or command. */
export function appStateDir(env: Env = process.env): string | null {
  const value = env[POMADE_ENV.appState];
  return value ? resolve(value) : null;
}

/** The host record Pomade writes at start (`<home>/host.json`): its socket and how to launch it. */
export function readHostRecord(env: Env = process.env): HostRecord | null {
  const text = readText(join(pomadeHome(env), HOME_FILES.host));
  return text === null ? null : parseHostRecord(text);
}
