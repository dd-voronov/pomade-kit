// The hello example's always-on backend (examples/hello/public/backend): it starts the app's keeper
// with a ticking demo service, and the service keeps running after the backend is gone — as it
// does when Pomade quits.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { FIXTURES, TEST_ENV, connect, isAliveForTest, killKeepers, requireFreshDist, sleep, tmpDir, track, waitFor } from "./test-helpers.js";
import { connectKeeper } from "../node/keeper.js";

const BACKEND = resolve(FIXTURES, "../../../examples/hello/public/backend/main.mjs");

describe("hello's always-on backend", { timeout: 30_000 }, () => {
  it("runs a ticker in the keeper that takes input and outlives the backend", async () => {
    requireFreshDist();
    const dir = tmpDir();
    const socketPath = join(dir, "run/keepers/hello.sock");
    const stateDir = join(dir, "app-state/hello/keeper");
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "secret\n");
    const backend = spawn(process.execPath, [BACKEND], {
      stdio: "ignore",
      env: { ...TEST_ENV, POMADE_APP_ID: "hello", POMADE_APP_KEY_FILE: keyFile, POMADE_KEEPER_SOCKET: socketPath, POMADE_CLIENT: "backend", POMADE_SOCKET: join(dir, "none.sock") },
    });
    try {
      const keeperPid = await waitFor(async () => {
        const r = await connectKeeper({ socketPath, app: "test", timeoutMs: 300 });
        if (r.status !== "connected") return 0;
        r.keeper.close();
        return r.keeper.keeper.pid;
      }, "the keeper");
      track(stateDir, "keeper", keeperPid);
      const viewer = await connect(socketPath, "viewer");
      const ticker = await waitFor(async () => (await viewer.k.list()).find((s) => s.id === "ticker"), "the ticker");
      track(stateDir, "session", ticker.pid);
      expect(ticker).toMatchObject({ title: "Ticker", state: "running", actions: [{ id: "restart", title: "Restart" }] });
      await viewer.k.attach("ticker");
      await waitFor(() => viewer.output("ticker").includes("tick"), "a tick");
      viewer.k.input("ticker", "hi\r");
      await waitFor(() => viewer.output("ticker").includes("you typed: hi"), "the echo");
      backend.kill("SIGKILL");
      await waitFor(() => backend.exitCode !== null || backend.signalCode !== null, "the backend to die");
      const before = viewer.output("ticker").length;
      await sleep(1500);
      expect(viewer.output("ticker").length).toBeGreaterThan(before);
      expect(isAliveForTest(keeperPid)).toBe(true);
    } finally {
      backend.kill("SIGKILL");
      killKeepers(stateDir);
    }
  });
});
