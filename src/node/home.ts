// Where a running — or closed — Pomade can be found from Node: its home folder (`POMADE_HOME`,
// default `~/.pomade`, the stable Pomade's), the workspace pointer and the host record it writes
// there (HOST-API §3 "Socket", §2 "Commands").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { HOME_FILES, POMADE_ENV, parseHostRecord, type HostRecord } from "../protocol/index.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** The Pomade home this process belongs to: `POMADE_HOME`, else the stable Pomade's `~/.pomade`. */
export function pomadeHome(env: Env = process.env): string {
  const value = env[POMADE_ENV.home];
  return value ? resolve(value) : join(homedir(), ".pomade");
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

/** The host record Pomade writes at start (`<home>/host.json`): its socket and how to launch it. */
export function readHostRecord(env: Env = process.env): HostRecord | null {
  const text = readText(join(pomadeHome(env), HOME_FILES.host));
  return text === null ? null : parseHostRecord(text);
}
