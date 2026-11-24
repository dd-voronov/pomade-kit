// What an agent CLI in a terminal is doing — working on a turn, idle (with or without background
// work still going), or waiting for the user at a permission, folder-trust or background-work
// prompt — read from its output stream.
//
// claude and codex are full-screen TUIs with diff renderers: they send only the cells that
// changed and position words with cursor moves, so a prompt's text is not reliably present as a
// substring of the stream (a word redrawn over a matching cell arrives in pieces). The scanner
// therefore replays the stream into a headless terminal of the pty's size and reads what is on
// screen, plus the window title, which both CLIs use as a status line:
//
//   claude   working — title starts with a spinner glyph ◐ ◓ ◑ ◒; idle — title starts with ✳,
//            with background work going while the footer (the last non-blank row) counts it:
//            "⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage".
//            waiting — a dialog on screen: "Do you want to …" / "❯ 1. Yes" / "Esc to cancel"
//            (permission), "Yes, I trust this folder" / "Enter to confirm · Esc to cancel"
//            (trust), or "Background work is running" / "❯ 1. …" / "Enter to confirm · Esc to
//            cancel" (background: an exit asked while background work goes). The title stays ✳
//            while a dialog is up.
//   codex    working — title starts with a braille spinner (U+2800–U+28FF); idle — any other
//            non-empty title, once a spinner has been seen (the title format is configurable in
//            codex; without the spinner item the state stays unknown). waiting — title "[ ! ] Action Required | …" (blinks with "[ . ]"),
//            or the approval dialog "› 1. Yes, proceed" / "Press enter to confirm or esc to
//            cancel" on screen; trust — "› 1. Yes,
//            continue" / "Press enter to continue". Background work is never read: idle is
//            always without it.
//
// A dialog counts only while its footer is the last non-blank row on screen: that is where both
// CLIs draw a live prompt, and it keeps transcript text that merely quotes a prompt (with the
// composer and status rows below it) from reading as one. A waiting state carries the dialog's
// rows as the screen shows them, from its top — claude: the row under the rule that opens the
// dialog; codex: its first question row — down to the footer. A wait is reported when it starts,
// and once more when its rows first show (codex's title may say it waits before the dialog is
// drawn); a redraw of the same dialog (the selection moved) only updates `state`.
//
// Background work is read from claude's footer, not from the turn's closing line ("✻ Cooked for
// 4s · done 10:14 PM · 1 shell still running"): the closing line is transcript text written when
// the turn ends — later turns leave it above their own — and the command menu covers it while a
// command is typed; the footer's count is claude's live status of that work.
//
// Idle is reported only once it has held for `idleAfterMs`: claude sets its idle title a few
// milliseconds before it draws a permission dialog, and a consumer that acts on idle (ending an
// unattended run) must never see that flash. A change of `background` while idle is reported
// once it, too, has held for `idleAfterMs`, and idle is reported with the screen's latest: a read
// can end in the middle of the footer's redraw (claude drops the dialog after Esc and draws the
// footer's count 11 ms later).
// Working and waiting are reported at once.
//
// Probe evidence (claude 2.1.321 and 2.1.331, codex-cli 0.153.2) is in ./fixtures; the
// provenance of each capture is recorded in the fixture itself.

import { Terminal } from "./xterm-headless.js";

export type AgentKind = "claude" | "codex";

/** What the agent waits for: approval of a tool call, trust for the folder it started in, or
 *  (`background`) the choice what to do with its background work when an exit is asked while
 *  that work goes. */
export type AgentPrompt = "permission" | "trust" | "background";

/** `unknown` until the output says otherwise (before the first title, or under a title format the
 *  scanner does not read). `idle.background`: the screen says the agent's background work is still
 *  going — its turn is over, its job may not be. `waiting.lines`: the prompt as the screen shows
 *  it — the dialog's rows from its top to its footer, right-trimmed, their common indent removed;
 *  `[]` while only the title says the agent waits (codex's "Action Required"). */
export type AgentState =
  | { kind: "working" }
  | { kind: "idle"; background: boolean }
  | { kind: "waiting"; prompt: AgentPrompt; lines: string[] }
  | { kind: "unknown" };

export interface AgentStateScannerOptions {
  agent: AgentKind;
  /** The pty's size; keep it in step with `resize`. */
  cols: number;
  rows: number;
  /** How long idle must hold before it is reported. Default 500 ms. */
  idleAfterMs?: number;
}

