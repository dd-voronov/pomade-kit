// What an agent CLI in a terminal is doing — working on a turn, idle at its empty prompt (with or
// without background work still going), or waiting for the user at a permission, folder-trust,
// background-work, question or consent prompt, or at a screen no rule names — read from its
// output stream.
//
// claude and codex are full-screen TUIs with diff renderers: they send only the cells that
// changed and position words with cursor moves, so a prompt's text is not reliably present as a
// substring of the stream (a word redrawn over a matching cell arrives in pieces). The scanner
// therefore replays the stream into a headless terminal of the pty's size and reads what is on
// screen, plus the window title, which both CLIs use as a status line:
//
//   claude   working — title starts with a spinner glyph ◐ ◓ ◑ ◒; the title's idle — it starts
//            with ✳. Background work goes while the footer (the last non-blank row) counts it:
//            "⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage".
//            The empty prompt — the composer: a "❯" row with nothing typed in it, alone between
//            two rules "────…".
//            waiting — a dialog on screen: "Do you want to …" / "❯ 1. Yes" / "Esc to cancel"
//            (permission), "Yes, I trust this folder" / "Enter to confirm · Esc to cancel"
//            (trust), "Background work is running" / "❯ 1. …" / "Enter to confirm · Esc to
//            cancel" (background: an exit asked while background work goes), or the question
//            form of its AskUserQuestion tool: "☐ <header>" / "❯ 1. …" / "Enter to select · ↑/↓
//            to navigate · Esc to cancel" (question), or the consent screen of Bypass Permissions
//            mode, shown at start to a profile that never accepted it and before claude sets any
//            title: "WARNING: Claude Code running in Bypass Permissions mode" / "❯ No, exit" /
//            "Yes, I accept" / "Enter to confirm · Esc to cancel" (consent). The title stays ✳
//            while a dialog is up. A dialog is read whatever the title says, none included.
//   codex    working — title starts with a braille spinner (U+2800–U+28FF); the title's idle —
//            any other non-empty title, once a spinner has been seen (the title format is
//            configurable in codex; without the spinner item the state stays unknown). The empty
//            prompt — the last "›" row, with at most two rows under it (the footer), nothing but
//            its faint placeholder after the "›". waiting — title "[ ! ] Action Required | …"
//            (blinks with "[ . ]"), or the approval dialog "› 1. Yes, proceed" / "Press enter to
//            confirm or esc to cancel" on screen; trust — "› 1. Yes, continue" / "Press enter to
//            continue". Background work is never read: idle is always without it.
//
// Idle is reported only on positive evidence: the title's idle with the empty prompt on screen.
// The title's idle over any other screen — a dialog no rule names, a dialog whose words changed —
// is a wait at prompt `unknown`, with the screen's last rows: a consumer that acts on idle (types
// a command and Enter) must never do it into a dialog, where the Enter picks the highlighted
// option. Text typed into the prompt (by the person, or a consumer's own command on its way) keeps
// an idle already reported; before one, the prompt with text in it is a wait at `unknown` too.
//
// A dialog counts only while its footer is the last non-blank row on screen: that is where both
// CLIs draw a live prompt, and it keeps transcript text that merely quotes a prompt (with the
// composer and status rows below it) from reading as one. A waiting state carries the dialog's
// rows as the screen shows them, from its top — claude: the row under the rule that opens the
// dialog; codex: its first question row — down to the footer. A wait is reported when it starts,
// and once more when its rows first show (codex's title may say it waits before the dialog is
// drawn); a redraw of the same dialog (the selection moved) only updates `state`. A question form
// that asks its next question (the form's rows above its options changed) is a new wait.
//
// Background work is read from claude's footer, not from the turn's closing line ("✻ Cooked for
// 4s · done 10:14 PM · 1 shell still running"): the closing line is transcript text written when
// the turn ends — later turns leave it above their own — and the command menu covers it while a
// command is typed; the footer's count is claude's live status of that work.
//
// Idle, and the title's idle over an unnamed screen, is reported only once it has held for
// `idleAfterMs`: claude sets its idle title a few milliseconds before it draws a permission dialog
// (and over a frame of its redraw), and a consumer that acts on idle (ending an unattended run) or
// on a wait must never see that flash. A change of `background` while idle is reported
// once it, too, has held for `idleAfterMs`, and idle is reported with the screen's latest: a read
// can end in the middle of the footer's redraw (claude drops the dialog after Esc and draws the
// footer's count 11 ms later).
// Working and waiting are reported at once.
//
// Probe evidence (claude 2.1.321, 2.1.331 and 2.1.332, codex-cli 0.153.2, and a pomade-runner pty
// log of the consent screen) is in ./fixtures; the provenance of each capture is recorded in the
// fixture itself.

import { Terminal } from "./xterm-headless.js";

export type AgentKind = "claude" | "codex";

