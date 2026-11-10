// App manifest (HOST-API §1): the type and its validation, shared by Pomade's install and the
// fake host.

import {
  CAPABILITIES,
  STRIP_ACTIONS,
  type Capability,
  type FrameTarget,
  type StripAction,
  type StripIcon,
  type Surface,
} from "./types.js";

export interface Manifest {
  /** ^[a-z][a-z0-9-]{1,63}$ — also the pomade-app:// host. */
  id: string;
  /** Shown in Pomade's UI. */
  name: string;
  /** Semver. */
  version: string;
  /** The Host API version the app speaks. */
  hostApi: number;
  /** Path inside the build folder; default "index.html". */
  entry?: string;
  /** Path inside the build folder. */
  icon?: string;
  /** Method groups the app may call. */
  capabilities: Capability[];
  /** The app's left-strip icons, in manifest order; absent when the manifest declares none. */
  strip?: StripIcon[];
}

export const MANIFEST_FILE = "manifest.json";
export const DEFAULT_ENTRY = "index.html";
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const STRIP_ICON_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// semver.org's reference regex.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const KNOWN_KEYS = new Set(["id", "name", "version", "hostApi", "entry", "icon", "capabilities", "strip"]);

/** One invalid field. */
export interface ManifestError {
  /** The field's path: `"id"`, `"strip"`, `"strip[1].action"`; `""` when the manifest is not an object. */
  field: string;
  /** Readable: names the field and the value received (`(got 3)`, `(missing)`). */
  message: string;
}

export type ManifestParseResult =
  | {
      ok: true;
      manifest: Manifest;
      /** Top-level keys this Host API version does not know — listed as "not supported yet". */
      unsupportedKeys: string[];
    }
  | {
      ok: false;
      /** Every invalid field, in manifest-key order (`strip` icons by index). */
      errors: ManifestError[];
      /** `errors[0].field`. */
      field: string;
      /** `errors[0].message`. */
      message: string;
    };

/** How a received value reads in an error message. */
function received(v: unknown): string {
  return v === undefined ? "(missing)" : `(got ${JSON.stringify(v)})`;
}

/** A relative path that stays inside the build folder. */
function isInnerPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed `manifest.json`, reporting every invalid field. */
export function parseManifest(value: unknown): ManifestParseResult {
  if (!isObject(value)) {
    const errors = [{ field: "", message: "manifest must be a JSON object" }];
    return { ok: false, errors, ...errors[0]! };
  }
  const m = value;
  const errors: ManifestError[] = [];
  const fail = (field: string, rule: string, value: unknown): void => {
    errors.push({ field, message: `"${field}" ${rule} ${received(value)}` });
  };

  if (typeof m.id !== "string" || !APP_ID_RE.test(m.id)) fail("id", `must match ${APP_ID_RE.source}`, m.id);
  if (typeof m.name !== "string" || m.name.trim() === "") fail("name", "must be a non-empty string", m.name);
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) fail("version", "must be a semver string", m.version);
  if (typeof m.hostApi !== "number" || !Number.isInteger(m.hostApi) || m.hostApi < 0) {
    fail("hostApi", "must be a non-negative integer", m.hostApi);
  }
  if (m.entry !== undefined && (typeof m.entry !== "string" || !isInnerPath(m.entry))) {
    fail("entry", "must be a relative path inside the build folder", m.entry);
  }
  if (m.icon !== undefined && (typeof m.icon !== "string" || !isInnerPath(m.icon))) {
    fail("icon", "must be a relative path inside the build folder", m.icon);
  }
  if (!Array.isArray(m.capabilities)) {
    fail("capabilities", "must be an array", m.capabilities);
  } else {
    const unknown = (m.capabilities as unknown[]).find(
      (c) => typeof c !== "string" || !(CAPABILITIES as readonly string[]).includes(c),
    );
    if (unknown !== undefined) {
      errors.push({
        field: "capabilities",
        message: `"capabilities" has unknown capability ${JSON.stringify(unknown)}; known: ${CAPABILITIES.join(", ")}`,
      });
    }
  }
  const strip = m.strip === undefined ? undefined : parseStrip(m.strip, errors);

  if (errors.length > 0) return { ok: false, errors, ...errors[0]! };

  const manifest: Manifest = {
    id: m.id as string,
    name: m.name as string,
    version: m.version as string,
    hostApi: m.hostApi as number,
    capabilities: [...(m.capabilities as Capability[])],
  };
  if (m.entry !== undefined) manifest.entry = m.entry as string;
  if (m.icon !== undefined) manifest.icon = m.icon as string;
  if (strip !== undefined) manifest.strip = strip;
  const unsupportedKeys = Object.keys(m).filter((k) => !KNOWN_KEYS.has(k));
  return { ok: true, manifest, unsupportedKeys };
}

