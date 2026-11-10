// pomade-kit/keeper — the keeper: a process that holds an app's terminal sessions so they outlive
// Pomade, and serves the attach protocol (`pomade-kit/protocol`) to Pomade's attached tabs and to
// the app itself. Needs node-pty (a peer dependency). The app's backend starts it as its own
// process with `startKeeper` (`pomade-kit/node`); the keeper's entry calls `runKeeper`.

export { HANDOFF_ENV, runKeeper, type Keeper, type KeeperOptions } from "./keeper.js";
export { sessionEnv, loginShell } from "./env.js";
