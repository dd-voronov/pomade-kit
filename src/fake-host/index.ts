// pomade-kit/fake-host — the Host API in memory, for standalone development and app tests.

export {
  createFakeHost,
  DEFAULT_IGNORE,
  FakeHost,
  WORKSPACE_SCOPE,
  type FakeBadge,
  type FakeHostOptions,
  type FrameOptions,
  type FakeProject,
  type FrameConnection,
} from "./fake-host.js";
export type { FakeGroup, FakeOpenedTab, FakePickRequest } from "./data.js";
export { mountApp, type MountedApp, type MountOptions } from "./mount.js";