/** What the agent waits for: approval of a tool call, trust for the folder it started in,
 *  (`background`) the choice what to do with its background work when an exit is asked while
 *  that work goes, (`question`) the person's pick among options the agent asks with its question
 *  form, (`consent`) the person's acceptance of claude's Bypass Permissions mode, asked at start of
 *  a profile that never accepted it, or (`unknown`) a screen no rule names that is not its empty
 *  prompt. */
export type AgentPrompt = "permission" | "trust" | "background" | "question" | "consent" | "unknown";

/** `unknown` until the output says otherwise (before the first title or dialog, or under a title
 *  format the scanner does not read). `idle`: the agent is at its empty prompt;
 *  `idle.background`: the screen says its background work is still going — its turn is over, its
 *  job may not be.
 *  `waiting.lines`: the prompt as the screen shows it — the dialog's rows from its top to its
 *  footer (prompt `unknown`: the screen's last `UNKNOWN_ROWS` rows, from its first non-blank one),
 *  right-trimmed, their common indent removed; `[]` while only the title says the agent waits
 *  (codex's "Action Required"). `waiting.highlighted` (prompts `question` and `consent`): the
 *  option the screen highlights — the one Enter picks — without its marker and number. */
export type AgentState =
  | { kind: "working" }
  | { kind: "idle"; background: boolean }
  | { kind: "waiting"; prompt: AgentPrompt; lines: string[]; highlighted?: string }
  | { kind: "unknown" };

/** How many of the screen's last rows a wait at prompt `unknown` carries. */
export const UNKNOWN_ROWS = 12;

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
  /** The highlighted option row, its text in group 1: the dialog's state carries `highlighted`. */
  highlight?: RegExp;
}

/** The agent's prompt as the screen shows it: empty, with text typed in it, or not on screen. */
type PromptOnScreen = "empty" | "typed" | null;

interface AgentRules {
  dialogs: readonly Dialog[];
  /** Where the agent's prompt is on screen and whether text is typed in it. `rows` trimmed;
   *  `solid(y)`: row `y` trimmed with its faint (dim) cells blanked — a placeholder is drawn faint. */
  prompt(rows: string[], solid: (y: number) => string): PromptOnScreen;
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
/** The question form's header: one question's chip "☐ Permission", or the tab row of several
 *  ("←  ☐ Permission  ✔ Format  ✔ Submit  →"). */
const CLAUDE_QUESTION_HEADER = /^(?:←\s+)?[☐☒✔]\s/;
/** A numbered option row, highlighted (`❯`) or not. */
const NUMBERED_OPTION = /^(?:[❯›]\s*)?\d+\.\s/;
/** A highlighted option row: the option's text in group 1. */
const HIGHLIGHTED_OPTION = /^[❯›]\s*\d+\.\s+(.*)$/;
/** The consent screen's highlighted option, numbered or not: its text in group 1. */
const HIGHLIGHTED_CONSENT = /^❯\s*(?:\d+\.\s+)?(.+)$/;

/** claude's composer: the last "❯" row right under a rule, with the rows down to the next rule
 *  (a prompt of several lines). Empty: that row alone, nothing but faint text after the "❯". */
function claudePrompt(rows: string[], solid: (y: number) => string): PromptOnScreen {
  for (let y = rows.length - 2; y >= 1; y--) {
    if (!/^❯(?:\s|$)/.test(rows[y] ?? "") || !CLAUDE_RULE.row.test(rows[y - 1] ?? "")) continue;
    let end = y + 1;
    while (end < rows.length && !CLAUDE_RULE.row.test(rows[end] ?? "")) end++;
    if (end === rows.length) return null;
    return end === y + 1 && solid(y).replace(/^[❯›]/, "").trim() === "" ? "empty" : "typed";
  }
  return null;
}

/** codex's composer: the last "›" row, with at most two non-blank rows (its footer) under it.
 *  Empty: nothing but its faint placeholder after the "›". */
function codexPrompt(rows: string[], solid: (y: number) => string): PromptOnScreen {
  for (let y = rows.length - 1; y >= 0; y--) {
    if (!/^›(?:\s|$)/.test(rows[y] ?? "")) continue;
    if (rows.slice(y + 1).filter((row) => row !== "").length > 2) return null;
    return solid(y).replace(/^[❯›]/, "").trim() === "" ? "empty" : "typed";
  }
  return null;
}

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
      {
        prompt: "question",
        footer: /^Enter to select\b/,
        option: NUMBERED_OPTION,
        question: CLAUDE_QUESTION_HEADER,
        top: { row: CLAUDE_QUESTION_HEADER, below: false },
        highlight: HIGHLIGHTED_OPTION,
      },
      {
        prompt: "consent",
        footer: /^Enter to confirm · Esc to cancel$/,
        option: /^(?:❯\s*)?(?:\d+\.\s+)?Yes, I accept$/,
        question: /^WARNING: Claude Code running in Bypass Permissions mode$/,
        top: CLAUDE_RULE,
        highlight: HIGHLIGHTED_CONSENT,
      },
    ],
    prompt: claudePrompt,
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
    prompt: codexPrompt,
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

