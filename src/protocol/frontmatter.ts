// Frontmatter as `files.readFolder` reports it (HOST-API §4): the leading `---` YAML block, with
// the same block detection as Pomade's editor, parsed with js-yaml's JSON_SCHEMA so values stay
// plain JSON (`created: 2026-11-09` is the string "2026-11-09", `.inf` the string ".inf").

import yaml from "js-yaml";

/** Markdown files — the extensions Pomade treats as first-class Markdown. */
export const MARKDOWN_FILE_RE = /\.(md|markdown|mdown|mkd|mdx)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_FILE_RE.test(path);
}

// js-yaml's JSON_SCHEMA, except that numbers which are not finite (`.inf`, `-.Inf`, `.nan`, an
// integer too large for a double) stay their source text, so every value is plain JSON.

/** js-yaml's built-in scalar types; present at runtime, missing from @types/js-yaml. */
interface ScalarType {
  tag: string;
  resolve: (data: string) => boolean;
  construct: (data: string) => unknown;
}
const builtin = (yaml as unknown as { types: Record<"null" | "bool" | "int" | "float", ScalarType & yaml.Type> }).types;

function finiteOrSource(type: ScalarType): yaml.Type {
  return new yaml.Type(type.tag, {
    kind: "scalar",
    resolve: (data: unknown) => typeof data === "string" && type.resolve(data),
    construct: (data: string): unknown => {
      const value = type.construct(data);
      return typeof value === "number" && !Number.isFinite(value) ? data : value;
    },
  });
}

const SCHEMA = yaml.FAILSAFE_SCHEMA.extend({
  implicit: [builtin.null, builtin.bool, finiteOrSource(builtin.int), finiteOrSource(builtin.float)],
});

// Pomade's editor split (doc-io FRONTMATTER_RE + frontmatter-edit decompose), on LF-normalized text.
const BLOCK_RE = /^---\n([\s\S]*?)\n---\n/;

export type FrontmatterRead =
  | { frontmatter: Record<string, unknown> | null }
  | { frontmatterError: string };

/**
 * Read a Markdown file's frontmatter. No block → `{ frontmatter: null }`; a block with no keys
 * → `{ frontmatter: {} }`; invalid YAML or a block that is not a mapping → `{ frontmatterError }`.
 */
export function readFrontmatter(text: string): FrontmatterRead {
  const m = BLOCK_RE.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { frontmatter: null };
  const inner = m[1] ?? "";
  if (inner.split("\n").every((line) => line.trim() === "" || line.trimStart().startsWith("#"))) {
    return { frontmatter: {} };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(inner, { schema: SCHEMA });
  } catch (err) {
    return { frontmatterError: (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "invalid YAML" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatterError: "frontmatter is not a mapping" };
  }
  return { frontmatter: parsed as Record<string, unknown> };
}
