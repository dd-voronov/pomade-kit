import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFrontmatter } from "../protocol/frontmatter.js";
import { setScalarValue } from "./block.js";
import { getBody, removeField, setBody, setField, setKeyLines, splitFrontmatter, type FieldWriteResult } from "./file.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FIXTURES = ["E-029-side-panels.md", "E-017-icon-library-picker-redesign.md", "T-100-link-picker-scroll.md", "E-001-editor-context-menus.md"];

function text(r: FieldWriteResult): string {
  if (!r.ok) throw new Error(`write refused: ${r.reason} — ${r.message}`);
  return r.text;
}

/** Lines (with their endings) that differ between two texts of the same line count. */
function changedLines(a: string, b: string): Array<[string, string]> {
  const la = a.split(/(?<=\n)/);
  const lb = b.split(/(?<=\n)/);
  expect(lb).toHaveLength(la.length);
  return la.flatMap((line, i): Array<[string, string]> => (line === lb[i] ? [] : [[line, lb[i] ?? ""]]));
}

function fm(t: string): Record<string, unknown> {
  const r = readFrontmatter(t);
  if (!("frontmatter" in r) || r.frontmatter === null) throw new Error("no readable frontmatter");
  return r.frontmatter;
}

/** Pomade's editor pipeline (doc-io normalize → split → block edit → join → reconstruct). */
function editorWrite(raw: string, edit: (block: string) => string): string {
  const hadCRLF = /\r\n/.test(raw);
  const t = hadCRLF ? raw.replace(/\r\n/g, "\n") : raw;
  const { frontmatter, body } = splitFrontmatter(t);
  let out = edit(frontmatter) + body;
  if (t.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  return hadCRLF ? out.replace(/\n/g, "\r\n") : out;
}

describe("pinned: a Board drag on a real ticket", () => {
  it("changing status and updated changes exactly those two lines", () => {
    const before = fixture("E-029-side-panels.md");
    const after = text(setField(text(setField(before, "status", "in-progress")), "updated", "2026-11-10"));
    expect(changedLines(before, after)).toEqual([
      ["status: planned\n", "status: in-progress\n"],
      ["updated: 2026-11-09\n", "updated: 2026-11-10\n"],
    ]);
  });
});

describe("real ticket files", () => {
  it.each(FIXTURES)("%s: setting any scalar key changes only that key's line; reads back", (name) => {
    const before = fixture(name);
    const original = fm(before);
    for (const [key, value] of Object.entries(original)) {
      if (typeof value !== "string") continue;
      const after = text(setField(before, key, "New value"));
      const diff = changedLines(before, after);
      expect(diff).toHaveLength(1);
      expect(diff[0]?.[1]).toBe(`${key}: New value\n`);
      expect(fm(after)).toEqual({ ...original, [key]: "New value" });
      expect(splitFrontmatter(after).body).toBe(splitFrontmatter(before).body);
    }
  });

  it.each(FIXTURES)("%s: removing any key removes only its line", (name) => {
    const before = fixture(name);
    const original = fm(before);
    for (const key of Object.keys(original)) {
      const after = text(removeField(before, key));
      const lines = after.split("\n");
      expect(before.split("\n").filter((l) => !l.startsWith(`${key}:`))).toEqual(lines);
      const { [key]: _removed, ...rest } = original;
      expect(fm(after)).toEqual(rest);
    }
  });

  it("adding a missing key appends one line at the end of the block", () => {
    const before = fixture("E-017-icon-library-picker-redesign.md");
    const after = text(setField(before, "updated", "2026-11-10"));
    expect(after).toBe(before.replace("source: user-testing-2026-07-24\n---\n", "source: user-testing-2026-07-24\nupdated: 2026-11-10\n---\n"));
  });

  it("setting the value a key already has changes nothing", () => {
    const before = fixture("E-029-side-panels.md");
    expect(setField(before, "status", "planned")).toEqual({ ok: true, text: before, changed: false });
  });

  it("a quoted title stays as it is unless edited; edited, it is re-emitted plain when safe", () => {
    const before = fixture("E-017-icon-library-picker-redesign.md");
    const after = text(setField(before, "title", "Icon picker v3"));
    expect(changedLines(before, after)).toEqual([
      ['title: "Icon picker v2: predefined icon library (use-case + brand icons) + three-mode window redesign"\n', "title: Icon picker v3\n"],
    ]);
    expect(changedLines(before, text(setField(before, "title", "v3: picker")))[0]?.[1]).toBe('title: "v3: picker"\n');
  });

  it("matches Pomade's editor pipeline byte for byte", () => {
    for (const name of FIXTURES) {
      const before = fixture(name);
      for (const [key, value] of [["status", "done"], ["module", "core"], ["priority", "P0"]] as const) {
        expect(text(setField(before, key, value))).toBe(editorWrite(before, (b) => setScalarValue(b, key, value)));
      }
    }
  });
});

describe("value emission — the written value reads back as the same value", () => {
  const base = "---\nk: old\n---\nbody\n";
  it.each<[unknown, string]>([
    ["plain", "k: plain"],
    ["two words", "k: two words"],
    ["2026-11-09", "k: 2026-11-09"],
    ["2026-11-09T10:00:00Z", "k: 2026-11-09T10:00:00Z"],
    ["yes", "k: yes"],
    ["P1", "k: P1"],
    ["true", 'k: "true"'],
    ["false", 'k: "false"'],
    ["null", 'k: "null"'],
    ["~", 'k: "~"'],
    ["3", 'k: "3"'],
    ["-1.5", 'k: "-1.5"'],
    ["0x1F", 'k: "0x1F"'],
    [".inf", 'k: ".inf"'],
    ["-.Inf", 'k: "-.Inf"'],
    [".nan", 'k: ".nan"'],
    ["", 'k: ""'],
    ["a: b", 'k: "a: b"'],
    ["- x", 'k: "- x"'],
    ["a #b", 'k: "a #b"'],
    [" padded ", 'k: " padded "'],
    ['say "hi"', 'k: say "hi"'],
    ["it's", "k: it's"],
    ["[x]", 'k: "[x]"'],
    ["line\nbreak", 'k: "line\\nbreak"'],
    ["tab\there", 'k: "tab\\there"'],
    ["cr\rhere", 'k: "cr\\rhere"'],
    ["émoji 🍅", "k: émoji 🍅"],
    [3, "k: 3"],
    [0, "k: 0"],
    [-2.5, "k: -2.5"],
    [1e21, "k: 1e+21"],
    [true, "k: true"],
    [false, "k: false"],
    [null, "k:"],
  ])("%j → %s", (value, line) => {
    const out = text(setField(base, "k", value as never));
    expect(out).toBe(`---\n${line}\n---\nbody\n`);
    expect(fm(out).k).toEqual(value);
  });

  it("any string round-trips and stays on its own line", () => {
    const tricky = [
      "key: value", "#", "# x", "x #", "'", '"', "''", "{a}", "[a, b]", "*x", "&a", "!tag", "%x", "@x", "`x`", "|", ">",
      "? x", ", x", "x:", "x :y", "x:y", "Null", "NULL", "TRUE", "False", "0o17", "0b1", "1_000", "+1", ".5", "1.", "1e3",
      "-1e-3", "-", "--", "---", "...", " ", "\\", "a\\nb", "é", "2026-13-45", "12:30", "1:2:3", "~x", "x~", "=",
    ];
    for (const value of tricky) {
      const before = "---\na: 1\nk: old\nz: 2\n---\nbody\n";
      const after = text(setField(before, "k", value));
      expect(changedLines(before, after)).toHaveLength(1);
      expect(fm(after)).toEqual({ a: 1, k: value, z: 2 });
    }
  });

  it.each([NaN, Infinity, -Infinity])("refuses the number %s", (n) => {
    expect(setField(base, "k", n)).toMatchObject({ ok: false, reason: "invalid-value" });
  });

  it.each(["", "a\nb", "a\r\nb"])("refuses the key %j", (key) => {
    expect(setField(base, key, "x")).toMatchObject({ ok: false, reason: "invalid-value" });
  });

  it("quotes a key that would be ambiguous YAML when adding it", () => {
    expect(text(setField(base, "# not a comment", "x"))).toBe('---\nk: old\n"# not a comment": x\n---\nbody\n');
  });
});

describe("lists", () => {
  it("a flow list stays flow", () => {
    const before = fixture("E-029-side-panels.md");
    expect(changedLines(before, text(setField(before, "seams", ["side-panels", "sdk"])))).toEqual([
      ["seams: [side-panels]\n", "seams: [side-panels, sdk]\n"],
    ]);
  });

  it("a block list keeps its item indent; items that need quotes are quoted", () => {
    const before = "---\ntags:\n    - a\n    - b\nnext: 1\n---\n";
    expect(text(setField(before, "tags", ["c", "true", "x: y"]))).toBe('---\ntags:\n    - c\n    - "true"\n    - "x: y"\nnext: 1\n---\n');
  });

  it("an emptied block list collapses to [] (documented exception)", () => {
    expect(text(setField("---\ntags:\n  - a\n---\n", "tags", []))).toBe("---\ntags: []\n---\n");
  });

  it("a list replaces comments between its items (documented exception)", () => {
    expect(text(setField("---\ntags:\n  - a # one\n  # between\n  - b\nz: 1\n---\n", "tags", ["a", "b"]))).toBe("---\ntags:\n  - a\n  - b\nz: 1\n---\n");
  });

  it("a new list key is added in block style; an empty one as []", () => {
    expect(text(setField("---\na: 1\n---\n", "tags", ["x", "y"]))).toBe("---\na: 1\ntags:\n  - x\n  - y\n---\n");
    expect(text(setField("---\na: 1\n---\n", "tags", []))).toBe("---\na: 1\ntags: []\n---\n");
  });

  it("a scalar over a list replaces the whole list", () => {
    expect(text(setField("---\ntags:\n  - a\nz: 1\n---\n", "tags", "none"))).toBe("---\ntags: none\nz: 1\n---\n");
  });

  it("a list over a scalar or a map replaces it with block items", () => {
    expect(text(setField("---\ntags: none # c\n---\n", "tags", ["a"]))).toBe("---\ntags: # c\n  - a\n---\n");
    expect(text(setField("---\ntags:\n  k: v\nz: 1\n---\n", "tags", ["a"]))).toBe("---\ntags:\n  - a\nz: 1\n---\n");
    expect(fm(text(setField("---\ntags: none # c\n---\n", "tags", ["a"]))).tags).toEqual(["a"]);
  });
});

describe("comments, blank lines and complex neighbours stay byte-identical", () => {
  const before = [
    "---",
    "# leading comment",
    "id: T-1  # the id",
    "",
    "status: open   # inline",
    "meta:",
    "  nested: yes",
    "  more: [1, 2]",
    "summary: |",
    "  line one",
    "  line two",
    "# trailing comment",
    "---",
    "",
    "",
    "Body with --- inside",
    "---",
    "",
  ].join("\n");

  it("an inline comment on the edited key is kept, with its spacing", () => {
    expect(changedLines(before, text(setField(before, "status", "done")))).toEqual([["status: open   # inline\n", "status: done   # inline\n"]]);
    expect(changedLines(before, text(setField(before, "id", "T-2")))).toEqual([["id: T-1  # the id\n", "id: T-2  # the id\n"]]);
  });

  it("null clears the value and keeps the comment", () => {
    expect(changedLines(before, text(setField(before, "status", null)))).toEqual([["status: open   # inline\n", "status:   # inline\n"]]);
  });

  it("a scalar over a nested map replaces all of the map's lines", () => {
    expect(text(setField(before, "meta", "flat"))).toBe(before.replace("meta:\n  nested: yes\n  more: [1, 2]\n", "meta: flat\n"));
  });

  it("a new key goes after the last non-blank line of the block", () => {
    expect(text(setField(before, "added", "x"))).toBe(before.replace("# trailing comment\n---\n", "# trailing comment\nadded: x\n---\n"));
  });

  it("removal keeps standalone comments while a key remains", () => {
    expect(text(removeField(before, "summary"))).toBe(before.replace("summary: |\n  line one\n  line two\n", ""));
  });

  it("removing the last key drops the block, its comments, and the blank lines after it", () => {
    const one = "---\n# note\na: 1\n---\n\n\n# Title\n";
    expect(text(removeField(one, "a"))).toBe("# Title\n");
    expect(text(removeField("---\na: 1\n---\n", "a"))).toBe("");
  });
});

describe("line endings", () => {
  it("CRLF: only the edited line changes; the block stays CRLF", () => {
    const before = fixture("E-029-side-panels.md").replace(/\n/g, "\r\n");
    expect(changedLines(before, text(setField(before, "status", "done")))).toEqual([["status: planned\r\n", "status: done\r\n"]]);
    const added = text(setField(before, "owner", "me"));
    expect(added).toContain("source: session-2026-11-09\r\nowner: me\r\n---\r\n");
    expect(added.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("CRLF: removal and matching the editor pipeline", () => {
    const before = "---\r\na: 1\r\nb: 2\r\n---\r\n\r\nbody\r\n";
    expect(text(removeField(before, "a"))).toBe("---\r\nb: 2\r\n---\r\n\r\nbody\r\n");
    expect(text(setField(before, "b", "3x"))).toBe(editorWrite(before, (blk) => setScalarValue(blk, "b", "3x")));
  });

  it("the body's bytes are never touched, even with mixed line endings", () => {
    const before = "---\na: 1\n---\nline\r\nother\nlast\r";
    expect(text(setField(before, "a", 2))).toBe("---\na: 2\n---\nline\r\nother\nlast\r");
    const crlfBlock = "---\r\na: 1\r\n---\r\nlf body\n";
    expect(text(setField(crlfBlock, "a", 2))).toBe("---\r\na: 2\r\n---\r\nlf body\n");
  });

  it("no trailing newline at the end of the file stays that way", () => {
    expect(text(setField("---\na: 1\n---\nbody", "a", 2))).toBe("---\na: 2\n---\nbody");
    expect(text(setField("# no frontmatter", "a", 2))).toBe("---\na: 2\n---\n\n# no frontmatter");
  });
});

describe("empty frontmatter and no frontmatter", () => {
  it("an empty block gets the key", () => {
    expect(text(setField("---\n\n---\n# T\n", "a", "1x"))).toBe("---\na: 1x\n---\n# T\n");
    expect(text(setField("---\n# only a comment\n---\n# T\n", "a", "x"))).toBe("---\n# only a comment\na: x\n---\n# T\n");
  });

  it("removing from an empty block or a file without one changes nothing", () => {
    expect(removeField("---\n\n---\n# T\n", "a")).toEqual({ ok: true, text: "---\n\n---\n# T\n", changed: false });
    expect(removeField("# T\n", "a")).toEqual({ ok: true, text: "# T\n", changed: false });
    expect(removeField("---\na: 1\n---\n", "zzz")).toEqual({ ok: true, text: "---\na: 1\n---\n", changed: false });
  });

  it("no frontmatter: a block is created above the body", () => {
    expect(text(setField("# Title\n\nText\n", "status", "open"))).toBe("---\nstatus: open\n---\n\n# Title\n\nText\n");
    expect(text(setField("", "status", "open"))).toBe("---\nstatus: open\n---\n\n");
    expect(text(setField("# T\r\nx\r\n", "status", "open"))).toBe("---\r\nstatus: open\r\n---\r\n\r\n# T\r\nx\r\n");
    expect(text(setField("# T\n", "tags", ["a"]))).toBe("---\ntags:\n  - a\n---\n\n# T\n");
  });

  it("a file opening with `---` that is not a block is refused, never given a second block", () => {
    expect(setField("---\n---\nx\n", "a", "1x")).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
  });
});

describe("refusals — the file is never written blindly", () => {
  it.each([
    ["invalid YAML", "---\na: [unclosed\n---\nbody\n"],
    ["duplicate keys", "---\na: 1\na: 2\n---\n"],
    ["tab indentation", "---\na:\n\t- x\n---\n"],
    ["a top-level list", "---\n- a\n---\n"],
    ["a top-level scalar", "---\njust text\n---\n"],
    ["an unclosed block", "---\na: 1\nbody\n"],
    ["a block closed at end of file without a newline", "---\na: 1\n---"],
    ["an opening line with trailing spaces", "---  \na: 1\n"],
  ])("%s → unreadable-frontmatter", (_name, before) => {
    expect(setField(before, "a", "x")).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
    expect(removeField(before, "a")).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
  });

  it("a key with no line of its own → unsupported-key", () => {
    const before = '---\n"a:b": 1\nc: 2\n---\n';
    expect(setField(before, "a:b", "x")).toMatchObject({ ok: false, reason: "unsupported-key" });
    expect(removeField(before, "a:b")).toMatchObject({ ok: false, reason: "unsupported-key" });
    expect(text(setField(before, "c", "3x"))).toBe('---\n"a:b": 1\nc: 3x\n---\n');
  });

  it("quoted keys are found by their unquoted name", () => {
    expect(text(setField("---\n'my key': 1\n---\n", "my key", "2x"))).toBe("---\n'my key': 2x\n---\n");
  });
});

describe("splitFrontmatter", () => {
  it("is Pomade's editor split: block plus the blank lines after it", () => {
    expect(splitFrontmatter("---\na: 1\n---\n\n  \nbody")).toEqual({ frontmatter: "---\na: 1\n---\n\n  \n", body: "body" });
    expect(splitFrontmatter("body")).toEqual({ frontmatter: "", body: "body" });
    expect(splitFrontmatter("---\n---\n")).toEqual({ frontmatter: "", body: "---\n---\n" });
  });

  it("agrees with readFrontmatter on what is a block", () => {
    for (const t of ["---\na: 1\n---\n", "---\na: 1\n---", "x\n---\na: 1\n---\n", "---\n\n---\n", "---\n---\n", "--- \na: 1\n---\n"]) {
      const read = readFrontmatter(t);
      const kind = "frontmatterError" in read ? "unclosed" : read.frontmatter === null ? "none" : "block";
      const split = splitFrontmatter(t).frontmatter !== "" ? "block" : getBody(t) === t && setBody(t, "").ok ? "none" : "unclosed";
      expect(split).toBe(kind);
    }
  });
});

describe("getBody / setBody on a real-shaped ticket (comments, quotes, lists, wikilinks, markup)", () => {
  const LF = fixture("T-210-board-drag-mixed.md");
  const CRLF = LF.replace(/\n/g, "\r\n");
  const block = (t: string) => t.slice(0, t.length - getBody(t).length);

  it.each([
    ["LF", LF],
    ["CRLF", CRLF],
  ])("%s: the body starts after the block and its blank line; the block bytes are kept exactly", (_name, before) => {
    const nl = before.includes("\r\n") ? "\r\n" : "\n";
    expect(getBody(before).startsWith(`# T-210 — Board: drag a card to Done${nl}`)).toBe(true);
    expect(block(before).endsWith(`created: 2026-11-10${nl}---${nl}${nl}`)).toBe(true);
    const body = "New body with [[E-030]] and **bold**.\nSecond line, no final newline";
    const after = text(setBody(before, body));
    expect(after).toBe(block(before) + body);
    expect(fm(after)).toEqual(fm(before));
    expect(getBody(after)).toBe(body);
  });

  it("a field write then a body write: each leaves the other's bytes alone", () => {
    const withField = text(setField(LF, "status", "done"));
    expect(changedLines(LF, withField)).toEqual([["status: 'in-progress'   # moved by the Board\n", "status: done   # moved by the Board\n"]]);
    expect(getBody(withField)).toBe(getBody(LF));
    const withBody = text(setBody(withField, "Rewritten.\n"));
    expect(block(withBody)).toBe(block(withField));
  });

  it("CRLF: a field write keeps CRLF in the block and every body byte", () => {
    const after = text(setField(CRLF, "estimate", 5));
    expect(after).toBe(CRLF.replace("estimate: 3\r\n", "estimate: 5\r\n"));
  });

  it("an identical body is no change", () => {
    const r = setBody(LF, getBody(LF));
    expect(r).toEqual({ ok: true, text: LF, changed: false });
  });

  it("a file without frontmatter: the whole text is the body", () => {
    expect(getBody("# Note\n\nText.\n")).toBe("# Note\n\nText.\n");
    expect(text(setBody("# Note\n", "# Other\n"))).toBe("# Other\n");
    expect(text(setBody("", "x"))).toBe("x");
  });

  it("an unclosed --- block is refused (its extent is unknown); getBody shows the whole text", () => {
    const open = "---\nid: T-1\nstatus: open\n\nNo closing line.\n";
    expect(setBody(open, "x")).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
    expect(getBody(open)).toBe(open);
  });

  it("a block with invalid YAML keeps its bytes (the body write does not parse it)", () => {
    const broken = "---\nid: [unclosed\n---\n\nBody.\n";
    expect(text(setBody(broken, "New.\n"))).toBe("---\nid: [unclosed\n---\n\nNew.\n");
  });
});

describe("setKeyLines: one key as its own YAML lines (a mapping)", () => {
  const T210 = fixture("T-210-board-drag-mixed.md");
  const REPEAT = "repeat:\n  every: { week: 1, on: [mon, wed] }\n  start: 2026-11-02";
  const REPEAT2 = "repeat:\n  every: { day: 3 }\n  lead-days: 2";

  /** The text with `key`'s lines cut out — what must stay byte-identical. */
  function without(t: string, lines: string): string {
    expect(t).toContain(lines);
    return t.replace(lines, "");
  }

  it("adds a mapping at the end of the block; every other byte stays; reads back", () => {
    const after = text(setKeyLines(T210, "repeat", REPEAT));
    expect(without(after, `${REPEAT}\n`)).toBe(T210);
    expect(after.indexOf(REPEAT)).toBe(T210.indexOf("---\n\n# T-210"));
    expect(fm(after)).toEqual({ ...fm(T210), repeat: { every: { week: 1, on: ["mon", "wed"] }, start: "2026-11-02" } });
  });

  it("replaces a mapping's lines in place; other keys, comments and the body are byte-identical", () => {
    const withRepeat = text(setKeyLines(T210, "repeat", REPEAT));
    const replaced = text(setKeyLines(withRepeat, "repeat", REPEAT2));
    expect(replaced).toBe(withRepeat.replace(REPEAT, REPEAT2));
    expect(fm(replaced).repeat).toEqual({ every: { day: 3 }, "lead-days": 2 });
    expect(setKeyLines(replaced, "repeat", REPEAT2)).toEqual({ ok: true, text: replaced, changed: false });
  });

  it("replaces a key in the middle — a block list becomes a mapping; the keys around it keep their bytes", () => {
    const seams = "seams:\n  - workspace-data\n  - frontmatter-write   # the kit's block";
    const lines = "seams:\n  data: workspace-data   # one seam per area\n  write: frontmatter-write";
    const after = text(setKeyLines(T210, "seams", lines));
    expect(after).toBe(T210.replace(seams, lines));
    expect(fm(after)).toEqual({ ...fm(T210), seams: { data: "workspace-data", write: "frontmatter-write" } });
  });

  it.each(FIXTURES)("%s: a mapping set then replaced round-trips; every other key reads back and keeps its bytes", (name) => {
    const before = fixture(name);
    const set = text(setKeyLines(before, "schedule", "schedule:\n  once: 2026-12-01"));
    const replaced = text(setKeyLines(set, "schedule", "schedule:\n  every: { month: 1 }\n  end: 2027-06-30"));
    expect(without(replaced, "schedule:\n  every: { month: 1 }\n  end: 2027-06-30\n")).toBe(before);
    expect(fm(replaced)).toEqual({ ...fm(before), schedule: { every: { month: 1 }, end: "2027-06-30" } });
  });

  it("CRLF: the lines are written with the file's CRLF; given CRLF or a trailing line break, the same", () => {
    const CRLF = T210.replace(/\n/g, "\r\n");
    const after = text(setKeyLines(CRLF, "repeat", `${REPEAT}\n`));
    expect(after).toBe(text(setKeyLines(T210, "repeat", REPEAT)).replace(/\n/g, "\r\n"));
    expect(text(setKeyLines(T210, "repeat", REPEAT.replace(/\n/g, "\r\n")))).toBe(text(setKeyLines(T210, "repeat", REPEAT)));
  });

  it("a file without frontmatter gets a block on top", () => {
    expect(text(setKeyLines("# Note\n", "repeat", REPEAT))).toBe(`---\n${REPEAT}\n---\n\n# Note\n`);
  });

  it("refuses text that is not exactly the key's own valid lines; nothing changes", () => {
    for (const bad of [
      "other:\n  a: 1",                   // another key
      "  repeat:\n  a: 1",                // not at column 0
      "repeat:\n  a: 1\nextra: 2",        // a second key
      "repeat:\n  a: 1\n\n  b: 2",        // a blank line would end the key's lines
      "repeat:\n  a: [1",                 // invalid YAML
      "repeat:\n  a: 1\n  a: 2",          // a duplicate nested key
    ]) {
      expect(setKeyLines(T210, "repeat", bad), bad).toMatchObject({ ok: false, reason: "invalid-value" });
    }
    expect(setKeyLines(T210, "", "x: 1")).toMatchObject({ ok: false, reason: "invalid-value" });
  });

  it("refuses an unreadable block and a key with no line of its own, as setField does", () => {
    expect(setKeyLines("---\nid: [x\n---\n", "repeat", REPEAT)).toMatchObject({ ok: false, reason: "unreadable-frontmatter" });
    expect(setKeyLines("---\n? repeat\n: 1\n---\n", "repeat", REPEAT)).toMatchObject({ ok: false, reason: "unsupported-key" });
  });
});