/** `strip` (HOST-API §1): an array of icons. Errors name the icon by index; keys an icon carries
 *  beyond the known ones are ignored. A repeated id is reported on the later icon. */
function parseStrip(raw: unknown, errors: ManifestError[]): StripIcon[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "strip", message: `"strip" must be an array of icons ${received(raw)}` });
    return [];
  }
  const out: StripIcon[] = [];
  const seen = new Set<string>();
  (raw as unknown[]).forEach((item, i) => {
    const at = `strip[${i}]`;
    const fail = (key: string, rule: string, value: unknown): void => {
      errors.push({ field: `${at}.${key}`, message: `"${at}.${key}" ${rule} ${received(value)}` });
    };
    if (!isObject(item)) {
      errors.push({ field: at, message: `"${at}" must be an object ${received(item)}` });
      return;
    }
    const before = errors.length;
    if (typeof item.id !== "string" || !STRIP_ICON_ID_RE.test(item.id)) {
      fail("id", `must match ${STRIP_ICON_ID_RE.source}`, item.id);
    } else if (seen.has(item.id)) {
      errors.push({ field: `${at}.id`, message: `"${at}.id" repeats the icon id ${JSON.stringify(item.id)}` });
    } else {
      seen.add(item.id);
    }
    if (typeof item.title !== "string" || item.title.trim() === "") fail("title", "must be a non-empty string", item.title);
    if (item.icon !== undefined && (typeof item.icon !== "string" || !isInnerPath(item.icon))) {
      fail("icon", "must be a relative path inside the build folder", item.icon);
    }
    if (typeof item.action !== "string" || !STRIP_ACTIONS.includes(item.action as StripAction)) {
      fail("action", `must be one of ${STRIP_ACTIONS.join(", ")}`, item.action);
    }
    if (item.route !== undefined && typeof item.route !== "string") fail("route", "must be a string", item.route);
    if (item.panelRoute !== undefined) {
      if (typeof item.panelRoute !== "string") {
        fail("panelRoute", "must be a string", item.panelRoute);
      } else if (item.action !== "both") {
        errors.push({ field: `${at}.panelRoute`, message: `"${at}.panelRoute" is only for action "both"` });
      }
    }
    if (errors.length > before) return;
    const icon: StripIcon = {
      id: item.id as string,
      title: (item.title as string).trim(),
      action: item.action as StripAction,
      route: (item.route as string | undefined) ?? "",
    };
    if (item.icon !== undefined) icon.icon = item.icon as string;
    if (item.panelRoute !== undefined) icon.panelRoute = item.panelRoute as string;
    out.push(icon);
  });
  return out;
}

/**
 * What a frame opened for `icon` on `surface` renders (HOST-API §3 `welcome`): a tab takes the
 * icon's `route`, a panel its `panelRoute` (falling back to `route`). An icon the strip does not
 * declare — or none, for a tab from the new-tab menu — is the app's default view: no icon, `""`.
 */
export function resolveFrameTarget(strip: readonly StripIcon[], surface: Surface, icon?: string): FrameTarget {
  const s = icon === undefined ? undefined : strip.find((x) => x.id === icon);
  if (!s) return { surface, route: "" };
  return { surface, icon: s.id, route: surface === "panel" ? (s.panelRoute ?? s.route) : s.route };
}