/** A question form's rows above its options: what it asks. */
function asked(lines: string[]): string {
  const first = lines.findIndex((line) => NUMBERED_OPTION.test(line.trim()));
  return lines.slice(0, first < 0 ? lines.length : first).join("\n");
}

function sameState(a: AgentState, b: AgentState): boolean {
  if (a.kind === "waiting") {
    if (b.kind !== "waiting" || a.prompt !== b.prompt) return false;
    return a.prompt !== "question" || asked(a.lines) === asked(b.lines);
  }
  if (a.kind === "idle") return b.kind === "idle" && a.background === b.background;
  return a.kind === b.kind;
}

/** The index of the last row with text on it; -1 for none. */
function lastNonBlank(rows: string[]): number {
  let y = rows.length - 1;
  while (y >= 0 && rows[y]?.trim() === "") y--;
  return y;
}

/** Held states — idle, and the title's idle over an unnamed screen — are reported once they hold. */
function held(state: AgentState): boolean {
  return state.kind === "idle" || (state.kind === "waiting" && state.prompt === "unknown");
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
  /** The held state the running `idleTimer` reports: the screen's latest. */
  private pending: AgentState = { kind: "idle", background: false };

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
  // takes the screen's word: idle at the empty prompt, with or without background work; a wait at
  // `unknown` elsewhere.
  private evaluate(): void {
    const passing = this.titlesInChunk.slice(0, -1);
    this.titlesInChunk = [];
    const shown = this.screen();
    const dialog = this.dialogOn(shown);
    let atIdle: AgentState | "keep" | undefined;
    const idle = (): AgentState | "keep" => (atIdle ??= this.atIdle(shown));
    for (const title of passing) {
      const state = this.fromTitle(title, idle);
      // A title's wait that the chunk's own dialog shows is reported once, with its rows.
      if (state && !(state !== "keep" && state.kind === "waiting" && state.prompt === dialog?.prompt)) this.report(state);
    }
    this.report(dialog ? { kind: "waiting", ...dialog } : (this.fromTitle(this.title, idle) ?? { kind: "unknown" }));
  }

  private fromTitle(title: string, idle: () => AgentState | "keep"): AgentState | "keep" | null {
    const state = this.rules.fromTitle(title, this.sawWorking);
    if (state?.kind === "working") this.sawWorking = true;
    return state?.kind === "idle" ? idle() : state;
  }

  /** What the title's idle means on this screen: idle at the empty prompt; at a prompt with text
   *  typed in it, the idle already reported stands (`keep`); elsewhere a wait at `unknown`. */
  private atIdle(shown: string[]): AgentState | "keep" {
    const rows = shown.map((row) => row.trim());
    const prompt = this.rules.prompt(rows, (y) => this.solid(y));
    if (prompt === "empty") return { kind: "idle", background: this.rules.background(rows[lastNonBlank(rows)] ?? "") };
    if (prompt === "typed" && this.current.kind === "idle") return "keep";
    const last = lastNonBlank(shown);
    const tail = shown.slice(Math.max(0, last + 1 - UNKNOWN_ROWS), last + 1);
    const first = tail.findIndex((row) => row.trim() !== "");
    return { kind: "waiting", prompt: "unknown", lines: first < 0 ? [] : dedent(tail.slice(first)) };
  }

  private report(state: AgentState | "keep"): void {
    if (state === "keep") {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      return;
    }
    if (held(state)) {
      // A held state, and a change of idle's background work, is reported once it has held: the
      // timer started by the first reports the screen's latest; back to the reported state, it
      // stops (an unnamed screen's redraw updates `state`).
      if (sameState(state, this.current)) {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        if (state.kind === "waiting") this.current = state;
        return;
      }
      this.pending = state;
      this.idleTimer ??= setTimeout(() => {
        this.idleTimer = undefined;
        this.change(this.pending);
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

  /** Screen row `y`, trimmed, its faint (dim) cells blanked. */
  private solid(y: number): string {
    const buffer = this.term.buffer.active;
    const line = buffer.getLine(buffer.baseY + y);
    if (line === undefined) return "";
    let text = "";
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell === undefined || cell.getWidth() === 0) continue;
      text += cell.isDim() !== 0 ? " " : cell.getChars() || " ";
    }
    return text.trim();
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

  private dialogOn(shown: string[]): { prompt: AgentPrompt; lines: string[]; highlighted?: string } | null {
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
      const lines = dedent(shown.slice(top, footerRow + 1));
      const { highlight } = dialog;
      if (!highlight) return { prompt: dialog.prompt, lines };
      const highlighted = lines.map((line) => highlight.exec(line.trim())?.[1]).find((text) => text !== undefined);
      return highlighted === undefined ? { prompt: dialog.prompt, lines } : { prompt: dialog.prompt, lines, highlighted };
    }
    return null;
  }
}