interface Dialog {
  prompt: AgentPrompt;
  /** The last non-blank row on screen. */
  footer: RegExp;
  /** A row above the footer. */
  option: RegExp;
  /** A row above the option row, when the dialog has a fixed question. */
  question?: RegExp;
  /** Where the dialog's text begins: the nearest row above the option row that matches — the row
   *  itself, or (`below`) the row under it. None found: the option row. */
  top: { row: RegExp; below: boolean };
}

interface AgentRules {
  dialogs: readonly Dialog[];
  /** `sawWorking`: a working title has been seen in this session. An idle state it gives is
   *  without background work; the screen's `background` decides. */
  fromTitle(title: string, sawWorking: boolean): AgentState | null;
  /** The footer (the last non-blank row, trimmed) says background work is going. */
  background(footer: string): boolean;
}

const CLAUDE_SPINNER = new Set(["◐", "◓", "◑", "◒"]);
const CLAUDE_IDLE = "✳";
const CODEX_ACTION_REQUIRED = /^\[ [!.] \] Action Required\b/;
/** The full-width rule claude draws over its dialogs. */
const CLAUDE_RULE = { row: /^─{8,}$/, below: true };
/** The footer's count of background shells: an item of its "·"-separated hints. */
const CLAUDE_BACKGROUND = /(?:^|· )\d+ shells?(?= ·| {2}|$)/;

const RULES: Record<AgentKind, AgentRules> = {
  claude: {
    dialogs: [
      { prompt: "permission", footer: /^Esc to cancel\b/, option: /^(?:❯\s*)?1\.\s+Yes\b/, question: /^(?:Do you want|Would you like)\b/, top: CLAUDE_RULE },
      { prompt: "trust", footer: /^Enter to confirm · Esc to cancel$/, option: /^(?:❯\s*)?Yes, I trust this folder$/, top: CLAUDE_RULE },
      {
        prompt: "background",
        footer: /^Enter to confirm · Esc to cancel$/,
        option: /^(?:❯\s*)?1\.\s/,
        question: /^Background work is running$/,
        top: { row: /^▔{8,}$/, below: true },
      },
    ],
    fromTitle(title) {
      const first = [...title][0];
      if (first === undefined) return null;
      if (CLAUDE_SPINNER.has(first)) return { kind: "working" };
      if (first === CLAUDE_IDLE) return { kind: "idle", background: false };
      return null;
    },
    background: (footer) => CLAUDE_BACKGROUND.test(footer),
  },
  codex: {
    dialogs: [
      {
        prompt: "permission",
        footer: /^Press enter to confirm or esc to cancel$/,
        option: /^(?:›\s*)?1\.\s+Yes, proceed\b/,
        top: { row: /^(?:Would you like|Do you want|Allow)\b/, below: false },
      },
      { prompt: "trust", footer: /^Press enter to continue$/, option: /^(?:›\s*)?1\.\s+Yes, continue$/, top: { row: /^> You are in\b/, below: false } },
    ],
    fromTitle(title, sawWorking) {
      if (title === "") return null;
      if (CODEX_ACTION_REQUIRED.test(title)) return { kind: "waiting", prompt: "permission", lines: [] };
      const first = title.codePointAt(0) ?? 0;
      if (first >= 0x2800 && first <= 0x28ff) return { kind: "working" };
      return sawWorking ? { kind: "idle", background: false } : null;
    },
    background: () => false,
  },
};

function sameState(a: AgentState, b: AgentState): boolean {
  if (a.kind === "waiting") return b.kind === "waiting" && a.prompt === b.prompt;
  if (a.kind === "idle") return b.kind === "idle" && a.background === b.background;
  return a.kind === b.kind;
}

/** The index of the last row with text on it; -1 for none. */
function lastNonBlank(rows: string[]): number {
  let y = rows.length - 1;
  while (y >= 0 && rows[y]?.trim() === "") y--;
  return y;
}

