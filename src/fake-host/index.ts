// pomade-kit/fake-host — the Host API in memory, for standalone development and app tests.

export {
  createFakeHost,
  DEFAULT_IGNORE,
  FakeHost,
  WORKSPACE_SCOPE,
  type FakeHostOptions,
  type FakeProject,
  type FrameConnection,
} from "./fake-host.js";
export { mountApp, type MountedApp, type MountOptions } from "./mount.js";
