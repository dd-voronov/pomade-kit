// What the frame relay's shell page (`relay-shell.ts`, a browser window) and its server
// (`node/relay.ts`, beside the fake host in Node) say to each other. The server streams to the page
// (server-sent events, one JSON message per event, in order); the page posts its messages to the
// server in order, batched (`POST /send?session=<id>`, a JSON array).

import type { StripIcon } from "../protocol/index.js";
import type { FakeAppTabChange, FakeOpenedOverlay, FrameOptions } from "./fake-host.js";

/** A frame of the page, named by the page: unique within its session. */
export type RelayFrameId = string;

/** What a frame is opened for: `FrameOptions` without the callbacks, which travel as messages. */
export type RelayFrameOptions = Omit<FrameOptions, "onClose" | "onOverlayOpen" | "onOverlayResize">;

export type ShellToRelay =
  /** The page created a frame: attach it to the fake host before its page loads. */
  | { type: "attach"; frame: RelayFrameId; options: RelayFrameOptions }
  /** A message the frame posted to its parent window. */
  | { type: "receive"; frame: RelayFrameId; data: unknown }
  /** `FrameConnection.navigate`. */
  | { type: "navigate"; frame: RelayFrameId; route: string }
  /** `FrameConnection.setHidden`. */
  | { type: "hidden"; frame: RelayFrameId; hidden: boolean }
  /** The frame is gone. */
  | { type: "detach"; frame: RelayFrameId }
  /** The user opens the app's tab: a strip icon that opens one, or the new-tab menu (no icon). */
  | { type: "openAppTab"; icon?: string }
  /** The user closes one of the app's tabs. */
  | { type: "closeAppTab"; tabId: string };

/** The app as the page shows it. */
export interface RelayApp {
  id: string;
  name: string;
  /** The app's icon, relative to its page. */
  icon: string | null;
  strip: StripIcon[];
  /** The app's page: every frame loads it. */
  url: string;
}

export type RelayToShell =
  /** First on a stream: the page's session and the app it hosts. The app's open tabs follow as `open` changes. */
  | { type: "ready"; session: string; app: RelayApp }
  /** A message for the frame, to deliver with postMessage. */
  | { type: "post"; frame: RelayFrameId; message: unknown }
  /** `FrameOptions.onClose`. */
  | { type: "close"; frame: RelayFrameId }
  /** `FrameOptions.onOverlayOpen`. */
  | { type: "overlayOpen"; frame: RelayFrameId; overlay: FakeOpenedOverlay }
  /** `FrameOptions.onOverlayResize`. */
  | { type: "overlayResize"; frame: RelayFrameId; height: number }
  /** One of the app's own tabs changed (`fake.onAppTab`). */
  | { type: "appTab"; change: FakeAppTabChange };
