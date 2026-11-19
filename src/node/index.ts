// pomade-kit/node — what an app's backend and commands use under Node: the Host API over Pomade's
// local socket, reconnecting, and finding the workspace with Pomade closed.

export { pomadeUserData, postNotice, queueNotice, type PomadeTarget, type PostNoticeOptions, type PostNoticeResult } from "./notices.js";
export { appStateDir, pomadeHome, readHostRecord, resolveWorkspace, type Env } from "./home.js";
export {
  connectSocket,
  socketTransport,
  stayConnected,
  type SocketConnectOptions,
  type SocketConnectResult,
  type StayConnectedHandlers,
  type StayConnectedOptions,
} from "./socket.js";
export { launchPomade, type LaunchOptions, type LaunchResult } from "./launch.js";
export {
  KeeperError,
  connectKeeper,
  followSession,
  startKeeper,
  type FollowHandlers,
  type FollowOptions,
  type FollowState,
  type Follower,
  type KeeperClient,
  type KeeperConnectOptions,
  type KeeperConnectResult,
  type StartKeeperOptions,
  type StartKeeperResult,
} from "./keeper.js";
