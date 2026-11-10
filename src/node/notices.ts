// pomade-kit/node — post a notice to Pomade from a backend or a command (pomade:E-032).
//
// With Pomade running, `postNotice` sends `notices.post` over the Host API socket (pomade:E-028) —
// over the caller's own connection (`host`), or a short one made with its identity from the
// environment. With Pomade closed (or no identity configured) the notice lands in Pomade's
// closed-Pomade queue: one small JSON file in `<userData>/notices/queue/`, written to a dot-file first
// and renamed into place, so Pomade never reads half a notice; Pomade drains the folder when it starts
// and watches it while it runs. The same call works either way.

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
  POMADE_ENV,
} from "../protocol/index.js";
import type { HostClient } from "../sdk/client.js";
import { connectSocket, type SocketConnectResult } from "./socket.js";

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
  /** A connected socket client to post with; default: connect with the identity in `env`. */
  host?: HostClient;
  /** How long to wait for Pomade on the socket before queueing. Default 2000 ms. */
  timeoutMs?: number;
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

/** Where a notice went: shown by the running Pomade (`path: null`), or queued at `path`. */
export interface PostNoticeResult {
  delivered: "pomade" | "queue";
  path: string | null;
}

/** The notice with its source, for the socket: a platform command names its source; for an app
 *  Pomade takes the app id it authenticated. */
function withSource(notice: NoticeParams, source: string): NoticeParams & { source: string } {
  return { ...notice, source };
}

/** Post a notice to Pomade, open or closed (see the file header). Throws on an invalid notice or source. */
export async function postNotice(notice: NoticeParams, options: PostNoticeOptions): Promise<PostNoticeResult> {
  if (!APP_ID_RE.test(options.source)) throw new Error(`pomade-kit: "source" must match ${APP_ID_RE.source} (got ${JSON.stringify(options.source)})`);
  const checked = checkNotice(notice);
  if (!checked.ok) throw new Error(`pomade-kit: ${checked.error.message}`);
  if (options.host) {
    await options.host.notices.post(withSource(checked.value, options.source));
    return { delivered: "pomade", path: null };
  }
  const env = options.env ?? process.env;
  if (env[POMADE_ENV.appId]) {
    let r: SocketConnectResult | null = null;
    try {
      r = await connectSocket({ env, timeoutMs: options.timeoutMs ?? 2000 });
    } catch {
      r = null; // no readable identity: queue
    }
    if (r?.status === "connected") {
      try {
        await r.host.notices.post(withSource(checked.value, options.source));
        return { delivered: "pomade", path: null };
      } finally {
        r.host.close();
      }
    }
  }
  const { path } = await queueNotice(notice, options);
  return { delivered: "queue", path };
}
