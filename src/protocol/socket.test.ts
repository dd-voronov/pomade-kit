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
