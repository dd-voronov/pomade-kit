// Where a Markdown file's leading frontmatter block is — the one detection both frontmatter
// readers (`readFrontmatter`, `pomade-kit/frontmatter`) use. Pomade's editor split (doc-io
// FRONTMATTER_RE + frontmatter-edit decompose), on LF-normalized text. Internal: not re-exported.

const BLOCK_RE = /^---\n([\s\S]*?)\n---\n/;

export type FrontmatterExtent =
  /** The file has no frontmatter block. */
  | { kind: "none" }
  /** A block: `inner` is the YAML between the delimiters, `end` the offset just past the closing `---\n`. */
  | { kind: "block"; inner: string; end: number }
  /** The first line is `---` but no closing delimiter follows: the block's extent is unknown. */
  | { kind: "unclosed" };

/** Locate the leading frontmatter block of LF-normalized `text`. */
export function frontmatterExtent(text: string): FrontmatterExtent {
  const m = BLOCK_RE.exec(text);
  if (m) return { kind: "block", inner: m[1] ?? "", end: m[0].length };
  const nl = text.indexOf("\n");
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  return firstLine.trimEnd() === "---" ? { kind: "unclosed" } : { kind: "none" };
}

/** The message both readers give for an unclosed block. */
export const UNCLOSED_FRONTMATTER = "the leading --- block is not closed";
