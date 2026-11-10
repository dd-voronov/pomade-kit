// Pomade-wide shortcuts (HOST-API §1 `shortcuts`): the key chord format apps declare, and how a
// keydown is matched against a chord. Shared by Pomade (dispatch, conflicts) and the fake host.

/** A key chord: Cmd held, optionally Ctrl / Alt / Shift, and one letter or digit. */
export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** "A"–"Z" or "0"–"9". */
  key: string;
  /** The physical key (`KeyboardEvent.code`): "KeyA"…, "Digit0"…. Matching is layout-independent. */
  code: string;
}

/** What `chordMatches` reads from a keydown. */
export interface ChordEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** How the format reads in an error message. */
export const CHORD_FORMAT = "Cmd, then any of Ctrl, Alt, Shift, then one letter or digit, joined by + (Cmd+Shift+K)";

const MODIFIERS = ["cmd", "ctrl", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Parse a chord such as `Cmd+Shift+K` (case-insensitive, spaces around `+` allowed); `null` when it is not one. */
export function parseChord(text: unknown): Chord | null {
  if (typeof text !== "string") return null;
  const tokens = text.split("+").map((t) => t.trim());
  if (tokens.length < 2 || tokens.some((t) => t === "")) return null;
  const last = tokens[tokens.length - 1]!.toUpperCase();
  if (!/^[A-Z0-9]$/.test(last)) return null;
  const held = new Set<Modifier>();
  for (const token of tokens.slice(0, -1)) {
    const m = token.toLowerCase() as Modifier;
    if (!MODIFIERS.includes(m) || held.has(m)) return null;
    held.add(m);
  }
  if (!held.has("cmd")) return null;
  return {
    ctrl: held.has("ctrl"),
    alt: held.has("alt"),
    shift: held.has("shift"),
    key: last,
    code: /[0-9]/.test(last) ? `Digit${last}` : `Key${last}`,
  };
}

/** The canonical spelling: `Cmd+Ctrl+Alt+Shift+K`, with only the modifiers held. */
export function formatChord(chord: Chord): string {
  return ["Cmd", chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", chord.key].filter(Boolean).join("+");
}

/** True when the keydown is exactly this chord: the same physical key and exactly these modifiers. */
export function chordMatches(chord: Chord, e: ChordEvent): boolean {
  return (
    e.metaKey &&
    e.code === chord.code &&
    e.ctrlKey === chord.ctrl &&
    e.altKey === chord.alt &&
    e.shiftKey === chord.shift
  );
}
