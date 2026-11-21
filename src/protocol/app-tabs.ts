// An app's own tabs (Host API §4 "Own tab"): the rules for `tabs.openApp`'s params, keyed tabs and
// `tabs.setTitle`, `tabs.setRoute`. Pure; Pomade and the fake host both check calls with these.

import type { AppTabKind, OpenAppParams } from "./types.js";

/** A keyed tab's key: one per (app, key, project). */
export const APP_TAB_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** An app tab kind's id (manifest `tabKinds`). */
export const TAB_KIND_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Why `title` is not a valid tab title (a string that is not blank), or null when it is. */
export function checkTabTitle(title: unknown): string | null {
  return typeof title === "string" && title.trim() !== "" ? null : '"title" must be a non-empty string';
}

/** Why `route` is not a valid `tabs.setRoute` route (a string; "" is the app's default view), or null when it is. */
export function checkTabRoute(route: unknown): string | null {
  return typeof route === "string" ? null : '"route" must be a string';
}

/** `tabs.openApp` params as the host serves them: `route` defaulted to `""`, `title` trimmed. */
export interface CheckedOpenAppParams extends OpenAppParams {
  route: string;
}

/**
 * Check `tabs.openApp` params against the calling app's manifest `tabKinds`: the normalized params,
 * or why they are `invalid-params`. `title` and `kind` need `key`; `kind` must be declared. Omitted
 * params are `{}`; unknown keys are dropped.
 */
export function checkOpenAppParams(
  params: unknown,
  tabKinds: Readonly<Record<string, AppTabKind>> | undefined,
): { ok: true; value: CheckedOpenAppParams } | { ok: false; message: string } {
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, message: "params must be an object" };
  const o = p as Record<string, unknown>;
  if (o.route !== undefined && typeof o.route !== "string") return { ok: false, message: '"route" must be a string' };
  if (o.projectId !== undefined && typeof o.projectId !== "string") return { ok: false, message: '"projectId" must be a project id' };
  if (o.key !== undefined && (typeof o.key !== "string" || !APP_TAB_KEY_RE.test(o.key))) {
    return { ok: false, message: `"key" must match ${APP_TAB_KEY_RE.source}` };
  }
  if (o.title !== undefined) {
    const bad = checkTabTitle(o.title);
    if (bad) return { ok: false, message: bad };
    if (o.key === undefined) return { ok: false, message: '"title" needs "key": only a keyed tab takes an app title' };
  }
  if (o.kind !== undefined) {
    if (typeof o.kind !== "string") return { ok: false, message: '"kind" must be a tab kind id' };
    if (o.key === undefined) return { ok: false, message: '"kind" needs "key": only a keyed tab has a kind' };
    if (!tabKinds || !Object.hasOwn(tabKinds, o.kind)) {
      return { ok: false, message: `No tab kind ${JSON.stringify(o.kind)} in the manifest's "tabKinds"` };
    }
  }
  return {
    ok: true,
    value: {
      route: (o.route as string | undefined) ?? "",
      ...(o.projectId !== undefined ? { projectId: o.projectId as string } : {}),
      ...(o.key !== undefined ? { key: o.key as string } : {}),
      ...(o.title !== undefined ? { title: (o.title as string).trim() } : {}),
      ...(o.kind !== undefined ? { kind: o.kind as string } : {}),
    },
  };
}
