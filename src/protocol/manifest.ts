// App manifest (HOST-API §1): the type and its validation, shared by Pomade's install and the
// fake host.

import { CAPABILITIES, type Capability } from "./types.js";

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
}

export const MANIFEST_FILE = "manifest.json";
export const DEFAULT_ENTRY = "index.html";
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

// semver.org's reference regex.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const KNOWN_KEYS = new Set(["id", "name", "version", "hostApi", "entry", "icon", "capabilities"]);

export type ManifestParseResult =
  | {
      ok: true;
      manifest: Manifest;
      /** Top-level keys this Host API version does not know — listed as "not supported yet". */
      unsupportedKeys: string[];
    }
  | {
      ok: false;
      /** The offending field ("" when the manifest is not an object). */
      field: string;
      /** Readable, names the field. */
      message: string;
    };

function fail(field: string, message: string): ManifestParseResult {
  return { ok: false, field, message };
}

/** A relative path that stays inside the build folder. */
function isInnerPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Validate a parsed `manifest.json`. */
export function parseManifest(value: unknown): ManifestParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("", "manifest must be a JSON object");
  }
  const m = value as Record<string, unknown>;

  if (typeof m.id !== "string" || !APP_ID_RE.test(m.id)) {
    return fail("id", `"id" must match ${APP_ID_RE.source}`);
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    return fail("name", `"name" must be a non-empty string`);
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    return fail("version", `"version" must be a semver string`);
  }
  if (typeof m.hostApi !== "number" || !Number.isInteger(m.hostApi) || m.hostApi < 0) {
    return fail("hostApi", `"hostApi" must be a non-negative integer`);
  }
  if (m.entry !== undefined && (typeof m.entry !== "string" || !isInnerPath(m.entry))) {
    return fail("entry", `"entry" must be a relative path inside the build folder`);
  }
  if (m.icon !== undefined && (typeof m.icon !== "string" || !isInnerPath(m.icon))) {
    return fail("icon", `"icon" must be a relative path inside the build folder`);
  }
  if (!Array.isArray(m.capabilities)) {
    return fail("capabilities", `"capabilities" must be an array`);
  }
  for (const c of m.capabilities as unknown[]) {
    if (typeof c !== "string" || !(CAPABILITIES as readonly string[]).includes(c)) {
      return fail(
        "capabilities",
        `"capabilities" has unknown capability ${JSON.stringify(c)}; known: ${CAPABILITIES.join(", ")}`,
      );
    }
  }

  const manifest: Manifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    hostApi: m.hostApi,
    capabilities: [...(m.capabilities as Capability[])],
  };
  if (m.entry !== undefined) manifest.entry = m.entry as string;
  if (m.icon !== undefined) manifest.icon = m.icon as string;
  const unsupportedKeys = Object.keys(m).filter((k) => !KNOWN_KEYS.has(k));
  return { ok: true, manifest, unsupportedKeys };
}
