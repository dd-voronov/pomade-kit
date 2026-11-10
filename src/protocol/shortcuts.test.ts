import { describe, expect, it } from "vitest";
import { chordMatches, formatChord, parseChord, type ChordEvent } from "./shortcuts.js";

const ev = (code: string, mods: Partial<Omit<ChordEvent, "code">> = {}): ChordEvent => ({
  code,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("parseChord / formatChord", () => {
  it.each<[string, string, string]>([
    ["Cmd+K", "Cmd+K", "KeyK"],
    ["cmd+k", "Cmd+K", "KeyK"],
    ["Cmd + Shift + k", "Cmd+Shift+K", "KeyK"],
    ["Shift+Cmd+K", "Cmd+Shift+K", "KeyK"],
    ["Alt+Shift+Ctrl+Cmd+Z", "Cmd+Ctrl+Alt+Shift+Z", "KeyZ"],
    ["CMD+ALT+1", "Cmd+Alt+1", "Digit1"],
    ["Cmd+0", "Cmd+0", "Digit0"],
  ])("%j → %s (%s)", (text, canonical, code) => {
    const chord = parseChord(text);
    expect(chord && formatChord(chord)).toBe(canonical);
    expect(chord?.code).toBe(code);
  });

  it.each([
    "",
    "K",
    "Cmd",
    "Cmd+",
    "+K",
    "Cmd++K",
    "Ctrl+K",
    "Alt+Shift+K",
    "Cmd+Cmd+K",
    "Cmd+Meta+K",
    "Cmd+Option+K",
    "Command+K",
    "Cmd+KK",
    "Cmd+Enter",
    "Cmd+F1",
    "Cmd+,",
    "Cmd+K+Shift",
    "Cmd+é",
  ])("refuses %j", (text) => {
    expect(parseChord(text)).toBeNull();
  });

  it.each([undefined, null, 3, ["Cmd", "K"]])("refuses a non-string (%j)", (v) => {
    expect(parseChord(v)).toBeNull();
  });
});

describe("chordMatches", () => {
  const chord = parseChord("Cmd+Shift+K")!;

  it("matches the physical key with exactly the chord's modifiers", () => {
    expect(chordMatches(chord, ev("KeyK", { shiftKey: true }))).toBe(true);
  });

  it.each<[string, ChordEvent]>([
    ["Cmd not held", ev("KeyK", { metaKey: false, shiftKey: true })],
    ["Shift missing", ev("KeyK")],
    ["Ctrl extra", ev("KeyK", { shiftKey: true, ctrlKey: true })],
    ["Alt extra", ev("KeyK", { shiftKey: true, altKey: true })],
    ["another key", ev("KeyJ", { shiftKey: true })],
    ["Ctrl instead of Cmd", ev("KeyK", { metaKey: false, ctrlKey: true, shiftKey: true })],
  ])("no match: %s", (_label, e) => {
    expect(chordMatches(chord, e)).toBe(false);
  });

  it("is layout-independent: reads code, not key", () => {
    expect(chordMatches(parseChord("Cmd+1")!, ev("Digit1"))).toBe(true);
    expect(chordMatches(parseChord("Cmd+1")!, ev("Numpad1"))).toBe(false);
  });
});
