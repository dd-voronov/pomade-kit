// Key forwarding (HOST-API §3 "Keys"): every keydown that carries Cmd or Ctrl and that the app
// did not handle goes to the host, so Pomade's shortcuts keep working while the app has focus.
// A modifier key pressed alone is not a shortcut and is not forwarded.

import { CHANNEL, type KeyMessage } from "../protocol/index.js";

export type KeySource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Meta", "Control", "Alt", "Shift"]);

export function shouldForwardKey(e: KeyLike): boolean {
  return !e.defaultPrevented && (e.metaKey || e.ctrlKey) && !MODIFIER_KEYS.has(e.key);
}

export function toKeyMessage(e: KeyLike): KeyMessage {
  return {
    channel: CHANNEL,
    type: "key",
    key: e.key,
    code: e.code,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  };
}

/**
 * Listen for keydowns on `source` and forward the unhandled Cmd/Ctrl ones. The decision waits
 * one task, so a handler registered after this one (even on the same target) can still claim
 * the key with `preventDefault()`. Returns a function that stops forwarding.
 */
export function installKeyForwarder(source: KeySource, send: (message: KeyMessage) => void): () => void {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const onKeyDown = (event: Event): void => {
    const e = event as unknown as KeyLike;
    if (!e.metaKey && !e.ctrlKey) return;
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (shouldForwardKey(e)) send(toKeyMessage(e));
    }, 0);
    pending.add(timer);
  };
  source.addEventListener("keydown", onKeyDown);
  return () => {
    source.removeEventListener("keydown", onKeyDown);
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
  };
}
