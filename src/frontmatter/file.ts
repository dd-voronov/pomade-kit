// Field-only frontmatter writes on a whole file's text — what apps call. Built on the block
// core (`block.ts`, Pomade's properties-panel logic): only the edited key's own lines change;
// every other byte of the frontmatter and the whole body stay identical.

import yaml from "js-yaml";
import { readFrontmatter } from "../protocol/frontmatter.js";
import { frontmatterExtent, UNCLOSED_FRONTMATTER } from "../protocol/frontmatter-extent.js";
import {
  addPropertyText,
  emitScalar,
  hasKeyLine,
  parseMapping,
  parseFrontmatter,
  removeProperty,
  setListText,
  setScalarText,
} from "./block.js";

/** The blank lines after a block, which belong to the block in Pomade's editor split (doc-io). */
const TRAILING_BLANK_LINES_RE = /^(?:[^\S\n]*\n)*/;

/**
 * Split LF text into the frontmatter block plus the blank lines after it (`""` when none, an
 * unclosed `---` block included) and the body, as Pomade's editor does.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const extent = frontmatterExtent(text);
  if (extent.kind !== "block") return { frontmatter: "", body: text };
  const end = extent.end + (TRAILING_BLANK_LINES_RE.exec(text.slice(extent.end))?.[0].length ?? 0);
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}

/** A value `setField` writes: text, a finite number, a boolean, a list of text, or `null` (`key:`). */
export type FieldValue = string | number | boolean | null | readonly string[];

export type FieldWriteError =
  /** The block is not a valid YAML mapping, or a `---` first line never closes; fix it by hand. */
  | "unreadable-frontmatter"
  /** The key exists but has no line of its own the writer can locate (e.g. a key with a colon). */
  | "unsupported-key"
  /** The key or value cannot be written (empty key, line break in the key, non-finite number). */
  | "invalid-value";

export type FieldWriteResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: FieldWriteError; message: string };

interface Parts {
  /** The LF-normalized frontmatter block, `""` when the file has none. */
  block: string;
  /** The body, raw (original line endings). */
  body: string;
  /** Write the block back with CRLF line endings. */
  crlf: boolean;
}

function fail(reason: FieldWriteError, message: string): FieldWriteResult {
  return { ok: false, reason, message };
}

/** Raw index in `raw` of LF-normalized index `normIndex` (each CRLF counts as one char). */
function rawIndex(raw: string, normIndex: number): number {
  let r = 0;
  for (let n = 0; n < normIndex; n++) r += raw.startsWith("\r\n", r) ? 2 : 1;
  return r;
}

function split(text: string): Parts | FieldWriteResult {
  const norm = text.replace(/\r\n/g, "\n");
  if (frontmatterExtent(norm).kind === "unclosed") return fail("unreadable-frontmatter", UNCLOSED_FRONTMATTER);
  const { frontmatter } = splitFrontmatter(norm);
  if (frontmatter === "") return { block: "", body: text, crlf: text.includes("\r\n") };
  const end = rawIndex(text, frontmatter.length);
  const rawBlock = text.slice(0, end);
  if (!parseFrontmatter(frontmatter).ok) return fail("unreadable-frontmatter", "the frontmatter is not a valid YAML mapping");
  return { block: frontmatter, body: text.slice(end), crlf: rawBlock.includes("\r\n") };
}

function join(original: string, parts: Parts, block: string): FieldWriteResult {
  const text = (parts.crlf ? block.replace(/\n/g, "\r\n") : block) + parts.body;
  return { ok: true, text, changed: text !== original };
}

function checkKey(parts: Parts, key: string): FieldWriteResult | null {
  if (parts.block !== "" && !hasKeyLine(parts.block, key) && Object.hasOwn(parseMapping(parts.block) ?? {}, key)) {
    return fail("unsupported-key", `"${key}" has no line of its own to edit; edit it by hand`);
  }
  return null;
}

