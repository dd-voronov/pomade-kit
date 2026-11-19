// Hello's always-on backend: keeps the app's keeper running with a demo service in it — a ticker
// that prints a line a second and echoes what is typed — so an attached tab in Pomade shows it,
// with Pomade open or closed. The ticker's Restart header action reaches this backend as the
// `attachedTab.action` event. It serves the app's API (`status`): the UI's "Ask the backend" goes
// through Pomade's broker to here and back.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectKeeper, startKeeper, stayConnected } from "pomade-kit/node";

const here = dirname(fileURLToPath(import.meta.url));
const SESSION = "ticker";
const TICKER = `i=0; while :; do i=$((i+1)); printf 'tick %d  %s\\n' "$i" "$(date +%H:%M:%S)"; if read -t 1 line; then echo "you typed: $line"; fi; done`;

const socketPath = process.env.POMADE_KEEPER_SOCKET;
const appId = process.env.POMADE_APP_ID;

async function owner() {
  const key = readFileSync(process.env.POMADE_APP_KEY_FILE, "utf8").trim();
  const r = await connectKeeper({ socketPath, app: appId, role: "owner", key });
  if (r.status !== "connected") throw new Error(`keeper: ${r.status}`);
  return r.keeper;
}

/** The ticker's state in the keeper: `running`, `exited`, or `no keeper` when none answers. */
async function tickerState() {
  if (!socketPath) return "no keeper";
  const r = await connectKeeper({ socketPath, app: appId, timeoutMs: 1000 });
  if (r.status !== "connected") return "no keeper";
  try {
    return (await r.keeper.list()).find((x) => x.id === SESSION)?.state ?? "not started";
  } finally {
    r.keeper.close();
  }
}

/** Start the ticker unless it runs; with `restart`, stop it first. */
async function ensureTicker({ restart = false } = {}) {
  const k = await owner();
  try {
    let s = (await k.list()).find((x) => x.id === SESSION);
    if (restart && s?.state === "running") {
      await k.stop(SESSION, { reason: "stopped" });
      for (let i = 0; i < 100 && s?.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        s = (await k.list()).find((x) => x.id === SESSION);
      }
    }
    if (!s || s.state === "exited") {
      await k.spawn({ id: SESSION, title: "Ticker", command: TICKER, cwd: homedir(), actions: [{ id: "restart", title: "Restart" }] });
    }
  } finally {
    k.close();
  }
}

async function keepUp() {
  const r = await startKeeper({ entry: join(here, "keeper.mjs") });
  if (r.status !== "running") {
    console.error(`hello backend: ${r.reason}`);
    return;
  }
  await ensureTicker().catch((err) => console.error(`hello backend: ${err.message}`));
}

await keepUp();
setInterval(() => void keepUp(), 5000);

stayConnected(
  { role: "backend" },
  {
    async onConnect(host) {
      await host.api.serve({
        status: async () => ({ pid: process.pid, ticker: await tickerState() }),
      });
      await host.events.subscribe("attachedTab.action", (payload) => {
        if (payload.session.app === appId && payload.session.session === SESSION && payload.action === "restart") {
          void ensureTicker({ restart: true }).catch((err) => console.error(`hello backend: ${err.message}`));
        }
      });
    },
  },
);
