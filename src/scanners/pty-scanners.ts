// The two chunk-split-safe scanners over a terminal's output stream: shell markers (exec /
// prompt) and attention signals (bell, notification sequences).
//
// Both are parser state machines that persist across the arbitrary chunk boundaries a pty hands
// over: a marker (or an OSC/BEL) can be split across two reads, and each must be recognised
// exactly once. Each scanner is a pure recogniser — it feeds on `data` chunks and emits typed
// events through a handler passed at construction; every side effect stays with the caller.
// Within a chunk each scanner emits in strict byte order.

// ─── OSC 7879 marker protocol ────────────────────────────────────────────────────────────────
// Pomade's shimmed `zsh -il` prints invisible OSC 7879 markers from its precmd/preexec hooks:
// precmd → `pomade:prompt;<cwd>` (a prompt was drawn; carries $PWD), preexec →
// `pomade:exec;<cmdline>` (a command is about to run). The payload-less `pomade:prompt` is
// accepted too: a pty spawned by an older Pomade, or a stale ZDOTDIR copy, can outlive an upgrade.
const OSC_MARK_PREFIX = "\x1b]7879;";
const OSC_MARK_END = "\x07";
const MARK_PROMPT = "pomade:prompt";
const MARK_PROMPT_CWD = "pomade:prompt;";
const MARK_EXEC = "pomade:exec;";
// Longest partial marker carried across a chunk split: prefix + payload + terminator. Sized off
// the longer payload — a prompt's $PWD up to PATH_MAX (1024 on macOS) or an exec line up to the
// shim's 500-byte cap — with headroom. A split marker longer than this is dropped rather than
// buffered without bound.
const MARK_CARRY_MAX = 2048;

/** A framed, classified OSC 7879 marker. `exec` — a command is about to run (payload = the
 *  command line). `prompt` — the shell drew a prompt (`cwd` = the reported $PWD, or null when
 *  the payload-less `pomade:prompt` form is seen). Markers that are neither are dropped. */
export type MarkerEvent = { kind: "exec"; command: string } | { kind: "prompt"; cwd: string | null };

/** Frames OSC 7879 markers out of the pty output stream and classifies each into a MarkerEvent.
 *  `carry` holds a possibly marker-splitting tail across data chunks so every marker is seen
 *  exactly once. */
export class MarkerScanner {
  private carry = "";

  constructor(private readonly onMarker: (event: MarkerEvent) => void) {}

  push(data: string): void {
    let buf = this.carry + data;
    for (;;) {
      const start = buf.indexOf(OSC_MARK_PREFIX);
      if (start === -1) {
        this.carry = buf.slice(-(OSC_MARK_PREFIX.length - 1));
        return;
      }
      const end = buf.indexOf(OSC_MARK_END, start + OSC_MARK_PREFIX.length);
      if (end === -1) {
        // Marker started but its terminator hasn't streamed yet — carry it (bounded).
        this.carry = buf.length - start > MARK_CARRY_MAX ? "" : buf.slice(start);
        return;
      }
      this.classify(buf.slice(start + OSC_MARK_PREFIX.length, end));
      buf = buf.slice(end + 1);
    }
  }

  private classify(payload: string): void {
    if (payload.startsWith(MARK_EXEC)) {
      this.onMarker({ kind: "exec", command: payload.slice(MARK_EXEC.length) });
    } else if (payload === MARK_PROMPT || payload.startsWith(MARK_PROMPT_CWD)) {
      // The payload-less form (and an empty `$PWD`) reports cwd null, so the caller keeps the last
      // known cwd rather than blanking it.
      this.onMarker({
        kind: "prompt",
        cwd: payload.length > MARK_PROMPT_CWD.length ? payload.slice(MARK_PROMPT_CWD.length) : null,
      });
    }
  }
}

// ─── Attention scanner ───────────────────────────────────────────────────────────────────────
// A separate pass over the same output stream as the 7879 marker scanner (they never interfere:
// this one classifies 7879 as an ignored OSC, and it recognises every OSC terminator so the
// shim's own BELs are never seen as standalone):
//   • standalone BEL (0x07) outside any OSC  → attention (Apple_Terminal / claude bell)
//   • OSC 9 / 99 / 777 notification sequences → attention (iTerm2 / kitty / urxvt styles)
//   • OSC 0 / 1 / 2 (window/icon title) and OSC 7879 (Pomade's shim) → not attention
// An OSC starts with ESC ] and ends with BEL (0x07) or ST (ESC \). The state is tracked so a BEL
// that merely terminates an OSC (title or notification) is never miscounted as a standalone bell.
const NOTIFY_PARAMS = new Set(["9", "99", "777"]);

/** Recognises the attention signals in the pty output stream and calls `onAttention` once per
 *  signal, in byte order, across arbitrary chunk boundaries. */
export class AttentionScanner {
  private state: "normal" | "esc" | "osc" | "oscEsc" = "normal";
  private oscParam = ""; // leading digits after ESC ] (the OSC number), until the first ';'
  private oscParamDone = false;

  constructor(private readonly onAttention: () => void) {}

  push(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      switch (this.state) {
        case "normal":
          if (c === 0x1b) this.state = "esc";
          else if (c === 0x07) this.onAttention(); // standalone BEL
          break;
        case "esc":
          if (c === 0x5d) {
            // ESC ] — an OSC opens.
            this.state = "osc";
            this.oscParam = "";
            this.oscParamDone = false;
          } else if (c !== 0x1b) {
            // Any other escape (CSI etc.); BEL is not its terminator, so back to normal.
            this.state = "normal";
          }
          break;
        case "osc":
          if (c === 0x07) this.endOsc();
          else if (c === 0x1b) this.state = "oscEsc";
          else if (c === 0x3b) this.oscParamDone = true; // ';' — OSC number fully read
          else if (!this.oscParamDone && c >= 0x30 && c <= 0x39) this.oscParam += String.fromCharCode(c);
          break;
        case "oscEsc":
          if (c === 0x5c) this.endOsc(); // ESC \ = ST terminates the OSC
          else if (c !== 0x1b) this.state = "osc"; // spurious ESC inside the OSC payload
          break;
      }
    }
  }

  private endOsc(): void {
    if (NOTIFY_PARAMS.has(this.oscParam)) this.onAttention();
    this.state = "normal";
  }
}
