// Field-only frontmatter edits on a frontmatter BLOCK — the core of Pomade's properties panel.
//
//   - js-yaml parses ONLY to LOCATE keys and TYPE values — never to re-serialize the document.
//     Every mutation rewrites ONLY the target key's own line(s); the opening `---`, the closing
//     `---`, the trailing blank line(s), comments, blank lines, key order, and every OTHER key
//     stay BYTE-IDENTICAL.
//   - Never refuse a block. Unparseable YAML → { ok: false } (the caller leaves the bytes
//     untouched). Complex values (nested map, list of objects, multiline string) → a read-only
//     row carrying the raw YAML snippet; the simple keys around them stay editable.
//
// Exceptions on the EDITED key itself (part of the contract): a quoted scalar re-emits plain
// when safe; a list edit regenerates all of that list's item lines (comments between items are
// lost); an emptied block list collapses to `key: []`; removing the last property drops the
// whole block, standalone comments included.
//
// `block` throughout is the frontmatter block as `splitFrontmatter` returns it, on LF text:
//   `---\n<inner>\n---\n<trailing blank lines>`

import yaml from "js-yaml";

export type PropType = "string" | "number" | "boolean" | "date" | "list" | "complex";

export interface PropRow {
  key: string;
  type: PropType;
  /** Scalar display/edit text (string/number/date). Empty string for a null/empty scalar. */
  scalar: string;
  /** Boolean value (type === "boolean"). */
  bool: boolean;
  /** List items (type === "list"). */
  list: string[];
  /** Whether the list uses tag chips (key === "tags"). */
  isTags: boolean;
  /** Raw YAML snippet for a complex, read-only row (type === "complex"). */
  complexYaml: string;
  /** "{}" for a map / list of objects, "¶" for a multiline string. */
  complexGlyph: "{}" | "¶";
  editable: boolean;
}

export interface ParsedFrontmatter {
  ok: boolean;
  rows: PropRow[];
}

