// pomade-kit/sdk — what an app uses to talk to Pomade: `connect()` and the typed client.

export { connect, type ConnectOptions, type ConnectResult } from "./connect.js";
export { HostError, type FileWatch, type HostClient, type Welcome } from "./client.js";
export { postMessageTransport, type MessageWindow, type Transport } from "./transport.js";
export { installKeyForwarder, shouldForwardKey, toKeyMessage, type KeyLike, type KeySource } from "./keys.js";
export type {
  FileChange,
  FileEntry,
  HostInfo,
  ProjectRef,
  ReadFolderParams,
  WatchParams,
  ErrorCode,
  RejectReason,
} from "../protocol/index.js";
