// App manifest (HOST-API §1): the type and its validation, shared by Pomade's install and the
// fake host.

import { CHORD_FORMAT, formatChord, parseChord } from "./shortcuts.js";
import { parseManifestEvents, type ManifestEvents } from "./events.js";
import { PLATFORM_CLIENT_ID } from "./socket.js";
import { API_METHOD_MAX_LENGTH, API_METHOD_RE } from "./broker.js";
import { TAB_KIND_ID_RE } from "./app-tabs.js";
import {
  CAPABILITIES,
  SHORTCUT_ACTIONS,
  STRIP_ACTIONS,
  type AppShortcut,
  type AppTabKind,
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
  /** The app's tab kinds (`tabs.openApp` `kind`), by id; absent when the manifest declares none. */
  tabKinds?: Record<string, AppTabKind>;
  /** Folder patterns where the app may create and remove symlinks (`files.symlink`): workspace-
   *  relative folders whose `*` segments match any one folder name (segments `Projects`, `*`,
   *  `links` = the `links` folder of every folder in `Projects`); absent when the manifest declares none. */
  symlinks?: string[];
  /** Load the app's launch panel (`launchPanelIcon`) hidden when Pomade starts. */
  startOnLaunch?: boolean;
  /** The app's Pomade-wide shortcuts, in manifest order; absent when the manifest declares none. */
  shortcuts?: AppShortcut[];
  /** Agent skills the app ships: folders inside the build, each holding a `SKILL.md`; absent when none. */
  skills?: AppSkill[];
  /** The events the app publishes and subscribes to (pomade:E-031); absent when the manifest declares none. */
  events?: ManifestEvents;
  /** The app's background process (pomade:E-028); absent when it has none. */
  backend?: AppBackend;
  /** The methods the app offers other apps through Pomade's broker (pomade:E-028); absent when none. */
  api?: string[];
  /** The apps whose APIs it calls (pomade:E-028, PLATFORM rule 4); absent when none. */
  calls?: string[];
  /** Command-line entries Pomade puts on PATH (pomade:E-028); absent when none. */
  commands?: AppCommand[];
  /** The paths outside the workspace the app reads or writes, as written (`~/.claude/`,
   *  `/etc/hosts`): Pomade shows them at install. For people, not a sandbox; absent when none. */
  outsideWorkspace?: string[];
}

/** One command an app ships (manifest `commands[]`, HOST-API §1). */
export interface AppCommand {
  /** What the user types: the app id, or `<app id>-<word>` (`COMMAND_NAME_RE`). */
  name: string;
  /** The Node entry inside the build (`.js`, `.mjs` or `.cjs`). */
  entry: string;
  /** What it does, for people (install summary); "" when not given. */
  title: string;
}

export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Pomade's own commands: no app may ship one with these names. */
export const RESERVED_COMMANDS: readonly string[] = ["pomade", "pomade-git"];

/** When an app's backend runs (HOST-API §1 `backend`): while Pomade runs, or always — a login
 *  item that survives Pomade quitting. */
export type BackendMode = "with-pomade" | "always-on";

export const BACKEND_MODES: readonly BackendMode[] = ["with-pomade", "always-on"];

