// The fake host as the parent window of an app frame — what an app's browser e2e runs against
// instead of Pomade.

import type { FakeHost } from "./fake-host.js";

export interface MountOptions {
  /** The app page to load. */
  src: string;
  /** Where the frame goes. Default `document.body`. */
  parent?: HTMLElement;
}

export interface MountedApp {
  readonly iframe: HTMLIFrameElement;
  /** Stop answering the frame and remove it. */
  close(): void;
}

/**
 * Load an app page in an `<iframe>` and answer its messages from `host`, the way Pomade hosts an
 * app frame. A reload of the frame starts a new handshake.
 */
export function mountApp(host: FakeHost, options: MountOptions): MountedApp {
  const parent = options.parent ?? document.body;
  const win = parent.ownerDocument.defaultView;
  if (!win) throw new Error("fake host: the parent element has no window");
  const iframe = parent.ownerDocument.createElement("iframe");
  const frame = host.attach((message) => iframe.contentWindow?.postMessage(message, "*"));
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== null && event.source === iframe.contentWindow) frame.receive(event.data);
  };
  win.addEventListener("message", onMessage);
  iframe.src = options.src;
  parent.appendChild(iframe);
  return {
    iframe,
    close() {
      win.removeEventListener("message", onMessage);
      frame.detach();
      iframe.remove();
    },
  };
}
