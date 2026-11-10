// The block core beyond the editor suite: scalar emission of characters a plain YAML scalar
// cannot carry. Every writer the editor uses must leave a block that still parses and reads the
// value back unchanged.

import { describe, expect, it } from "vitest";
import { readFrontmatter } from "../protocol/frontmatter.js";
import { addProperty, emitScalar, parseFrontmatter, setListValue, setScalarValue } from "./block.js";
import { setField } from "./file.js";

const CONTROL_VALUES: [name: string, value: string][] = [
  ["NUL", "a\u0000b"],
  ["SOH", "a\u0001b"],
  ["BEL", "a\u0007b"],
  ["backspace", "a\bb"],
  ["tab", "a\tb"],
  ["line feed", "a\nb"],
  ["vertical tab", "a\u000bb"],
  ["form feed", "a\fb"],
  ["carriage return", "a\rb"],
  ["CRLF", "a\r\nb"],
  ["escape", "a\u001b[0mb"],
  ["unit separator", "a\u001fb"],
  ["DEL", "a\u007fb"],
  ["C1 control", "a\u0090b"],
  ["NEL", "a\u0085b"],
  ["U+FFFE", "a￾b"],
  ["U+FFFF", "a￿b"],
  ["lone high surrogate", "a\ud800b"],
  ["lone low surrogate", "a\udc00b"],
  ["only a control character", "\u0001"],
  ["leading control character", "\u0001abc"],
  ["trailing line feed", "abc\n"],
];

const BLOCK = "---\ntitle: Hello\nstatus: open\n---\n";

/** The block read the way Pomade and the fake host read frontmatter. */
function read(block: string): Record<string, unknown> {
  const r = readFrontmatter(block);
  if (!("frontmatter" in r) || r.frontmatter === null) throw new Error(`unreadable: ${JSON.stringify(r)}`);
  return r.frontmatter;
}

describe("emitScalar — control characters", () => {
  it.each(CONTROL_VALUES)("%s: double-quoted (JSON)", (_name, value) => {
    expect(emitScalar(value)).toBe(JSON.stringify(value));
  });

  it.each(CONTROL_VALUES)("%s: the emitted scalar stays on one line", (_name, value) => {
    expect(emitScalar(value)).not.toMatch(/[\n\r]/);
  });

  it.each([
    ["plain word", "hello"],
    ["inner space", "a b"],
    ["date", "2026-11-09"],
    ["non-breaking space", "a b"],
    ["line separator", "a b"],
    ["emoji (surrogate pair)", "a😀b"],
    ["CJK", "日本語"],
  ])("%s stays plain", (_name, value) => {
    expect(emitScalar(value)).toBe(value);
  });
});

describe("writers keep the block readable with control characters", () => {
  it.each(CONTROL_VALUES)("setScalarValue %s", (_name, value) => {
    const out = setScalarValue(BLOCK, "status", value);
    expect(parseFrontmatter(out).ok).toBe(true);
    expect(read(out)).toEqual({ title: "Hello", status: value });
  });

  it.each(CONTROL_VALUES)("addProperty %s", (_name, value) => {
    const out = addProperty(BLOCK, "note", value);
    expect(read(out)).toEqual({ title: "Hello", status: "open", note: value });
  });

  it.each(CONTROL_VALUES)("setListValue %s", (_name, value) => {
    const out = setListValue("---\ntitle: Hello\ntags:\n  - x\n---\n", "tags", ["x", value]);
    expect(read(out)).toEqual({ title: "Hello", tags: ["x", value] });
  });

  it.each(CONTROL_VALUES)("setField %s (the file writer agrees with the editor)", (_name, value) => {
    const r = setField(`${BLOCK}\nbody\n`, "status", value);
    expect(r.ok && r.text).toBe(`---\ntitle: Hello\nstatus: ${JSON.stringify(value)}\n---\n\nbody\n`);
    expect(r.ok && read(r.text)).toEqual({ title: "Hello", status: value });
  });

  it("only the edited line changes", () => {
    expect(setScalarValue(BLOCK, "status", "a\nb")).toBe('---\ntitle: Hello\nstatus: "a\\nb"\n---\n');
  });
});
