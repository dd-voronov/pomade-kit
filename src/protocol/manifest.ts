// App manifest (HOST-API §1): the type and its validation, shared by Pomade's install and the
// fake host.

import { CHORD_FORMAT, formatChord, parseChord } from "./shortcuts.js";
import {
  CAPABILITIES,
  SHORTCUT_ACTIONS,
  STRIP_ACTIONS,
  type AppShortcut,
  type Capability,
  type FrameTarget,
  type ShortcutAction,
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
  /** Folder patterns where the app may create and remove symlinks (`files.symlink`): workspace-
   *  relative folders whose `*` segments match any one folder name (segments `Agents`, `*`,
   *  `skills` = every agent's skills folder); absent when the manifest declares none. */
  symlinks?: string[];
  /** Load the app's launch panel (`launchPanelIcon`) hidden when Pomade starts. */
  startOnLaunch?: boolean;
  /** The app's Pomade-wide shortcuts, in manifest order; absent when the manifest declares none. */
  shortcuts?: AppShortcut[];
  /** Agent skills the app ships: folders inside the build, each holding a `SKILL.md`; absent when none. */
  skills?: AppSkill[];
}

/** One agent skill an app ships (manifest `skills[]`, HOST-API §1). */
export interface AppSkill {
  /** The skill's name — the folder's last segment; agents see the skill under it. `SKILL_NAME_RE`. */
  name: string;
  /** The folder inside the build (relative), holding `SKILL.md`. */
  path: string;
}

export const MANIFEST_FILE = "manifest.json";
export const DEFAULT_ENTRY = "index.html";
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const STRIP_ICON_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const SHORTCUT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A skill folder's name (its last path segment). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// semver.org's reference regex.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const KNOWN_KEYS = new Set([
  "id",
  "name",
  "version",
  "hostApi",
  "entry",
  "icon",
  "capabilities",
  "strip",
  "symlinks",
  "startOnLaunch",
  "shortcuts",
  "skills",
]);

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
  const symlinks = m.symlinks === undefined ? undefined : parseSymlinkScopes(m.symlinks, errors);
  if (m.startOnLaunch !== undefined) {
    if (typeof m.startOnLaunch !== "boolean") {
      fail("startOnLaunch", "must be a boolean", m.startOnLaunch);
    } else if (m.startOnLaunch && !hasPanelIconDeclared(m.strip)) {
      errors.push({ field: "startOnLaunch", message: '"startOnLaunch" needs a strip icon with action "panel" or "both"' });
    }
  }
  const shortcuts = m.shortcuts === undefined ? undefined : parseShortcuts(m.shortcuts, errors);
  const skills = m.skills === undefined ? undefined : parseSkills(m.skills, errors);

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
  if (symlinks !== undefined) manifest.symlinks = symlinks;
  if (m.startOnLaunch !== undefined) manifest.startOnLaunch = m.startOnLaunch as boolean;
  if (shortcuts !== undefined) manifest.shortcuts = shortcuts;
  if (skills !== undefined) manifest.skills = skills;
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

/** `symlinks` (HOST-API §1): workspace-relative folder patterns; a `*` segment matches any one
 *  folder name. Errors name the pattern by index. */
function parseSymlinkScopes(raw: unknown, errors: ManifestError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "symlinks", message: `"symlinks" must be an array of folder patterns ${received(raw)}` });
    return [];
  }
  const out: string[] = [];
  (raw as unknown[]).forEach((item, i) => {
    if (typeof item !== "string" || !isSymlinkScope(item)) {
      errors.push({
        field: `symlinks[${i}]`,
        message: `"symlinks[${i}]" must be a workspace-relative folder pattern ("*" = one folder name) ${received(item)}`,
      });
      return;
    }
    if (!out.includes(item)) out.push(item);
  });
  return out;
}

/** `shortcuts` (HOST-API §1): an array of shortcuts. Errors name the shortcut by index; keys a
 *  shortcut carries beyond the known ones are ignored. A repeated id or chord is reported on the
 *  later shortcut. */
