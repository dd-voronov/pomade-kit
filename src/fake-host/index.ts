// pomade-kit/fake-host — the Host API in memory, for standalone development and app tests.

export {
  createFakeHost,
  DEFAULT_IGNORE,
  FakeHost,
  WORKSPACE_SCOPE,
  type FakeAppTab,
  type FakeAppTabChange,
  type FakeBadge,
  type FakeOpenedOverlay,
  type FakePublishedEvent,
  type FakeHostOptions,
  type FrameOptions,
  type FakeProject,
  type FrameConnection,
  type FakeApi,
  type CallApiOptions,
} from "./fake-host.js";
export type { FakeGroup, FakeOpenedTab, FakePickRequest, FakeReveal, FakeWriteFailure } from "./data.js";
export { DEFAULT_FAKE_ROSTER, type FakeAgentTabSeed, type FakeOpenedAgentTab, type FakeSession } from "./agent-tabs.js";
export { mountApp, type MountedApp, type MountOptions } from "./mount.js";
