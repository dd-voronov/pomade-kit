// Who a pid is now: its process group and when it started, as `ps` reports them. The keeper proves
// with them that a pid it recorded still names the same process before it signals that process's
// group — a pid is reused once its process is gone.

import { execFileSync } from "node:child_process";

export interface ProcessStamp {
  /** Its process group. */
  pgid: number;
  /** When it started, epoch seconds (`ps` reports whole seconds). */
  startSec: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `lstart` in the C locale and UTC: `Thu Nov 19 00:51:00 2026`. */
const LINE = /^\s*(\d+)\s+(\d+)\s+\w{3} (\w{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s*$/;

/** The live processes among `pids`, with their group and start time. A pid that is gone, or that
 *  `ps` cannot report, is absent from the answer. */
export function processStamps(pids: number[]): Map<number, ProcessStamp> {
  const stamps = new Map<number, ProcessStamp>();
  const wanted = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (wanted.length === 0) return stamps;
  let out: string;
  try {
    out = execFileSync("/bin/ps", ["-o", "pid=,pgid=,lstart=", "-p", wanted.join(",")], {
      env: { LC_ALL: "C", TZ: "UTC0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch (err) {
    // `ps` exits 1 when none of the pids exists.
    out = String((err as { stdout?: unknown }).stdout ?? "");
  }
  for (const line of out.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[3] ?? "");
    if (month < 0) continue;
    const startMs = Date.UTC(Number(m[8]), month, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
    stamps.set(Number(m[1]), { pgid: Number(m[2]), startSec: startMs / 1000 });
  }
  return stamps;
}
