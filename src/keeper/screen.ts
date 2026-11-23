// A session's terminal of record: a headless xterm that parses every byte the program writes,
// answers the program's terminal queries, and serializes its screen for an attaching client.
// The xterm line and its Unicode 11 width tables match Pomade's renderer, so the keeper and the
// tab agree on every cell.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type HeadlessModule = typeof import("@xterm/headless");
export type HeadlessTerminal = InstanceType<HeadlessModule["Terminal"]>;

interface Addon {
  activate(terminal: unknown): void;
  dispose(): void;
}
interface SerializeAddon extends Addon {
  serialize(options?: { scrollback?: number }): string;
}

const { Terminal } = require("@xterm/headless") as HeadlessModule;
const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: new () => SerializeAddon };
const { Unicode11Addon } = require("@xterm/addon-unicode11") as { Unicode11Addon: new () => Addon };

/** The parts of xterm's core the serialize addon leaves out and a TUI relies on afterwards.
 *  Private API, pinned with the xterm version. */
interface CoreState {
  buffer: { scrollTop: number; scrollBottom: number; x: number; y: number };
  coreMouseService: { activeEncoding: string };
  coreService: { isCursorHidden: boolean };
}

/** Mouse encodings and the DECSET that selects each (DEFAULT has none). */
const MOUSE_ENCODING_MODE: Readonly<Record<string, number>> = { SGR: 1006, URXVT: 1015, UTF8: 1005, SGR_PIXELS: 1016 };

export class Screen {
  readonly term: HeadlessTerminal;
  private readonly serializer: SerializeAddon;
  /** The window title the program set last (OSC 0 / 2); `""` when it set none. */
  private windowTitle = "";

  constructor(cols: number, rows: number, scrollback: number) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.onTitleChange((title) => {
      this.windowTitle = title;
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = "11";
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** True while the program asked for bracketed paste. */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  write(data: string, parsed?: () => void): void {
    this.term.write(data, parsed);
  }

  /** Resolves once everything written so far is parsed. */
  settled(): Promise<void> {
    return new Promise((resolve) => this.term.write("", resolve));
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** What the program's queries are answered with (cursor position, device attributes, …). */
  onAnswer(cb: (data: string) => void): void {
    this.term.onData(cb);
  }

  /**
   * The screen as escape sequences: drawn into an empty terminal of the same size it reproduces
   * the scrollback, the screen (normal or alternate), colours, cursor, modes, scroll region, mouse
   * encoding, cursor visibility and, last, the window title the program set (OSC 2), so a reader
   * of the title — an agent scanner — learns it with the screen. It contains no question, so
   * drawing it makes the terminal answer nothing. Call after `settled()`.
   */
  serialize(scrollback?: number): string {
    let out = this.serializer.serialize(scrollback === undefined ? {} : { scrollback });
    const core = (this.term as unknown as { _core: CoreState })._core;
    const b = core.buffer;
    if (b.scrollTop !== 0 || b.scrollBottom !== this.term.rows - 1) {
      // DECSTBM homes the cursor: put it back with an absolute move (not DECSC/DECRC, which would
      // overwrite the program's own saved cursor). Origin mode is not serialized, so it is off.
      out += `\x1b[${b.scrollTop + 1};${b.scrollBottom + 1}r\x1b[${b.y + 1};${b.x + 1}H`;
    }
    const mode = MOUSE_ENCODING_MODE[core.coreMouseService.activeEncoding];
    if (mode !== undefined) out += `\x1b[?${mode}h`;
    if (core.coreService.isCursorHidden) out += "\x1b[?25l";
    // The parsed title holds no BEL or ESC (they end the OSC); C0/C1 controls are dropped all the same.
    const title = this.windowTitle.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (title !== "") out += `\x1b]2;${title}\x07`;
    return out;
  }

  dispose(): void {
    this.term.dispose();
  }
}
