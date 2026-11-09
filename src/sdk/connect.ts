// The handshake (HOST-API §3): send `hello` until the host answers; `welcome` gives a client,
// `reject` a typed refusal, silence for 1500 ms means the app runs standalone.

import {
  CHANNEL,
  HANDSHAKE_TIMEOUT_MS,
  HOST_API_VERSION,
  parseHostMessage,
  type RejectReason,
} from "../protocol/index.js";
import { createClient, type HostClient } from "./client.js";
import { installKeyForwarder, type KeySource } from "./keys.js";
import { postMessageTransport, type MessageWindow, type Transport } from "./transport.js";

export interface ConnectOptions {
  /** Default: the parent window's postMessage; with no `window` (Node) there is no host. */
  transport?: Transport;
  /** How long to wait for an answer before "no host". Default 1500 ms. */
  timeoutMs?: number;
  /** How often `hello` is resent while waiting. Default 250 ms. */
  helloIntervalMs?: number;
  /** Where unhandled Cmd/Ctrl keydowns are read for forwarding. Default `window`; `null` turns forwarding off. */
  keySource?: KeySource | null;
}

export type ConnectResult =
  | { status: "connected"; host: HostClient }
  /** Opened outside Pomade: show the "no Pomade host" state. */
  | { status: "no-host" }
  /** `needs-newer-pomade`: this Pomade is too old for the app; `app-too-old`: the app needs an update. */
  | { status: "rejected"; reason: RejectReason; hostApi: number };

const DEFAULT_HELLO_INTERVAL_MS = 250;

function browserWindow(): (MessageWindow & KeySource) | null {
  return typeof window === "undefined" ? null : window;
}

/** Perform the handshake. Never throws: every outcome is a `ConnectResult`. */
export function connect(options: ConnectOptions = {}): Promise<ConnectResult> {
  const win = browserWindow();
  const transport = options.transport ?? (win ? postMessageTransport(win) : null);
  if (!transport) return Promise.resolve({ status: "no-host" });
  const keySource = options.keySource === undefined ? win : options.keySource;

  return new Promise((resolve) => {
    let settled = false;
    const sendHello = (): void => transport.send({ channel: CHANNEL, type: "hello", hostApi: HOST_API_VERSION });

    const settle = (result: ConnectResult): void => {
      settled = true;
      clearInterval(resend);
      clearTimeout(deadline);
      unlisten();
      resolve(result);
    };

    const unlisten = transport.listen((data) => {
      if (settled) return;
      const msg = parseHostMessage(data);
      if (msg?.type === "reject") {
        settle({ status: "rejected", reason: msg.reason, hostApi: msg.hostApi });
      } else if (msg?.type === "welcome") {
        const { hostApi, pomadeVersion, appId, surface, project } = msg;
        const stopKeys = keySource ? installKeyForwarder(keySource, (m) => transport.send(m)) : undefined;
        const host = createClient(transport, { hostApi, pomadeVersion, appId, surface, project }, stopKeys);
        settle({ status: "connected", host });
      }
    });

    const resend = setInterval(sendHello, options.helloIntervalMs ?? DEFAULT_HELLO_INTERVAL_MS);
    const deadline = setTimeout(() => settle({ status: "no-host" }), options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    sendHello();
  });
}
