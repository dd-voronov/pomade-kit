import { describe, expect, it } from "vitest";
import {
  SOCKET_PATH_MAX_BYTES,
  createLineDecoder,
  encodeLine,
  parseHostRecord,
  socketPathProblem,
} from "./index.js";

describe("socket framing", () => {
  it("one JSON message per line, split across chunks", () => {
    const d = createLineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(d.push(':2}\n\n{"c":"x\\ny"}\n')).toEqual([{ b: 2 }, { c: "x\ny" }]);
    expect(d.push("")).toEqual([]);
  });

  it("a line over many chunks, and a large one in linear time", () => {
    const d = createLineDecoder();
    expect(d.push('{"s":"')).toEqual([]);
    expect(d.push("ab")).toEqual([]);
    expect(d.push('c"}\n{"t":1}')).toEqual([{ s: "abc" }]);
    expect(d.push("\n")).toEqual([{ t: 1 }]);
    // 12 MiB in 8 KiB chunks, as a socket delivers it: each chunk is searched once, not the whole buffer again.
    const big = "x".repeat(12 * 1024 * 1024);
    const text = `{"big":"${big}"}\n`;
    const started = performance.now();
    const out: unknown[] = [];
    for (let i = 0; i < text.length; i += 8192) out.push(...d.push(text.slice(i, i + 8192)));
    expect(out).toEqual([{ big }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("skips lines that are not JSON", () => {
    const d = createLineDecoder();
    expect(d.push('nope\n{"ok":true}\n{bad\n')).toEqual([{ ok: true }]);
  });

  it("a line longer than the limit throws", () => {
    const d = createLineDecoder(8);
    expect(d.push('{"a":1}\n')).toEqual([{ a: 1 }]);
    expect(() => d.push('{"long":"xx')).toThrow(/longer than 8 bytes/);
  });

  it("encodeLine round-trips through the decoder", () => {
    const msg = { channel: "pomade", type: "call", id: "1", method: "host.info", params: { s: "a\nb ünïcode" } };
    expect(createLineDecoder().push(encodeLine(msg))).toEqual([msg]);
    expect(encodeLine(msg).endsWith("\n")).toBe(true);
    expect(encodeLine(msg).slice(0, -1).includes("\n")).toBe(false);
  });
});

describe("socketPathProblem", () => {
  it("accepts a path of up to 103 bytes, counting UTF-8 bytes", () => {
    expect(socketPathProblem("/" + "a".repeat(SOCKET_PATH_MAX_BYTES - 1))).toBeNull();
    expect(socketPathProblem("/" + "a".repeat(SOCKET_PATH_MAX_BYTES))).toMatch(/104 bytes; macOS allows at most 103/);
    // 2 bytes per "é": 52 × 2 = 104 bytes in 52 characters.
    expect(socketPathProblem("é".repeat(52))).toMatch(/104 bytes/);
  });
});

describe("parseHostRecord", () => {
  it("reads a well-formed record", () => {
    const r = { socket: "/s", launch: { argv: ["/bin/app", "--x"], env: { NODE_ENV: "test" } } };
    expect(parseHostRecord(JSON.stringify(r))).toEqual(r);
  });

  it("null for anything else", () => {
    for (const bad of [
      "{",
      "null",
      "[]",
      JSON.stringify({ launch: { argv: ["/a"], env: {} } }),
      JSON.stringify({ socket: "/s" }),
      JSON.stringify({ socket: "/s", launch: { argv: [], env: {} } }),
      JSON.stringify({ socket: "/s", launch: { argv: [1], env: {} } }),
      JSON.stringify({ socket: "/s", launch: { argv: ["/a"], env: { A: 1 } } }),
      JSON.stringify({ socket: "/s", launch: { argv: ["/a"] } }),
    ]) {
      expect(parseHostRecord(bad)).toBeNull();
    }
  });
});
