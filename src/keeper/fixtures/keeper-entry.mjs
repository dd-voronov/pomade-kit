// A keeper process for the tests: the built library, configured from the environment the test
// (or the previous keeper, on an update) starts it with.
import { runKeeper } from "../../../dist/keeper/index.js";

await runKeeper({
  stateDir: process.env.KEEPER_TEST_STATE,
  ownerKey: process.env.KEEPER_TEST_KEY ?? null,
  version: process.argv[2] ?? process.env.KEEPER_TEST_VERSION ?? "test",
  ...(process.env.KEEPER_TEST_RING ? { ringChars: Number(process.env.KEEPER_TEST_RING) } : {}),
});