/**
 * Text as a scalar that reads back as this same string under JSON_SCHEMA — quoted when plain
 * would read as a number, boolean, null or a non-finite number, or would not stay on one
 * line. Dates stay plain.
 */
function emitString(value: string): string {
  const plain = emitScalar(value);
  if (plain !== value) return plain;
  try {
    const read = yaml.load(`v: ${plain}`, { schema: yaml.JSON_SCHEMA }) as { v: unknown };
    return read.v === value ? plain : JSON.stringify(value);
  } catch {
    return JSON.stringify(value);
  }
}

function emitNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  const read = readFrontmatter(`---\nv: ${text}\n---\n`);
  return "frontmatter" in read && read.frontmatter?.v === value ? text : null;
}

/**
 * Set `key` to `value` in a file's text: rewrite the key's own lines when it exists, else append
 * it at the end of the block (creating the block when the file has none). Strings are written
 * plain when that reads back as the same string, double-quoted otherwise; lists keep their flow
 * or block style.
 */
export function setField(text: string, key: string, value: FieldValue): FieldWriteResult {
  if (key === "" || /[\r\n]/.test(key)) return fail("invalid-value", "the key must be non-empty and on one line");
  let scalar: string | null = null;
  let items: string[] | null = null;
  if (Array.isArray(value)) items = (value as readonly string[]).map(emitString);
  else if (typeof value === "string") scalar = emitString(value);
  else if (typeof value === "boolean") scalar = value ? "true" : "false";
  else if (typeof value === "number") {
    scalar = emitNumber(value);
    if (scalar === null) return fail("invalid-value", `${String(value)} cannot be written as a YAML number`);
  }

  const parts = split(text);
  if (!("block" in parts)) return parts;
  const refused = checkKey(parts, key);
  if (refused) return refused;

  let block = parts.block;
  const exists = block !== "" && hasKeyLine(block, key);
  if (items) {
    if (!exists) block = addPropertyText(block, key, null);
    else if (!Array.isArray(parseMapping(block)?.[key])) block = setScalarText(block, key, null);
    block = setListText(block, key, items);
  } else if (exists) {
    block = setScalarText(block, key, scalar);
  } else {
    block = addPropertyText(block, key, scalar);
  }
  return join(text, parts, block);
}

/**
 * The raw offset where the body starts: after the frontmatter block and the blank lines that
 * follow it (Pomade's editor split), `0` without a block, `null` when a first `---` line never
 * closes. Line endings are the file's own.
 */
function bodyStart(text: string): number | null {
  const norm = text.replace(/\r\n/g, "\n");
  if (frontmatterExtent(norm).kind === "unclosed") return null;
  return rawIndex(text, splitFrontmatter(norm).frontmatter.length);
}

/** A file's body as `setBody` replaces it — everything after the frontmatter block and the blank
 *  lines that follow it, with the file's own line endings. The whole text when there is no block
 *  (an unclosed `---` block included, as Pomade's editor shows it). */
export function getBody(text: string): string {
  return text.slice(bodyStart(text) ?? 0);
}

/**
 * Replace a file's body, keeping every byte of the frontmatter block and the blank lines after
 * it. `body` is written as given (its own line endings). Without a block the whole text is the
 * body. A first `---` line that never closes is refused: the block's extent is unknown.
 */
export function setBody(text: string, body: string): FieldWriteResult {
  const start = bodyStart(text);
  if (start === null) return fail("unreadable-frontmatter", UNCLOSED_FRONTMATTER);
  const next = text.slice(0, start) + body;
  return { ok: true, text: next, changed: next !== text };
}

/** Remove `key`'s lines; removing the last key drops the whole block. A missing key changes nothing. */
export function removeField(text: string, key: string): FieldWriteResult {
  const parts = split(text);
  if (!("block" in parts)) return parts;
  if (parts.block === "") return { ok: true, text, changed: false };
  const refused = checkKey(parts, key);
  if (refused) return refused;
  return join(text, parts, removeProperty(parts.block, key));
}
