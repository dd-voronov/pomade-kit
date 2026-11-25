import { describe, expect, it } from "vitest";

import { checkShowPanelParams, panelShowIcon, panelShowNotFound } from "./panel.js";
import { FRAME_ONLY_METHODS } from "./socket.js";
import type { StripIcon } from "./types.js";

const today: StripIcon = { id: "today", title: "Today", action: "tab", route: "today" };
const notes: StripIcon = { id: "notes", title: "Notes", action: "panel", route: "" };
const board: StripIcon = { id: "board", title: "Board", action: "both", route: "board", panelRoute: "needs-you" };
const strip = [today, notes, board];

describe("panel.show params", () => {
  it("icon and route are optional strings; omitted params are {}; unknown keys are dropped", () => {
    expect(checkShowPanelParams(undefined)).toEqual({ ok: true, value: {} });
    expect(checkShowPanelParams({})).toEqual({ ok: true, value: {} });
    expect(checkShowPanelParams({ icon: "board", route: "", x: 1 })).toEqual({ ok: true, value: { icon: "board", route: "" } });
    expect(checkShowPanelParams({ route: "note/7" })).toEqual({ ok: true, value: { route: "note/7" } });
  });

  it("a non-string icon or route, or params that are not an object, are refused", () => {
    expect(checkShowPanelParams({ icon: 1 })).toEqual({ ok: false, message: '"icon" must be a strip icon id' });
    expect(checkShowPanelParams({ route: 7 })).toEqual({ ok: false, message: '"route" must be a string' });
    expect(checkShowPanelParams({ route: null })).toEqual({ ok: false, message: '"route" must be a string' });
    expect(checkShowPanelParams("notes")).toEqual({ ok: false, message: "params must be an object" });
    expect(checkShowPanelParams([])).toEqual({ ok: false, message: "params must be an object" });
  });

  it("is frame-only", () => {
    expect(FRAME_ONLY_METHODS).toContain("panel.show");
  });
});

describe("panelShowIcon", () => {
  it("defaults to the first icon with a panel (action panel or both)", () => {
    expect(panelShowIcon(strip)?.id).toBe("notes");
    expect(panelShowIcon([today, board])?.id).toBe("board");
  });

  it("names an icon with a panel; a tab-only or unknown icon is none", () => {
    expect(panelShowIcon(strip, "board")?.id).toBe("board");
    expect(panelShowIcon(strip, "notes")?.id).toBe("notes");
    expect(panelShowIcon(strip, "today")).toBeUndefined();
    expect(panelShowIcon(strip, "nope")).toBeUndefined();
  });

  it("an app without a panel icon has none", () => {
    expect(panelShowIcon([today])).toBeUndefined();
    expect(panelShowIcon(undefined)).toBeUndefined();
    expect(panelShowIcon([])).toBeUndefined();
  });

  it("the not-found message names the icon, or says the app has no panel", () => {
    expect(panelShowNotFound("today")).toContain('"today"');
    expect(panelShowNotFound()).toContain("no strip icon with a panel");
  });
});
