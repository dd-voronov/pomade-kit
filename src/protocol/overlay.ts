// The overlay's sizing and parameter rules (Host API §4 `overlay`, §5 "Overlay"): the frame is
// 420 wide and 220 high until the app asks for a height. Pure; the host and the fake host both
// check `overlay.open` / `overlay.resize` params with these.

import { OVERLAY_ANCHORS } from "./types.js";

/** The overlay frame's width in px; an app cannot change it. */
export const OVERLAY_WIDTH = 420;

/** The overlay frame's height in px until the app asks for another. */
export const OVERLAY_DEFAULT_HEIGHT = 220;

/** Why `height` is not a valid overlay height (a positive, finite number), or null when it is. */
export function checkOverlayHeight(height: unknown): string | null {
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return '"height" must be a positive number';
  return null;
}

/** Why `anchor` is not a valid overlay anchor, or null when it is. */
export function checkOverlayAnchor(anchor: unknown): string | null {
  if (typeof anchor !== "string" || !(OVERLAY_ANCHORS as readonly string[]).includes(anchor)) {
    return `"anchor" must be one of ${OVERLAY_ANCHORS.join(", ")}`;
  }
  return null;
}