function parseShortcuts(raw: unknown, errors: ManifestError[]): AppShortcut[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "shortcuts", message: `"shortcuts" must be an array of shortcuts ${received(raw)}` });
    return [];
  }
  const out: AppShortcut[] = [];
  const ids = new Set<string>();
  const chords = new Map<string, string>();
  (raw as unknown[]).forEach((item, i) => {
    const at = `shortcuts[${i}]`;
    const fail = (key: string, rule: string, value: unknown): void => {
      errors.push({ field: `${at}.${key}`, message: `"${at}.${key}" ${rule} ${received(value)}` });
    };
    if (!isObject(item)) {
      errors.push({ field: at, message: `"${at}" must be an object ${received(item)}` });
      return;
    }
    const before = errors.length;
    if (typeof item.id !== "string" || !SHORTCUT_ID_RE.test(item.id)) {
      fail("id", `must match ${SHORTCUT_ID_RE.source}`, item.id);
    } else if (ids.has(item.id)) {
      errors.push({ field: `${at}.id`, message: `"${at}.id" repeats the shortcut id ${JSON.stringify(item.id)}` });
    } else {
      ids.add(item.id);
    }
    if (typeof item.title !== "string" || item.title.trim() === "") fail("title", "must be a non-empty string", item.title);
    const chord = parseChord(item.key);
    if (!chord) {
      fail("key", `must be a key chord: ${CHORD_FORMAT}`, item.key);
    } else {
      const canonical = formatChord(chord);
      const first = chords.get(canonical);
      if (first !== undefined) {
        errors.push({ field: `${at}.key`, message: `"${at}.key" repeats ${canonical}, already used by ${first}` });
      } else {
        chords.set(canonical, at);
      }
    }
    if (typeof item.action !== "string" || !SHORTCUT_ACTIONS.includes(item.action as ShortcutAction)) {
      fail("action", `must be one of ${SHORTCUT_ACTIONS.join(", ")}`, item.action);
    }
    if (item.route !== undefined && typeof item.route !== "string") fail("route", "must be a string", item.route);
    if (errors.length > before || !chord) return;
    out.push({
      id: item.id as string,
      title: (item.title as string).trim(),
      key: formatChord(chord),
      action: item.action as ShortcutAction,
      route: (item.route as string | undefined) ?? "",
    });
  });
  return out;
}

function isSymlinkScope(p: string): boolean {
  if (!isInnerPath(p)) return false;
  return p.split("/").every((seg) => seg === "*" || !seg.includes("*"));
}

/** True when a link at `linkPath` (workspace-relative, normalized) sits directly in a folder one of
 *  the manifest's `symlinks` patterns matches; a `*` segment matches any one folder name. */
export function symlinkScopeCovers(scopes: readonly string[], linkPath: string): boolean {
  const segs = linkPath.split("/");
  if (segs.length < 2 || segs.some((s) => s === "")) return false;
  const parent = segs.slice(0, -1);
  return scopes.some((scope) => {
    const pattern = scope.split("/");
    return pattern.length === parent.length && pattern.every((seg, i) => seg === "*" || seg === parent[i]);
  });
}

/** `skills` (HOST-API §1): folder paths inside the build. Each folder's last segment is the skill's
 *  name and must be unique; errors name the entry by index. */
function parseSkills(raw: unknown, errors: ManifestError[]): AppSkill[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "skills", message: `"skills" must be an array of folder paths ${received(raw)}` });
    return [];
  }
  const out: AppSkill[] = [];
  const names = new Map<string, string>();
  (raw as unknown[]).forEach((item, i) => {
    const at = `skills[${i}]`;
    if (typeof item !== "string" || !isInnerPath(item)) {
      errors.push({ field: at, message: `"${at}" must be a relative folder path inside the build folder ${received(item)}` });
      return;
    }
    const name = item.split("/").at(-1)!;
    if (!SKILL_NAME_RE.test(name)) {
      errors.push({ field: at, message: `"${at}" must end in a skill name matching ${SKILL_NAME_RE.source} ${received(item)}` });
      return;
    }
    const first = names.get(name);
    if (first !== undefined) {
      errors.push({ field: at, message: `"${at}" repeats the skill name ${JSON.stringify(name)}, already used by ${first}` });
      return;
    }
    names.set(name, at);
    out.push({ name, path: item });
  });
  return out;
}

function isPanelIcon(icon: { action: unknown }): boolean {
  return icon.action === "panel" || icon.action === "both";
}

/** A raw `strip` declares a panel icon even when that icon has other errors (they are reported on their own). */
function hasPanelIconDeclared(raw: unknown): boolean {
  return Array.isArray(raw) && (raw as unknown[]).some((i) => isObject(i) && isPanelIcon({ action: i.action }));
}

/**
 * The strip icon whose panel Pomade loads, hidden, at launch for a `startOnLaunch` app: its first
 * icon with action `panel` or `both`. `undefined` when the app does not start on launch.
 */
export function launchPanelIcon(manifest: Pick<Manifest, "strip" | "startOnLaunch">): StripIcon | undefined {
  return manifest.startOnLaunch ? manifest.strip?.find(isPanelIcon) : undefined;
}

/** The overlay frame a shortcut opens: `surface: "overlay"` at the shortcut's route; `""` for a
 *  shortcut the manifest does not declare. */
export function resolveOverlayTarget(shortcuts: readonly AppShortcut[], shortcut?: string): FrameTarget {
  return { surface: "overlay", route: shortcuts.find((s) => s.id === shortcut)?.route ?? "" };
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
