// What a session runs in: the environment of a Pomade terminal, and the shim that records how the
// session ended.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";

import { POMADE_ENV } from "../protocol/index.js";

/** Names never passed from the keeper to a session: its runtime switch and the app's identity and state folder. */
const STRIP = new Set<string>([
  "ELECTRON_RUN_AS_NODE",
  POMADE_ENV.appId,
  POMADE_ENV.keyFile,
  POMADE_ENV.role,
  POMADE_ENV.keeperSocket,
  POMADE_ENV.appState,
  "POMADE_KEEPER_HANDOFF",
]);

/**
 * A session's environment: the keeper's own (minus its runtime switch and the app's identity),
 * the terminal variables Pomade's own terminals set — `TERM=xterm-256color`, `TERM_PROGRAM=Apple_Terminal`
 * (agent CLIs then notify the way they do in Terminal.app), `LANG` when unset — and the spawn's
 * own `env` on top. A launchd job starts with almost nothing set; the login shell a `command`
 * runs in adds the user's `PATH` and the rest of their profile.
 */
export function sessionEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIP.has(key)) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.TERM_PROGRAM = "Apple_Terminal";
  env.TERM_PROGRAM_VERSION = "453";
  env.POMADE = "1";
  env.LANG = env.LANG || "en_US.UTF-8";
  return Object.assign(env, extra);
}

/** The user's login shell: `SHELL`, else the account's shell, else zsh. */
export function loginShell(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SHELL;
  if (fromEnv && fromEnv.startsWith("/") && existsSync(fromEnv)) return fromEnv;
  try {
    const shell = userInfo().shell;
    if (shell && existsSync(shell)) return shell;
  } catch {
    /* no passwd entry */
  }
  return "/bin/zsh";
}

/**
 * The session's direct child, run as `/bin/sh -c SHIM pomade-keeper <status-file> <program> <args…>`:
 * it runs the program, then writes its exit status to the status file, so a keeper that is not
 * the session's parent (after an update) still learns how it ended. INT, TERM and QUIT are caught
 * with a no-op, not ignored — an ignored signal would be inherited by the program (Ctrl+C would
 * stop working); a caught one is reset on exec. HUP keeps its default, so a keeper crash (the
 * kernel hangs up the PTY) ends the whole session. The shim's own stderr goes nowhere, so its
 * job report ("Terminated: 15") never lands in the session's output; the program keeps the real one.
 */
export const SHIM = `status_file=$1
shift
trap ':' INT TERM QUIT
exec 3>&2 2>/dev/null
"$@" 2>&3 3>&-
code=$?
echo "$code" > "$status_file"
exit "$code"`;
