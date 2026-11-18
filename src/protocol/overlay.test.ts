import { describe, expect, it } from "vitest";

import { checkOverlayAnchor, checkOverlayHeight, OVERLAY_DEFAULT_HEIGHT, OVERLAY_WIDTH } from "./overlay.js";

describe("overlay rules", () => {
  it("the frame is 420 wide and 220 high by default", () => {
    expect([OVERLAY_WIDTH, OVERLAY_DEFAULT_HEIGHT]).toEqual([420, 220]);
  });

  it("a height is a positive finite number", () => {
    for (const ok of [1, 220, 260.5, 10_000]) expect(checkOverlayHeight(ok)).toBeNull();
    for (const bad of [0, -1, Number.NaN, Infinity, "220", null, undefined, {}]) {
      expect(checkOverlayHeight(bad)).toBe('"height" must be a positive number');
    }
  });

  it("an anchor is center or panel", () => {
    expect(checkOverlayAnchor("center")).toBeNull();
    expect(checkOverlayAnchor("panel")).toBeNull();
    for (const bad of ["left", "", 1, null, undefined]) expect(checkOverlayAnchor(bad)).toBe('"anchor" must be one of center, panel');
  });
});
