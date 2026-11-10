// pomade-kit/node — helpers for commands and backends running under Node.

import { resolve } from "node:path";

/**
 * The workspace root for a command running with Pomade closed: `POMADE_WORKSPACE`, as an
 * absolute path, or `null` when it is not set.
 */
export function resolveWorkspace(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env.POMADE_WORKSPACE;
  return value ? resolve(value) : null;
}
export { pomadeUserData, postNotice, queueNotice, type PomadeTarget, type PostNoticeOptions } from "./notices.js";