interface Decomposed {
  open: string; // '---\n'
  inner: string; // between the delimiters, WITHOUT the delimiter newlines
  close: string; // '---\n'
  trailing: string; // blank line(s) after the closing delimiter
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

// A top-level key line: starts at column 0 with a key, not a comment / list item / indented.
const TOP_KEY_RE = /^([^\s#][^:]*?):(\s|$)/;

function decompose(block: string): Decomposed | null {
  const m = /^(---\n)([\s\S]*?)(\n---\n)([\s\S]*)$/.exec(block);
  if (!m) return null;
  return { open: m[1] ?? "", inner: m[2] ?? "", close: "---\n", trailing: m[4] ?? "" };
}

function reassemble(d: Decomposed, innerLines: string[]): string {
  return d.open + innerLines.join("\n") + "\n" + d.close + d.trailing;
}

// Span of a top-level key = its key line plus the following indented continuation lines
// (list items, nested-map lines, block-scalar lines). Blank lines and column-0 lines end it.
function keySpan(lines: string[], i: number): [number, number] {
  let end = i + 1;
  while (end < lines.length && /^\s/.test(lines[end] ?? "")) end++;
  return [i, end];
}

function findKey(lines: string[], key: string): number {
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_KEY_RE.exec(lines[i] ?? "");
    if (m && unquoteKey(m[1] ?? "") === key) return i;
  }
  return -1;
}

function unquoteKey(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// ── Scalar emission ──────────────────────────────────────────────────────────
// Emit a value as a YAML scalar, preferring the PLAIN style so edits stay byte-minimal (a date
// stays `2026-06-15`, not `"2026-06-15"`). Double-quoted only when plain would be ambiguous or
// invalid.
function isSafePlain(s: string): boolean {
  if (s.length === 0) return false;
  if (s !== s.trim()) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/:(\s|$)/.test(s)) return false; // 'key: value' style colon inside the value
  if (/\s#/.test(s)) return false; // start of an inline comment
  return true;
}

export function emitScalar(value: string): string {
  return isSafePlain(value) ? value : JSON.stringify(value);
}

// Split a value line's remainder into [leadingSpace, trailingComment].
function splitRemainder(rest: string): { space: string; comment: string } {
  const space = /^\s*/.exec(rest)?.[0] ?? " ";
  const cm = /(\s+#.*)$/.exec(rest);
  return { space: space || " ", comment: cm ? (cm[1] ?? "") : "" };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
/** Type the block's top-level keys as rows; `ok: false` when the YAML is not a valid mapping. */
export function parseFrontmatter(block: string): ParsedFrontmatter {
  const d = decompose(block);
  if (!d) return { ok: false, rows: [] };

  let parsed: unknown;
  try {
    parsed = yaml.load(d.inner);
  } catch {
    return { ok: false, rows: [] };
  }
  // A scalar/array top-level document isn't an editable property map → raw fallback.
  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    return { ok: false, rows: [] };
  }
  const map = (parsed ?? {}) as Record<string, unknown>;

  const lines = d.inner.split("\n");
  const rows: PropRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const km = TOP_KEY_RE.exec(lines[i] ?? "");
    if (!km) continue;
    const key = unquoteKey(km[1] ?? "");
    const [start, end] = keySpan(lines, i);
    const value = map[key];
    rows.push(classify(key, value, lines.slice(start, end)));
    i = end - 1;
  }
  return { ok: true, rows };
}

function classify(key: string, value: unknown, spanLines: string[]): PropRow {
  const base: PropRow = {
    key,
    type: "string",
    scalar: "",
    bool: false,
    list: [],
    isTags: key === "tags",
    complexYaml: "",
    complexGlyph: "{}",
    editable: true,
  };
  const first = spanLines[0] ?? "";

  // Date first — js-yaml parses `2026-06-15` into a Date, which is also an object, so it must be
  // caught before the nested-map branch. The DISPLAY text comes from the raw line, so the
  // original text and timezone stay intact and no quotes leak.
  if (value instanceof Date) {
    return { ...base, type: "date", scalar: rawScalar(first) };
  }
  // List of primitives → chips. List of objects → complex.
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      return { ...base, type: "list", list: value.map((v) => (v === null ? "" : String(v))) };
    }
    return complexRow(base, spanLines, "{}");
  }
  // Nested map → complex.
  if (value !== null && typeof value === "object") {
    return complexRow(base, spanLines, "{}");
  }
  // Multiline string (block scalar) → complex ¶.
  if (typeof value === "string" && value.includes("\n")) {
    return complexRow(base, spanLines, "¶");
  }
  if (typeof value === "boolean") {
    return { ...base, type: "boolean", bool: value };
  }
  // Scalar (string / number / date-shaped string). The display text comes from the raw line.
  const scalar = rawScalar(first);
  if (DATE_RE.test(scalar)) {
    return { ...base, type: "date", scalar };
  }
  if (typeof value === "number") {
    return { ...base, type: "number", scalar };
  }
  return { ...base, type: "string", scalar };
}

function complexRow(base: PropRow, spanLines: string[], glyph: "{}" | "¶"): PropRow {
  // Drop the `key:` prefix from the first line for a tidy snippet; keep the rest verbatim.
  const first = spanLines[0] ?? "";
  const colon = first.indexOf(":");
  const head = first.slice(colon + 1).trim();
  const rest = spanLines.slice(1);
  const snippet = (head ? [head, ...rest] : rest).join("\n");
  return { ...base, type: "complex", complexYaml: snippet, complexGlyph: glyph, editable: false };
}

function rawScalar(line: string): string {
  const colon = line.indexOf(":");
  if (colon < 0) return "";
  const rest = line.slice(colon + 1);
  const noComment = rest.replace(/\s+#.*$/, "");
  const t = noComment.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try {
      return String(yaml.load(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** The block's YAML mapping, or `null` when it is not one (see `parseFrontmatter`). */
export function parseMapping(block: string): Record<string, unknown> | null {
  const d = decompose(block);
  if (!d) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(d.inner);
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined) return {};
  return typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Whether the block has a top-level key line for `key` (the line the mutations rewrite). */
export function hasKeyLine(block: string, key: string): boolean {
  const d = decompose(block);
  return d !== null && findKey(d.inner.split("\n"), key) >= 0;
}

/** Set a scalar; `""` clears it (`key:`), keeping an inline comment. Unknown key → unchanged. */
export function setScalarValue(block: string, key: string, value: string): string {
  return setScalarText(block, key, value === "" ? null : emitScalar(value));
}

/** Set `key`'s value to YAML scalar text as given; `null` clears it. Unknown key → unchanged. */
export function setScalarText(block: string, key: string, text: string | null): string {
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");
  const i = findKey(lines, key);
  if (i < 0) return block;
  const line = lines[i] ?? "";
  const colon = line.indexOf(":");
  const prefix = line.slice(0, colon + 1);
  const { space, comment } = splitRemainder(line.slice(colon + 1));
  const [, end] = keySpan(lines, i);
  const rebuilt = text === null ? `${prefix}${comment}` : `${prefix}${space}${text}${comment}`;
  lines.splice(i, end - i, rebuilt);
  return reassemble(d, lines);
}

export function setBooleanValue(block: string, key: string, value: boolean): string {
  return setScalarValue(block, key, value ? "true" : "false");
}

/** Replace a list's items, keeping flow (`[a, b]`) or block style and the item indent. */
export function setListValue(block: string, key: string, items: string[]): string {
  return setListText(block, key, items.map(emitScalar));
}

/** `setListValue` with items already emitted as YAML scalar text. */
export function setListText(block: string, key: string, items: string[]): string {
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");
  const i = findKey(lines, key);
  if (i < 0) return block;
  const line = lines[i] ?? "";
  const colon = line.indexOf(":");
  const prefix = line.slice(0, colon + 1);
  const [, end] = keySpan(lines, i);
  const after = line.slice(colon + 1).trim();
  const isFlow = after.startsWith("[") || items.length === 0;

  if (isFlow) {
    const { comment } = splitRemainder(line.slice(colon + 1));
    const body = `[${items.join(", ")}]`;
    lines.splice(i, end - i, `${prefix} ${body}${comment}`);
    return reassemble(d, lines);
  }
  // Block style: keep the key line, detect the item indent from an existing item.
  let indent = "  ";
  for (let j = i + 1; j < end; j++) {
    const im = /^(\s*)-/.exec(lines[j] ?? "");
    if (im) {
      indent = im[1] ?? "";
      break;
    }
  }
  const itemLines = items.map((it) => `${indent}- ${it}`);
  lines.splice(i, end - i, line, ...itemLines);
  return reassemble(d, lines);
}

/** Append `key: value` at the end of the block; `""` block → a new block `---\nkey: value\n---\n\n`. */
export function addProperty(block: string, key: string, value: string): string {
  return addPropertyText(block, key, value === "" ? null : emitScalar(value));
}

/** `addProperty` with the value already emitted as YAML scalar text; `null` → `key:`. */
export function addPropertyText(block: string, key: string, text: string | null): string {
  const newLine = text === null ? `${emitKey(key)}:` : `${emitKey(key)}: ${text}`;
  if (!block) return `---\n${newLine}\n---\n\n`;
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");
  // Insert after the last non-blank inner line so a trailing blank never separates the new key.
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") last--;
  lines.splice(last + 1, lines.length - (last + 1), newLine);
  return reassemble(d, lines);
}

function emitKey(key: string): string {
  return isSafePlain(key) && !/:/.test(key) ? key : JSON.stringify(key);
}

/**
 * Move `key`'s lines to just before `beforeKey` (or to the END when `beforeKey` is null or not
 * found). Every key's own lines stay identical — only their order changes. Standalone comment /
 * blank lines keep their position; inline comments travel with their key line.
 */
export function moveKey(block: string, key: string, beforeKey: string | null): string {
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");

  // Segment the inner into ordered key-blocks and interleaving "gap" runs (comments/blanks).
  interface Seg {
    key?: string;
    lines: string[];
  }
  const segs: Seg[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? "";
    const m = TOP_KEY_RE.exec(line);
    if (m && !/^\s/.test(line)) {
      const [start, end] = keySpan(lines, i);
      segs.push({ key: unquoteKey(m[1] ?? ""), lines: lines.slice(start, end) });
      i = end;
    } else {
      const last = segs[segs.length - 1];
      if (last && !last.key) last.lines.push(line);
      else segs.push({ lines: [line] });
      i++;
    }
  }

  const fromIdx = segs.findIndex((s) => s.key === key);
  if (fromIdx < 0) return block;
  const [moving] = segs.splice(fromIdx, 1);
  if (!moving) return block;
  const targetIdx = beforeKey ? segs.findIndex((s) => s.key === beforeKey) : -1;
  if (targetIdx < 0) segs.push(moving);
  else segs.splice(targetIdx, 0, moving);

  return reassemble(
    d,
    segs.flatMap((s) => s.lines),
  );
}

/** The exact source lines of `key` (key line + its indented continuation lines), joined with '\n'. */
export function getKeyLines(block: string, key: string): string {
  const d = decompose(block);
  if (!d) return "";
  const lines = d.inner.split("\n");
  const i = findKey(lines, key);
  if (i < 0) return "";
  const [, end] = keySpan(lines, i);
  return lines.slice(i, end).join("\n");
}

/** Replace `key`'s lines with `text` VERBATIM. The caller validates `text` first (`validateYaml`). */
export function setComplexKeyLines(block: string, key: string, text: string): string {
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");
  const i = findKey(lines, key);
  if (i < 0) return block;
  const [, end] = keySpan(lines, i);
  lines.splice(i, end - i, ...text.split("\n"));
  return reassemble(d, lines);
}

/** `null` when `text` parses as a YAML mapping, else a short error message. */
export function validateYaml(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    return ((err as Error).message.split("\n")[0]) ?? "invalid YAML";
  }
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Expected a property (key: value)";
  }
  return null;
}

/** Remove `key`'s lines; returns `""` when no key is left (the whole block is dropped). */
export function removeProperty(block: string, key: string): string {
  const d = decompose(block);
  if (!d) return block;
  const lines = d.inner.split("\n");
  const i = findKey(lines, key);
  if (i < 0) return block;
  const [, end] = keySpan(lines, i);
  lines.splice(i, end - i);
  // If nothing but blanks/comments remains, drop the entire frontmatter block.
  const hasKey = lines.some((l) => TOP_KEY_RE.test(l));
  if (!hasKey) return "";
  return reassemble(d, lines);
}
