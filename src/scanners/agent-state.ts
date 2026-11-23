// What an agent CLI in a terminal is doing — working on a turn, idle, or waiting for the user at
// a permission or folder-trust prompt — read from its output stream.
//
// claude and codex are full-screen TUIs with diff renderers: they send only the cells that
// changed and position words with cursor moves, so a prompt's text is not reliably present as a
// substring of the stream (a word redrawn over a matching cell arrives in pieces). The scanner
// therefore replays the stream into a headless terminal of the pty's size and reads what is on
// screen, plus the window title, which both CLIs use as a status line:
//
//   claude   working — title starts with a spinner glyph ◐ ◓ ◑ ◒; idle — title starts with ✳.
//            waiting — a dialog on screen: "Do you want to …" / "❯ 1. Yes" / "Esc to cancel"
//            (permission) or "Yes, I trust this folder" / "Enter to confirm · Esc to cancel"
//            (trust). The title stays ✳ while a dialog is up.
//   codex    working — title starts with a braille spinner (U+2800–U+28FF); idle — any other
//            non-empty title, once a spinner has been seen (the title format is configurable in
//            codex; without the spinner item the state stays unknown). waiting — title "[ ! ] Action Required | …" (blinks with "[ . ]"),
//            or the approval dialog "› 1. Yes, proceed" / "Press enter to confirm or esc to
//            cancel" on screen; trust — "› 1. Yes,
//            continue" / "Press enter to continue".
//
// A dialog counts only while its footer is the last non-blank row on screen: that is where both
// CLIs draw a live prompt, and it keeps transcript text that merely quotes a prompt (with the
// composer and status rows below it) from reading as one. A waiting state carries the dialog's
// rows as the screen shows them, from its top — claude: the row under the rule that opens the
// dialog; codex: its first question row — down to the footer. A wait is reported when it starts,
// and once more when its rows first show (codex's title may say it waits before the dialog is
// drawn); a redraw of the same dialog (the selection moved) only updates `state`.
//
// Idle is reported only once it has held for `idleAfterMs`: claude sets its idle title a few
// milliseconds before it draws a permission dialog, and a consumer that acts on idle (ending an
// unattended run) must never see that flash. Working and waiting are reported at once.
//
// Probe evidence (claude 2.1.321, codex-cli 0.153.2, 2026-11-09) is in ./fixtures; the
// provenance of each capture is recorded in the fixture itself.

import { Terminal } from "./xterm-headless.js";

export type AgentKind = "claude" | "codex";

/** What the agent waits for: approval of a tool call, or trust for the folder it started in. */
export type AgentPrompt = "permission" | "trust";

/** `unknown` until the output says otherwise (before the first title, or under a title format the
 *  scanner does not read). `waiting.lines`: the prompt as the screen shows it — the dialog's rows
 *  from its top to its footer, right-trimmed, their common indent removed; `[]` while only the
 *  title says the agent waits (codex's "Action Required"). */
export type AgentState =
  | { kind: "working" }
  | { kind: "idle" }
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
  /** `sawWorking`: a working title has been seen in this session. */
  fromTitle(title: string, sawWorking: boolean): AgentState | null;
}

const CLAUDE_SPINNER = new Set(["◐", "◓", "◑", "◒"]);
const CLAUDE_IDLE = "✳";
const CODEX_ACTION_REQUIRED = /^\[ [!.] \] Action Required\b/;
/** The full-width rule claude draws over its dialogs. */
const CLAUDE_RULE = { row: /^─{8,}$/, below: true };

const RULES: Record<AgentKind, AgentRules> = {
  claude: {
    dialogs: [
      { prompt: "permission", footer: /^Esc to cancel\b/, option: /^(?:❯\s*)?1\.\s+Yes\b/, question: /^(?:Do you want|Would you like)\b/, top: CLAUDE_RULE },
      { prompt: "trust", footer: /^Enter to confirm · Esc to cancel$/, option: /^(?:❯\s*)?Yes, I trust this folder$/, top: CLAUDE_RULE },
    ],
    fromTitle(title) {
      const first = [...title][0];
      if (first === undefined) return null;
      if (CLAUDE_SPINNER.has(first)) return { kind: "working" };
      if (first === CLAUDE_IDLE) return { kind: "idle" };
      return null;
    },
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
      return sawWorking ? { kind: "idle" } : null;
    },
  },
};

function sameState(a: AgentState, b: AgentState): boolean {
  return a.kind === b.kind && (a.kind !== "waiting" || (b.kind === "waiting" && a.prompt === b.prompt));
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
  // state is reported in order, then the state of the screen and the final title.
  private evaluate(): void {
    const passing = this.titlesInChunk.slice(0, -1);
    this.titlesInChunk = [];
    const dialog = this.dialogOnScreen();
    for (const title of passing) {
      const state = this.fromTitle(title);
      // A title's wait that the chunk's own dialog shows is reported once, with its rows.
      if (state && !(state.kind === "waiting" && state.prompt === dialog?.prompt)) this.report(state);
    }
    this.report(dialog ? { kind: "waiting", ...dialog } : (this.fromTitle(this.title) ?? { kind: "unknown" }));
  }

  private fromTitle(title: string): AgentState | null {
    const state = this.rules.fromTitle(title, this.sawWorking);
    if (state?.kind === "working") this.sawWorking = true;
    return state;
  }

  private report(state: AgentState): void {
    if (state.kind === "idle") {
      if (this.current.kind !== "idle" && this.idleTimer === undefined) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = undefined;
          this.change(state);
        }, this.idleAfterMs);
      }
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

  private dialogOnScreen(): { prompt: AgentPrompt; lines: string[] } | null {
    const buffer = this.term.buffer.active;
    /** Right-trimmed, as drawn. */
    const shown: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      shown.push(buffer.getLine(buffer.baseY + y)?.translateToString(true).trimEnd() ?? "");
    }
    const rows = shown.map((row) => row.trim());
    let footerRow = rows.length - 1;
    while (footerRow >= 0 && rows[footerRow] === "") footerRow--;
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
