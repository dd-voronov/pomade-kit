// An app's own side panel (Host API §4 `panel`): the rules for `panel.show`'s params and which strip
// icon's panel it shows. Pure; Pomade and the fake host both serve the call with these.

import type { ShowPanelParams, StripIcon } from "./types.js";

/** Check `panel.show` params: the params with unknown keys dropped, or why they are `invalid-params`.
 *  Omitted params are `{}`. */
export function checkShowPanelParams(params: unknown): { ok: true; value: ShowPanelParams } | { ok: false; message: string } {
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, message: "params must be an object" };
  const o = p as Record<string, unknown>;
  if (o.icon !== undefined && typeof o.icon !== "string") return { ok: false, message: '"icon" must be a strip icon id' };
  if (o.route !== undefined && typeof o.route !== "string") return { ok: false, message: '"route" must be a string' };
  return {
    ok: true,
    value: {
      ...(o.icon !== undefined ? { icon: o.icon as string } : {}),
      ...(o.route !== undefined ? { route: o.route as string } : {}),
    },
  };
}

/** The strip icon whose panel `panel.show` shows: `icon` when it names one of the app's icons with action
 *  `panel` or `both`, else (no `icon`) the first such icon. `undefined` → the call is `not-found`. */
export function panelShowIcon(strip: readonly StripIcon[] | undefined, icon?: string): StripIcon | undefined {
  const panels = (strip ?? []).filter((s) => s.action === "panel" || s.action === "both");
  return icon === undefined ? panels[0] : panels.find((s) => s.id === icon);
}

/** Why `panel.show` finds no panel: the message of its `not-found`. */
export function panelShowNotFound(icon?: string): string {
  return icon === undefined
    ? "The app has no strip icon with a panel (action \"panel\" or \"both\")"
    : `No strip icon ${JSON.stringify(icon)} with a panel (action "panel" or "both") in the manifest`;
}