/** An app's backend (manifest `backend`, HOST-API §1). */
export interface AppBackend {
  /** The Node entry inside the build (`.js`, `.mjs` or `.cjs`). */
  entry: string;
  mode: BackendMode;
  /** `always-on` only: an app update restarts the running backend (default: it keeps running). */
  restartOnUpdate: boolean;
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
  "tabKinds",
  "symlinks",
  "startOnLaunch",
  "shortcuts",
  "skills",
  "events",
  "backend",
  "api",
  "calls",
  "commands",
  "outsideWorkspace",
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
  else if (m.id === PLATFORM_CLIENT_ID) fail("id", "is reserved for Pomade itself", m.id);
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
  const tabKinds = m.tabKinds === undefined ? undefined : parseTabKinds(m.tabKinds, errors);
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
  const events = m.events === undefined ? undefined : parseManifestEvents(m.events, errors);
  const backend = m.backend === undefined ? undefined : parseBackend(m.backend, errors);
  const api = m.api === undefined ? undefined : parseApi(m.api, errors);
  const calls = m.calls === undefined ? undefined : parseCalls(m.calls, m.id, errors);
  const commands = m.commands === undefined ? undefined : parseCommands(m.commands, m.id, errors);
  const outsideWorkspace = m.outsideWorkspace === undefined ? undefined : parseOutsideWorkspace(m.outsideWorkspace, errors);

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
  if (tabKinds !== undefined) manifest.tabKinds = tabKinds;
  if (symlinks !== undefined) manifest.symlinks = symlinks;
  if (m.startOnLaunch !== undefined) manifest.startOnLaunch = m.startOnLaunch as boolean;
  if (shortcuts !== undefined) manifest.shortcuts = shortcuts;
  if (skills !== undefined) manifest.skills = skills;
  if (events !== undefined) manifest.events = events;
  if (backend !== undefined) manifest.backend = backend;
  if (api !== undefined) manifest.api = api;
  if (calls !== undefined) manifest.calls = calls;
  if (commands !== undefined) manifest.commands = commands;
  if (outsideWorkspace !== undefined) manifest.outsideWorkspace = outsideWorkspace;
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

/** `tabKinds` (HOST-API §1): an object of app tab kinds by id. Errors name the kind by id
 *  (`"tabKinds.output.icon"`); keys a kind carries beyond the known ones are ignored. */
function parseTabKinds(raw: unknown, errors: ManifestError[]): Record<string, AppTabKind> {
  if (!isObject(raw)) {
    errors.push({ field: "tabKinds", message: `"tabKinds" must be an object of tab kinds by id ${received(raw)}` });
    return {};
  }
  const out: Record<string, AppTabKind> = {};
  for (const [id, item] of Object.entries(raw)) {
    const at = `tabKinds.${id}`;
    if (!TAB_KIND_ID_RE.test(id)) {
      errors.push({ field: at, message: `"${at}": the id must match ${TAB_KIND_ID_RE.source}` });
      continue;
    }
    if (!isObject(item)) {
      errors.push({ field: at, message: `"${at}" must be an object ${received(item)}` });
      continue;
    }
    const before = errors.length;
    if (typeof item.title !== "string" || item.title.trim() === "") {
      errors.push({ field: `${at}.title`, message: `"${at}.title" must be a non-empty string ${received(item.title)}` });
    }
    if (item.icon !== undefined && (typeof item.icon !== "string" || !isInnerPath(item.icon))) {
      errors.push({ field: `${at}.icon`, message: `"${at}.icon" must be a relative path inside the build folder ${received(item.icon)}` });
    }
    if (errors.length > before) continue;
    const kind: AppTabKind = { title: (item.title as string).trim() };
    if (item.icon !== undefined) kind.icon = item.icon as string;
    out[id] = kind;
  }
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

/** `api` (HOST-API §1): the method names the app serves; each matches `API_METHOD_RE`, unique. */
function parseApi(raw: unknown, errors: ManifestError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "api", message: `"api" must be an array of method names ${received(raw)}` });
    return [];
  }
  const out: string[] = [];
  (raw as unknown[]).forEach((item, i) => {
    const at = `api[${i}]`;
    if (typeof item !== "string" || item.length > API_METHOD_MAX_LENGTH || !API_METHOD_RE.test(item)) {
      errors.push({ field: at, message: `"${at}" must be a method name matching ${API_METHOD_RE.source} ${received(item)}` });
    } else if (out.includes(item)) {
      errors.push({ field: at, message: `"${at}" repeats the method ${JSON.stringify(item)}` });
    } else {
      out.push(item);
    }
  });
  return out;
}

/** `calls` (HOST-API §1): the ids of the apps whose APIs this app calls — not itself, unique. */
function parseCalls(raw: unknown, ownId: unknown, errors: ManifestError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "calls", message: `"calls" must be an array of app ids ${received(raw)}` });
    return [];
  }
  const out: string[] = [];
  (raw as unknown[]).forEach((item, i) => {
    const at = `calls[${i}]`;
    if (typeof item !== "string" || !APP_ID_RE.test(item) || item === PLATFORM_CLIENT_ID) {
      errors.push({ field: at, message: `"${at}" must be an app id ${received(item)}` });
    } else if (item === ownId) {
      errors.push({ field: at, message: `"${at}" names the app itself; an app always reaches its own API` });
    } else if (out.includes(item)) {
      errors.push({ field: at, message: `"${at}" repeats the app ${JSON.stringify(item)}` });
    } else {
      out.push(item);
    }
  });
  return out;
}

/** An `outsideWorkspace` entry may be at most this long. */
export const OUTSIDE_PATH_MAX_LENGTH = 1024;

/** An `outsideWorkspace` entry: absolute (`/etc/hosts`) or under the home folder (`~/.claude/`);
 *  no `.` or `..` segment, no empty segment but a trailing `/` (a folder), no backslash. */
export function isOutsideWorkspacePath(p: string): boolean {
  if (p.length > OUTSIDE_PATH_MAX_LENGTH || p.includes("\\")) return false;
  let rest: string;
  if (p.startsWith("~/")) rest = p.slice(2);
  else if (p.startsWith("/") && p !== "/") rest = p.slice(1);
  else return false;
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "") return false;
  return rest.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** `outsideWorkspace` (HOST-API §1): the paths outside the workspace the app uses, kept as written;
 *  errors name the entry by index, a repeated path is reported on the later entry. */
