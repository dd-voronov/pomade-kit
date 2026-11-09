// Test doubles shared by the SDK specs (not exported from the package).

import type { AppToHostMessage, ProjectRef } from "../protocol/index.js";
import type { Transport } from "./transport.js";

export interface MockTransport {
  transport: Transport;
  sent: AppToHostMessage[];
  /** Deliver a host → app message to every listener. */
  deliver(data: unknown): void;
  listenerCount(): number;
}

export function mockTransport(): MockTransport {
  const sent: AppToHostMessage[] = [];
  const listeners = new Set<(data: unknown) => void>();
  return {
    sent,
    transport: {
      send: (message) => sent.push(message),
      listen(onMessage) {
        listeners.add(onMessage);
        return () => listeners.delete(onMessage);
      },
    },
    deliver(data) {
      for (const listener of [...listeners]) listener(data);
    },
    listenerCount: () => listeners.size,
  };
}

export const PROJECT: ProjectRef = { id: "p1", kind: "project", name: "Pomade", root: "Projects/Pomade" };

export const WELCOME = {
  channel: "pomade",
  type: "welcome",
  hostApi: 0,
  pomadeVersion: "0.3.0",
  appId: "hello",
  surface: "tab",
  project: PROJECT,
} as const;

/** A keydown event as the forwarder reads it. */
export class FakeKeyEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;

  constructor(init: { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) {
    super("keydown", { cancelable: true });
    this.key = init.key;
    this.code = init.code;
    this.metaKey = init.metaKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}
