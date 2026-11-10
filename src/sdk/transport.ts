// How the client reaches its host. The same client code runs over the parent window's
// postMessage (inside Pomade, or a fake-host harness page), over the local socket (a backend or a
// command, `pomade-kit/node`) and over an in-memory channel (the fake host in-process).

import type { AppToHostMessage } from "../protocol/index.js";

export interface Transport {
  /** Send one message to the host. */
  send(message: AppToHostMessage): void;
  /** Receive everything the host sends (unparsed); returns an unsubscribe function. */
  listen(onMessage: (data: unknown) => void): () => void;
  /** A channel that can end on its own (the socket): `onEnd` runs once when it does. */
  onEnd?(onEnd: () => void): () => void;
}

/** The parts of `window` the postMessage transport uses. */
export interface MessageWindow extends Pick<EventTarget, "addEventListener" | "removeEventListener"> {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
}

/**
 * Talk to the parent window. Only messages whose `source` is that parent are received; the
 * target origin is "*" because an app does not know its host's origin (Pomade identifies the
 * app by its frame, never by a message field).
 */
export function postMessageTransport(win: MessageWindow): Transport {
  return {
    send(message) {
      win.parent.postMessage(message, "*");
    },
    listen(onMessage) {
      const handler = (event: Event): void => {
        const e = event as MessageEvent;
        if (e.source === win.parent) onMessage(e.data);
      };
      win.addEventListener("message", handler);
      return () => win.removeEventListener("message", handler);
    },
  };
}
