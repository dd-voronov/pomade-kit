// Frontmatter as `files.readFolder` reports it (HOST-API §4): the leading `---` YAML block, with
// the same block detection as Pomade's editor (`frontmatter-extent.ts`), parsed with js-yaml's JSON_SCHEMA so values stay
// plain JSON (`created: 2026-11-09` is the string "2026-11-09", `.inf` the string ".inf").

import yaml from "js-yaml";
import { frontmatterExtent, UNCLOSED_FRONTMATTER } from "./frontmatter-extent.js";

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

export type FrontmatterRead =
  | { frontmatter: Record<string, unknown> | null }
  | { frontmatterError: string };

/**
 * Read a Markdown file's frontmatter. No block → `{ frontmatter: null }`; a block with no keys
 * → `{ frontmatter: {} }`; invalid YAML, a block that is not a mapping, or a first `---` line
 * that never closes → `{ frontmatterError }`.
 */
export function readFrontmatter(text: string): FrontmatterRead {
  const extent = frontmatterExtent(text.replace(/\r\n/g, "\n"));
  if (extent.kind === "none") return { frontmatter: null };
  if (extent.kind === "unclosed") return { frontmatterError: UNCLOSED_FRONTMATTER };
  const inner = extent.inner;
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
