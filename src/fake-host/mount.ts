// The fake host as the parent window of an app frame — what an app's browser e2e runs against
// instead of Pomade.

import type { FakeHost, FrameOptions } from "./fake-host.js";

/** `surface` / `icon`: what the frame is opened for (default: a tab from the new-tab menu). */
export interface MountOptions extends FrameOptions {
  /** The app page to load. */
  src: string;
  /** Where the frame goes. Default `document.body`. */
  parent?: HTMLElement;
}

export interface MountedApp {
  readonly iframe: HTMLIFrameElement;
  /** Navigate the frame's tab to `route` (`route.changed`), as Pomade does for `tabs.openApp`. */
  navigate(route: string): void;
  /** Hide or show the frame (the element too), as Pomade does when the user switches tabs or panels. */
  setHidden(hidden: boolean): void;
  /** Stop answering the frame and remove it. */
  close(): void;
}

/**
 * Load an app page in an `<iframe>` and answer its messages from `host`, the way Pomade hosts an
 * app frame. A reload of the frame starts a new handshake. An overlay frame
 * (`surface: "overlay"`) is removed when it asks to close (`overlay.close`, Escape).
 */
export function mountApp(host: FakeHost, options: MountOptions): MountedApp {
  const parent = options.parent ?? document.body;
  const win = parent.ownerDocument.defaultView;
  if (!win) throw new Error("fake host: the parent element has no window");
  const iframe = parent.ownerDocument.createElement("iframe");
  const frame = host.attach((message) => iframe.contentWindow?.postMessage(message, "*"), {
    ...options,
    // An overlay that asks to close is removed, as Pomade removes it.
    onClose: () => {
      mounted.close();
      options.onClose?.();
    },
  });
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== null && event.source === iframe.contentWindow) frame.receive(event.data);
  };
  win.addEventListener("message", onMessage);
  iframe.src = options.src;
  iframe.hidden = options.hidden === true;
  parent.appendChild(iframe);
  const mounted: MountedApp = {
    iframe,
    navigate: (route) => frame.navigate(route),
    setHidden(hidden) {
      iframe.hidden = hidden;
      frame.setHidden(hidden);
    },
    close() {
      win.removeEventListener("message", onMessage);
      frame.detach();
      iframe.remove();
    },
  };
  return mounted;
}
