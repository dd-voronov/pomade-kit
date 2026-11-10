// pomade-kit/node — post a notice to Pomade from a backend or a command (pomade:E-032).
//
// The notice lands in Pomade's closed-Pomade queue: one small JSON file in
// `<userData>/notices/queue/`, written to a dot-file first and renamed into place, so Pomade never
// reads half a notice. Pomade drains the folder when it starts and watches it while it runs, so the
// same call works with Pomade open or closed.
//
// The seam for a live transport: once Pomade's Host API socket exists (pomade:E-028), `postNotice`
// sends `notices.post` over it when Pomade is running and falls back to `queueNotice` otherwise —
// callers keep calling `postNotice`.

import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  APP_ID_RE,
  checkNotice,
  NOTICE_QUEUE_DIR,
  queuedNoticeFileName,
  type NoticeParams,
  type QueuedNotice,
} from "../protocol/index.js";

export interface PomadeTarget {
  /** Target the stable Pomade instead of the dev one. Ignored when `POMADE_USER_DATA` (or `userData`) is set. */
  stable?: boolean;
  /** Pomade's user-data folder, explicitly (tests). */
  userData?: string;
  /** Where `POMADE_USER_DATA` is read; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface PostNoticeOptions extends PomadeTarget {
  /** Who posts: the app's id, or a platform command's name (`pomade-git`). Notices are grouped, coalesced and muted by it. */
  source: string;
  /** The posting time; default now. */
  now?: () => Date;
}

/** Pomade's user-data folder, as the `pomade` command resolves it: `userData`, else `POMADE_USER_DATA`,
 *  else `~/Library/Application Support/pomade-dev` — or `…/Pomade` with `stable`. A dev Pomade and the
 *  stable one never share it. */
export function pomadeUserData(target: PomadeTarget = {}): string {
  if (target.userData) return target.userData;
  const override = (target.env ?? process.env).POMADE_USER_DATA;
  if (override && override.trim()) return override;
  return join(homedir(), "Library", "Application Support", target.stable ? "Pomade" : "pomade-dev");
}

/** Write `notice` into Pomade's queue (atomically); resolves with the queued file's path. Throws on an
 *  invalid notice or source — the same rules as `notices.post`. */
export async function queueNotice(notice: NoticeParams, options: PostNoticeOptions): Promise<{ path: string }> {
  if (!APP_ID_RE.test(options.source)) throw new Error(`pomade-kit: "source" must match ${APP_ID_RE.source} (got ${JSON.stringify(options.source)})`);
  const checked = checkNotice(notice);
  if (!checked.ok) throw new Error(`pomade-kit: ${checked.error.message}`);
  const at = (options.now ?? (() => new Date()))();
  const queued: QueuedNotice = { ...checked.value, source: options.source, postedAt: at.toISOString() };
  const dir = join(pomadeUserData(options), NOTICE_QUEUE_DIR);
  await mkdir(dir, { recursive: true });
  const name = queuedNoticeFileName(at, randomBytes(6).toString("hex"));
  const tmp = join(dir, `.${name}.tmp`);
  const path = join(dir, name);
  try {
    await writeFile(tmp, `${JSON.stringify(queued)}\n`, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { path };
}

/** Post a notice to Pomade, open or closed (see the file header for the transport seam). */
export async function postNotice(notice: NoticeParams, options: PostNoticeOptions): Promise<{ path: string }> {
  return queueNotice(notice, options);
}
