import { describe, expect, it } from "vitest";
import { setBody } from "../frontmatter/file.js";
import { isMarkdownPath, readFrontmatter } from "./frontmatter.js";

describe("readFrontmatter", () => {
  it("no block → null", () => {
    expect(readFrontmatter("# Title\n\nbody\n")).toEqual({ frontmatter: null });
    expect(readFrontmatter("")).toEqual({ frontmatter: null });
  });

  it("parses a mapping", () => {
    expect(readFrontmatter("---\nid: E-001\nstatus: done\n---\n\n# x\n")).toEqual({
      frontmatter: { id: "E-001", status: "done" },
    });
  });

  it("keeps dates and timestamps as strings (JSON_SCHEMA)", () => {
    const r = readFrontmatter("---\ncreated: 2026-11-09\nat: 2026-11-09T10:00:00Z\n---\n");
    expect(r).toEqual({ frontmatter: { created: "2026-11-09", at: "2026-11-09T10:00:00Z" } });
  });

  it("types plain JSON values: numbers, booleans, null, lists, nested maps", () => {
    const r = readFrontmatter("---\nn: 3\nf: 1.5\nb: true\nz: null\ntags: [a, b]\nseams:\n  - sdk\nm:\n  k: v\n---\n");
    expect(r).toEqual({ frontmatter: { n: 3, f: 1.5, b: true, z: null, tags: ["a", "b"], seams: ["sdk"], m: { k: "v" } } });
  });

  it("YAML 1.1 booleans stay strings; ~ is null", () => {
    expect(readFrontmatter("---\na: yes\nb: off\nc: ~\n---\n")).toEqual({ frontmatter: { a: "yes", b: "off", c: null } });
  });

  it("non-finite numbers stay their source text, anywhere in the value tree", () => {
    const text = [
      "---",
      "a: .inf",
      "b: -.Inf",
      "c: +.INF",
      "d: .nan",
      "e: .NaN",
      "f: [1.5, .inf, -.inf]",
      "g:",
      "  deep:",
      "    - x: .nan",
      "h: !!float .inf",
      "i: 1" + "0".repeat(400),
      "j: 1.5e3",
      "k: -0.5",
      "l: '.inf'",
      "---",
      "",
    ].join("\n");
    expect(readFrontmatter(text)).toEqual({
      frontmatter: {
        a: ".inf",
        b: "-.Inf",
        c: "+.INF",
        d: ".nan",
        e: ".NaN",
        f: [1.5, ".inf", "-.inf"],
        g: { deep: [{ x: ".nan" }] },
        h: ".inf",
        i: "1" + "0".repeat(400),
        j: 1500,
        k: -0.5,
        l: ".inf",
      },
    });
  });

  it("finite numbers keep JSON_SCHEMA's reading", () => {
    expect(readFrontmatter("---\na: 0x1F\nb: 0o17\nc: 1_000\nd: 3.25\ne: -7\n---\n")).toEqual({
      frontmatter: { a: 31, b: 15, c: "1_000", d: 3.25, e: -7 },
    });
  });

  it("invalid YAML → frontmatterError (first line of the parser message)", () => {
    const r = readFrontmatter("---\nid: [unclosed\n---\n");
    expect(r).toHaveProperty("frontmatterError");
    expect("frontmatterError" in r && r.frontmatterError).not.toContain("\n");
  });

  it("duplicate keys → frontmatterError", () => {
    expect(readFrontmatter("---\na: 1\na: 2\n---\n")).toHaveProperty("frontmatterError");
  });

  it("non-mapping block → frontmatterError", () => {
    expect(readFrontmatter("---\n- a\n- b\n---\n")).toEqual({ frontmatterError: "frontmatter is not a mapping" });
    expect(readFrontmatter("---\njust text\n---\n")).toEqual({ frontmatterError: "frontmatter is not a mapping" });
    expect(readFrontmatter("---\n42\n---\n")).toEqual({ frontmatterError: "frontmatter is not a mapping" });
    expect(readFrontmatter("---\nnull\n---\n")).toEqual({ frontmatterError: "frontmatter is not a mapping" });
  });

  it("a block with no keys (blank or comments only) → empty mapping", () => {
    expect(readFrontmatter("---\n\n---\nbody")).toEqual({ frontmatter: {} });
    expect(readFrontmatter("---\n# only a comment\n  \n---\n")).toEqual({ frontmatter: {} });
  });

  it("block detection matches Pomade's editor", () => {
    // `---` must be the very first line.
    expect(readFrontmatter("\n---\na: 1\n---\n")).toEqual({ frontmatter: null });
    expect(readFrontmatter(" ---\na: 1\n---\n")).toEqual({ frontmatter: null });
    // The closing delimiter needs its own line and a newline after it; adjacent delimiters are
    // not a block. A first `---` line without a closing delimiter is unclosed (next test).
    // The first closing delimiter ends the block.
    expect(readFrontmatter("---\na: 1\n---\nb: 2\n---\n")).toEqual({ frontmatter: { a: 1 } });
    // `----` or `--- x` is not a delimiter.
    expect(readFrontmatter("----\na: 1\n----\n")).toEqual({ frontmatter: null });
    expect(readFrontmatter("--- x\na: 1\n---\n")).toEqual({ frontmatter: null });
  });

  it("a first --- line that never closes → frontmatterError, as pomade-kit/frontmatter refuses it", () => {
    const unclosed = { frontmatterError: "the leading --- block is not closed" };
    expect(readFrontmatter("---\na: 1\n")).toEqual(unclosed);
    expect(readFrontmatter("---\na: 1\n---")).toEqual(unclosed);
    expect(readFrontmatter("---\nstatus: open\n\n# Title\nbody\n")).toEqual(unclosed);
    expect(readFrontmatter("---\n---\n")).toEqual(unclosed);
    expect(readFrontmatter("---")).toEqual(unclosed);
    expect(readFrontmatter("---  \na: 1\n")).toEqual(unclosed);
    expect(readFrontmatter("---\r\na: 1\r\n")).toEqual(unclosed);
    // The same texts are refused by the file-level writers: one detection.
    for (const t of ["---\na: 1\n", "---\na: 1\n---", "---\n---\n", "---"]) {
      expect(setBody(t, "x")).toMatchObject({ ok: false, reason: "unreadable-frontmatter", message: unclosed.frontmatterError });
    }
  });

  it("CRLF files are read like LF files", () => {
    expect(readFrontmatter("---\r\nstatus: done\r\n---\r\nbody\r\n")).toEqual({ frontmatter: { status: "done" } });
  });

  it("values are structured-cloneable plain JSON", () => {
    const r = readFrontmatter("---\nd: 2026-11-09\nlist: [1, 2]\n---\n");
    expect(structuredClone(r)).toEqual(r);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("isMarkdownPath", () => {
  it.each(["a.md", "A.MD", "x/y.markdown", "n.mdown", "n.mkd", "n.mdx"])("%s is Markdown", (p) => {
    expect(isMarkdownPath(p)).toBe(true);
  });
  it.each(["a.txt", "md", "a.md.bak", "a.json", "dir/README"])("%s is not", (p) => {
    expect(isMarkdownPath(p)).toBe(false);
  });
});