/** Rows right-trimmed, without the indent they all share (blank rows aside). */
function dedent(rows: string[]): string[] {
  const indents = rows.filter((row) => row !== "").map((row) => row.length - row.trimStart().length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return rows.map((row) => row.slice(common));
}

/**
 * Tracks an agent CLI's state from its terminal output and calls `onState` on every change, in
 * output order. Feed it every chunk with `push`, keep its size in step with the pty through
 * `resize`, and `dispose` it when the agent exits — after an exit the screen keeps whatever the
 * CLI left on it.
 *
 * Events are asynchronous: a chunk is evaluated once the headless terminal has parsed it, and
 * idle once it has held for `idleAfterMs`. `settled()` resolves when everything pushed so far has
 * been evaluated.
 */
export class AgentStateScanner {
  private readonly term: Terminal;
  private readonly rules: AgentRules;
  private title = "";
  private titlesInChunk: string[] = [];
  private sawWorking = false;
  private current: AgentState = { kind: "unknown" };
  private readonly idleAfterMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The idle state the running `idleTimer` reports: the screen's latest. */
  private pendingIdle: AgentState = { kind: "idle", background: false };

  constructor(
    options: AgentStateScannerOptions,
    private readonly onState: (state: AgentState) => void,
  ) {
    this.rules = RULES[options.agent];
    this.idleAfterMs = options.idleAfterMs ?? 500;
    // `buffer` (the screen read below) is a proposed API in the headless build.
    this.term = new Terminal({ cols: options.cols, rows: options.rows, scrollback: 0, allowProposedApi: true });
    this.term.onTitleChange((title) => {
      this.title = title;
      this.titlesInChunk.push(title);
    });
  }

  /** The last reported state. */
  get state(): AgentState {
    return this.current;
  }

  push(data: string): void {
    this.term.write(data, () => this.evaluate());
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  settled(): Promise<void> {
    return new Promise((resolve) => this.term.write("", resolve));
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    this.term.dispose();
  }

  // A chunk can carry several titles (a turn that starts and ends inside one read): each one's
  // state is reported in order, then the state of the screen and the final title. An idle title
  // takes the screen's word on background work.
  private evaluate(): void {
    const passing = this.titlesInChunk.slice(0, -1);
    this.titlesInChunk = [];
    const shown = this.screen();
    const dialog = this.dialogOn(shown);
    const background = this.rules.background(shown[lastNonBlank(shown)]?.trim() ?? "");
    for (const title of passing) {
      const state = this.fromTitle(title, background);
      // A title's wait that the chunk's own dialog shows is reported once, with its rows.
      if (state && !(state.kind === "waiting" && state.prompt === dialog?.prompt)) this.report(state);
    }
    this.report(dialog ? { kind: "waiting", ...dialog } : (this.fromTitle(this.title, background) ?? { kind: "unknown" }));
  }

  private fromTitle(title: string, background: boolean): AgentState | null {
    const state = this.rules.fromTitle(title, this.sawWorking);
    if (state?.kind === "working") this.sawWorking = true;
    return state?.kind === "idle" ? { kind: "idle", background } : state;
  }

  private report(state: AgentState): void {
    if (state.kind === "idle") {
      // Idle, and a change of its background work, is reported once it has held: the timer
      // started by the first idle reports the screen's latest; back to the reported state, it stops.
      if (sameState(state, this.current)) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        return;
      }
      this.pendingIdle = state;
      this.idleTimer ??= setTimeout(() => {
        this.idleTimer = undefined;
        this.change(this.pendingIdle);
      }, this.idleAfterMs);
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!sameState(state, this.current)) return this.change(state);
    // The same wait: its rows are reported when they first show (codex's title can say it waits
    // before the dialog is drawn); later redraws (a moved selection) update `state` silently, and
    // a title alone never drops rows the screen showed.
    if (state.kind !== "waiting" || this.current.kind !== "waiting" || state.lines.length === 0) return;
    if (this.current.lines.length === 0) this.change(state);
    else this.current = state;
  }

  private change(state: AgentState): void {
    this.current = state;
    this.onState(state);
  }

  /** The screen's rows, right-trimmed, as drawn. */
  private screen(): string[] {
    const buffer = this.term.buffer.active;
    const shown: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      shown.push(buffer.getLine(buffer.baseY + y)?.translateToString(true).trimEnd() ?? "");
    }
    return shown;
  }

  private dialogOn(shown: string[]): { prompt: AgentPrompt; lines: string[] } | null {
    const rows = shown.map((row) => row.trim());
    const footerRow = lastNonBlank(rows);
    const footer = rows[footerRow];
    if (footer === undefined) return null;
    for (const dialog of this.rules.dialogs) {
      if (!dialog.footer.test(footer)) continue;
      let optionRow = footerRow - 1;
      while (optionRow >= 0 && !dialog.option.test(rows[optionRow] ?? "")) optionRow--;
      if (optionRow < 0) continue;
      const { question } = dialog;
      if (question && !rows.slice(0, optionRow).some((row) => question.test(row))) continue;
      let top = optionRow;
      for (let y = optionRow - 1; y >= 0; y--) {
        if (dialog.top.row.test(rows[y] ?? "")) {
          top = dialog.top.below ? y + 1 : y;
          break;
        }
      }
      return { prompt: dialog.prompt, lines: dedent(shown.slice(top, footerRow + 1)) };
    }
    return null;
  }
}