function parseOutsideWorkspace(raw: unknown, errors: ManifestError[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "outsideWorkspace", message: `"outsideWorkspace" must be an array of paths ${received(raw)}` });
    return [];
  }
  const out: string[] = [];
  (raw as unknown[]).forEach((item, i) => {
    const at = `outsideWorkspace[${i}]`;
    if (typeof item !== "string" || !isOutsideWorkspacePath(item)) {
      errors.push({
        field: at,
        message: `"${at}" must be an absolute path or one starting with "~/", without "." or ".." segments ${received(item)}`,
      });
    } else if (out.includes(item)) {
      errors.push({ field: at, message: `"${at}" repeats the path ${JSON.stringify(item)}` });
    } else {
      out.push(item);
    }
  });
  return out;
}

/** A Node entry file inside the build. */
const NODE_ENTRY_RE = /\.(m|c)?js$/;

/** `commands` (HOST-API §1): `{ name, entry, title? }` each. A name is the app id or starts with
 *  `<app id>-` — an app never shadows a system command or another app's — and is not one of
 *  Pomade's own; unique. */
function parseCommands(raw: unknown, ownId: unknown, errors: ManifestError[]): AppCommand[] {
  if (!Array.isArray(raw)) {
    errors.push({ field: "commands", message: `"commands" must be an array of commands ${received(raw)}` });
    return [];
  }
  const out: AppCommand[] = [];
  (raw as unknown[]).forEach((item, i) => {
    const at = `commands[${i}]`;
    if (!isObject(item)) {
      errors.push({ field: at, message: `"${at}" must be an object ${received(item)}` });
      return;
    }
    const before = errors.length;
    const fail = (key: string, rule: string, value: unknown): void => {
      errors.push({ field: `${at}.${key}`, message: `"${at}.${key}" ${rule} ${received(value)}` });
    };
    const name = item.name;
    if (typeof name !== "string" || !COMMAND_NAME_RE.test(name)) {
      fail("name", `must match ${COMMAND_NAME_RE.source}`, name);
    } else if (typeof ownId === "string" && name !== ownId && !name.startsWith(`${ownId}-`)) {
      fail("name", `must be the app id or start with "${ownId}-"`, name);
    } else if (RESERVED_COMMANDS.includes(name)) {
      fail("name", "is one of Pomade's own commands", name);
    } else if (out.some((c) => c.name === name)) {
      errors.push({ field: `${at}.name`, message: `"${at}.name" repeats the command ${JSON.stringify(name)}` });
    }
    if (typeof item.entry !== "string" || !isInnerPath(item.entry) || !NODE_ENTRY_RE.test(item.entry)) {
      fail("entry", "must be a .js, .mjs or .cjs file inside the build folder", item.entry);
    }
    if (item.title !== undefined && typeof item.title !== "string") fail("title", "must be a string", item.title);
    if (errors.length > before) return;
    out.push({ name: name as string, entry: item.entry as string, title: ((item.title as string | undefined) ?? "").trim() });
  });
  return out;
}

/** `backend` (HOST-API §1): `{ entry, mode, restartOnUpdate? }`. */
function parseBackend(raw: unknown, errors: ManifestError[]): AppBackend | undefined {
  if (!isObject(raw)) {
    errors.push({ field: "backend", message: `"backend" must be an object ${received(raw)}` });
    return undefined;
  }
  const before = errors.length;
  const fail = (key: string, rule: string, value: unknown): void => {
    errors.push({ field: `backend.${key}`, message: `"backend.${key}" ${rule} ${received(value)}` });
  };
  if (typeof raw.entry !== "string" || !isInnerPath(raw.entry) || !NODE_ENTRY_RE.test(raw.entry)) {
    fail("entry", "must be a .js, .mjs or .cjs file inside the build folder", raw.entry);
  }
  if (typeof raw.mode !== "string" || !BACKEND_MODES.includes(raw.mode as BackendMode)) {
    fail("mode", `must be one of ${BACKEND_MODES.join(", ")}`, raw.mode);
  }
  if (raw.restartOnUpdate !== undefined) {
    if (typeof raw.restartOnUpdate !== "boolean") fail("restartOnUpdate", "must be a boolean", raw.restartOnUpdate);
    else if (raw.mode !== "always-on") {
      errors.push({ field: "backend.restartOnUpdate", message: '"backend.restartOnUpdate" is only for mode "always-on"' });
    }
  }
  if (errors.length > before) return undefined;
  return { entry: raw.entry as string, mode: raw.mode as BackendMode, restartOnUpdate: raw.restartOnUpdate === true };
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
