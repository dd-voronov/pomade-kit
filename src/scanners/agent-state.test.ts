// AgentStateScanner against real captures of claude and codex (./fixtures — each file records
// its provenance: CLI version, command, terminal, scenario and the scripted keystrokes), replayed
// with their recorded timing on a fake clock, plus synthetic screens for the edges.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStateScanner, type AgentKind, type AgentState } from "./agent-state.js";

interface Fixture {
  provenance: { captured: string; cli: string; command: string; how: string; scenario: string };
  cols: number;
  rows: number;
  /** [ms since spawn, key] — what the probe typed. */
  input: [number, string][];
  /** [ms since spawn, output chunk] — exactly as node-pty delivered it. */
  chunks: [number, string][];
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

const label = (s: AgentState): string =>
  s.kind === "waiting" ? `waiting:${s.prompt}` : s.kind === "idle" && s.background ? "idle:background" : s.kind;

/** Replays chunks at their recorded times (ms) and returns every reported state as "t label". */
async function replay(agent: AgentKind, fx: Pick<Fixture, "cols" | "rows" | "chunks">): Promise<string[]> {
  const events: string[] = [];
  const start = Date.now();
  const scanner = new AgentStateScanner({ agent, cols: fx.cols, rows: fx.rows }, (s) => events.push(`${Date.now() - start} ${label(s)}`));
  let now = 0;
  for (const [t, data] of fx.chunks) {
    if (t > now) await vi.advanceTimersByTimeAsync(t - now);
    now = t;
    scanner.push(data);
  }
  await vi.advanceTimersByTimeAsync(1000);
  scanner.dispose();
  return events;
}

/** Splits every chunk into pieces of `size` characters, all delivered at the chunk's time. */
function rechunk(chunks: [number, string][], size: number): [number, string][] {
  return chunks.flatMap(([t, d]) => {
    const pieces: [number, string][] = [];
    for (let i = 0; i < d.length; i += size) pieces.push([t, d.slice(i, i + size)]);
    return pieces;
  });
}

/** Merges chunks that arrive within `windowMs` of the first one into one read. */
function coalesce(chunks: [number, string][], windowMs: number): [number, string][] {
  const out: [number, string][] = [];
  for (const [t, d] of chunks) {
    const last = out[out.length - 1];
    if (last && t - last[0] <= windowMs) last[1] += d;
    else out.push([t, d]);
  }
  return out;
}

const kinds = (events: string[]): string[] => events.map((e) => e.split(" ")[1] ?? "");
/** Without a repeat of the state before it (a wait reported again as its rows show). */
const changes = (labels: string[]): string[] => labels.filter((l, i) => l !== labels[i - 1]);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

// Expected timelines, read against each fixture's `input`: trust is reported from the first draw
// of the trust screen until the Enter that accepts it; the permission prompt from its draw until
// the answer; idle 500 ms after the CLI's idle title, unless a prompt or more work follows first.
// None of the permission captures leaves background work: their idle is without it.
const REAL: { name: string; agent: AgentKind; timeline: string[] }[] = [
  {
    name: "claude-bash-reject",
    agent: "claude",
    // input: Down 2238, Enter 2940 (trust), Esc 10756 (no)
    timeline: ["245 waiting:trust", "2948 unknown", "3580 working", "5755 waiting:permission", "11342 idle"],
  },
  {
    name: "claude-bash-approve",
    agent: "claude",
    // input: Down 2525, Enter 3226 (trust), Enter 20097 (yes) — claude's own BEL at 12259 changes nothing
    timeline: ["527 waiting:trust", "3235 unknown", "3864 working", "6097 waiting:permission", "20126 working", "21592 idle"],
  },
  {
    name: "claude-write-reject",
    agent: "claude",
    // input: Down 2525, Enter 3226 (trust), Esc 9965 (no)
    timeline: ["527 waiting:trust", "3235 unknown", "3986 working", "5964 waiting:permission", "10553 idle"],
  },
  {
    name: "codex-exec-approve",
    agent: "codex",
    // input: Enter 1660 (trust), focus-out 3161, Enter 20340 (yes)
    // codex's Action Required title (8338) comes a read before its dialog (8339): the wait, then its rows.
    timeline: ["157 waiting:trust", "1680 unknown", "1912 working", "8338 waiting:permission", "8339 waiting:permission", "20352 working", "34778 idle"],
  },
  {
    name: "codex-exec-reject",
    agent: "codex",
    // input: Enter 3197 (trust), focus-out 4699, Esc 19906 (no)
    // The Action Required title and the dialog arrive in two reads at 14903: the wait, then its rows.
    timeline: ["1694 waiting:trust", "3259 unknown", "3758 working", "14903 waiting:permission", "14903 waiting:permission", "19909 working", "20428 idle"],
  },
  {
    name: "claude-background-exit",
    agent: "claude",
    // input: "/exit" + Enter 7049. The idle title comes at 6150 with the footer's "· 1 shell";
    // the command menu typing "/exit" opens over the turn's closing line changes nothing.
    timeline: ["300 working", "6650 idle:background", "7120 waiting:background"],
  },
  {
    name: "claude-background-stay",
    agent: "claude",
    // input: "/exit" 25002, Enter 26036, Esc 30052, "/exit" 80024, Enter 81014.
    // Enter on /exit: claude's working title for 15 ms (26055), then the dialog (26072). Esc: the
    // dialog goes at 30134, the footer's "· 1 shell" back at 30145 — idle with it 500 ms on. The
    // shell ends at 42840 and claude takes a new turn by itself; it ends without background work.
    // The second /exit ends claude: a working title, then its empty title.
    timeline: [
      "1150 working",
      "3981 idle:background",
      "26055 working",
      "26072 waiting:background",
      "30634 idle:background",
      "42840 working",
      "44078 idle",
      "81020 working",
      "81283 unknown",
    ],
  },
];

describe("AgentStateScanner — real captures", () => {
  for (const { name, agent, timeline } of REAL) {
    it(`${name}: ${fixture(name).provenance.scenario}`, async () => {
      expect(await replay(agent, fixture(name))).toEqual(timeline);
    });
  }

  it("never reports idle between claude's idle title and its permission dialog (5–7 ms apart)", async () => {
    for (const name of ["claude-bash-reject", "claude-bash-approve", "claude-write-reject"]) {
      const events = kinds(await replay("claude", fixture(name)));
      const waiting = events.indexOf("waiting:permission");
      expect(events[waiting - 1]).toBe("working");
    }
  });

  for (const { name, agent, timeline } of REAL) {
    it(`${name}: the same timeline when every chunk is split into 3-character reads`, { timeout: 20_000 }, async () => {
      const fx = fixture(name);
      expect(await replay(agent, { ...fx, chunks: rechunk(fx.chunks, 3) })).toEqual(timeline);
    });
  }

  it("reports the same state changes in order when reads within 50 ms are merged into one", async () => {
    for (const { name, agent, timeline } of REAL) {
      const fx = fixture(name);
      expect(changes(kinds(await replay(agent, { ...fx, chunks: coalesce(fx.chunks, 50) })))).toEqual(changes(kinds(timeline)));
    }
  });
});

/** Every state a replay reports, in order. */
async function states(agent: AgentKind, fx: Pick<Fixture, "cols" | "rows" | "chunks">): Promise<AgentState[]> {
  const out: AgentState[] = [];
  const scanner = new AgentStateScanner({ agent, cols: fx.cols, rows: fx.rows }, (s) => out.push(s));
  let now = 0;
  for (const [t, data] of fx.chunks) {
    if (t > now) await vi.advanceTimersByTimeAsync(t - now);
    now = t;
    scanner.push(data);
  }
  await vi.advanceTimersByTimeAsync(1000);
  scanner.dispose();
  return out;
}

/** Every waiting state a replay reports, in order. */
async function waits(agent: AgentKind, fx: Pick<Fixture, "cols" | "rows" | "chunks">): Promise<Extract<AgentState, { kind: "waiting" }>[]> {
  return (await states(agent, fx)).filter((s): s is Extract<AgentState, { kind: "waiting" }> => s.kind === "waiting");
}

describe("AgentStateScanner — background work (real captures)", () => {
  it("claude: the turn that leaves a background shell ends idle with background work; /exit then waits at the background dialog", async () => {
    expect(await states("claude", fixture("claude-background-exit"))).toEqual([
      { kind: "working" },
      { kind: "idle", background: true },
      {
        kind: "waiting",
        prompt: "background",
        lines: [
          "Background work is running",
          "The following will stop when you exit:",
          "",
          "shell · Wait 3 minutes",
          "",
          "❯ 1. Exit and stop tasks",
          "  2. Move to background and exit",
          "  3. Stay",
          "",
          "Enter to confirm · Esc to cancel",
        ],
      },
    ]);
  });

  it("claude: Esc on the background dialog stays; the shell's end starts a new turn by itself, which ends without background work", async () => {
    expect(await states("claude", fixture("claude-background-stay"))).toEqual([
      { kind: "working" },
      { kind: "idle", background: true },
      { kind: "working" },
      {
        kind: "waiting",
        prompt: "background",
        lines: [
          "Background work is running",
          "The following will stop when you exit:",
          "",
          "shell · Wait 40 seconds",
          "",
          "❯ 1. Exit and stop tasks",
          "  2. Stay",
          "",
          "Enter to confirm · Esc to cancel",
        ],
      },
      { kind: "idle", background: true },
      { kind: "working" },
      { kind: "idle", background: false },
      { kind: "working" },
      { kind: "unknown" },
    ]);
  });

  it("every idle in the captures without background work is without it", async () => {
    for (const { name, agent } of REAL.filter((r) => !r.name.startsWith("claude-background-"))) {
      const idles = (await states(agent, fixture(name))).filter((s) => s.kind === "idle");
      expect(idles.length).toBeGreaterThan(0);
      expect(idles).toEqual(idles.map(() => ({ kind: "idle", background: false })));
    }
  });
});

describe("AgentStateScanner — the prompt as the screen shows it (real captures)", () => {
  it("claude: the permission dialog's rows, from under its rule to its footer", async () => {
    const [trust, permission] = await waits("claude", fixture("claude-bash-reject"));
    expect(trust?.prompt).toBe("trust");
    expect(trust?.lines.slice(0, 2)).toEqual(["Accessing workspace:", ""]);
    expect(trust?.lines.slice(-4)).toEqual(["❯ No, exit", "  Yes, I trust this folder", "", "Enter to confirm · Esc to cancel"]);
    expect(permission?.prompt).toBe("permission");
    expect(permission?.lines[0]).toBe(" Bash command");
    expect(permission?.lines).toContain(" touch hello.txt");
    expect(permission?.lines.slice(-8)).toEqual([
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to /private/var/folders/qb/s1tx2twn79qd9xy_gfs1lzbh0000gn/T/pomade-probe-WfWEsS from",
      "      this project",
      "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
      "   4. No",
      "",
      " Esc to cancel · Tab to amend",
    ]);
  });

  it("codex: the title's wait comes first without rows, then the approval dialog's rows from its question", async () => {
    const [trust, titled, shown] = await waits("codex", fixture("codex-exec-approve"));
    expect(trust?.lines[0]).toBe("> You are in /private/var/folders/qb/s1tx2twn79qd9xy_gfs1lzbh0000gn/T/pomade-probe-rjIcfX");
    expect(trust?.lines.at(-1)).toBe("  Press enter to continue");
    expect(titled).toEqual({ kind: "waiting", prompt: "permission", lines: [] });
    expect(shown).toEqual({
      kind: "waiting",
      prompt: "permission",
      lines: [
        "  Would you like to run the following command?",
        "",
        "  Environment: local",
        "",
        "  Reason: Do you want to allow creating the requested empty hello.txt file?",
        "",
        "  $ touch hello.txt",
        "",
        "› 1. Yes, proceed (y)",
        "  2. Yes, and don't ask again for commands that start with `touch` (p)",
        "  3. No, and tell Codex what to do differently (esc)",
        "",
        "  Press enter to confirm or esc to cancel",
      ],
    });
  });
});

// Synthetic screens: CUP-positioned rows on a 60×12 terminal.
const at = (row: number, text: string): string => `\x1b[${row};1H${text}`;
const title = (text: string): string => `\x1b]0;${text}\x07`;
const CLAUDE_DIALOG =
  at(4, " Do you want to proceed?") + at(5, " ❯ 1. Yes") + at(6, "   2. No") + at(8, " Esc to cancel · Tab to amend");
const CLAUDE_COMPOSER = at(10, "─".repeat(60)) + at(11, "❯ ") + at(12, "─".repeat(60));

async function run(agent: AgentKind, chunks: string[], size = { cols: 60, rows: 12 }): Promise<string[]> {
  const events: string[] = [];
  const scanner = new AgentStateScanner({ agent, ...size }, (s) => events.push(label(s)));
  for (const chunk of chunks) {
    scanner.push(chunk);
    await vi.advanceTimersByTimeAsync(10);
  }
  await vi.advanceTimersByTimeAsync(1000);
  scanner.dispose();
  return events;
}

describe("AgentStateScanner — claude", () => {
  it("is unknown before any title or dialog", async () => {
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12 }, () => {});
    scanner.push("plain output\r\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.state).toEqual({ kind: "unknown" });
    scanner.dispose();
  });

  it("reads working and idle from the title glyph", async () => {
    expect(await run("claude", [title("◐ Fix the bug"), title("◑ Fix the bug"), title("✳ Fix the bug")])).toEqual(["working", "idle"]);
  });

  it("ignores titles it does not know", async () => {
    expect(await run("claude", [title("Claude Code")])).toEqual([]);
  });

  it("reports a permission dialog whose footer is the last non-blank row", async () => {
    expect(await run("claude", ["\x1b[2J", title("◐ x"), title("✳ x"), CLAUDE_DIALOG])).toEqual(["working", "waiting:permission"]);
  });

  it("does not read a quoted dialog as one when the composer is drawn below it", async () => {
    expect(await run("claude", ["\x1b[2J", title("✳ x"), CLAUDE_DIALOG + CLAUDE_COMPOSER])).toEqual(["idle"]);
  });

  it("ends waiting when the dialog is replaced by the composer", async () => {
    expect(await run("claude", ["\x1b[2J", title("✳ x"), CLAUDE_DIALOG, "\x1b[2J" + CLAUDE_COMPOSER])).toEqual([
      "waiting:permission",
      "idle",
    ]);
  });

  it("finds a dialog redrawn over matching cells (only the changed cells sent)", async () => {
    // First prompt, answered (screen cleared), then a second prompt whose rows a diff renderer
    // writes only where the cells differ: here "proceed?" stays from the first draw.
    const second = at(4, " Do you want to ") + "\x1b[4;17Hcreate a.txt?" + at(5, " ❯ 1. Yes") + at(8, " Esc to cancel");
    const first = at(4, " Do you want to proceed?") + at(5, " ❯ 1. Yes") + at(8, " Esc to cancel");
    expect(await run("claude", ["\x1b[2J", title("✳ x"), first, title("◐ x") + "\x1b[8;1H\x1b[2K", second])).toEqual([
      "waiting:permission",
      "working",
      "waiting:permission",
    ]);
  });

  it("gives the dialog's rows from under the rule above it, common indent removed; a moved selection updates state only", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12 }, (s) => states.push(s));
    scanner.push("\x1b[2J" + at(1, "transcript") + at(2, "─".repeat(60)) + at(3, " Bash command") + CLAUDE_DIALOG);
    await vi.advanceTimersByTimeAsync(10);
    const lines = ["Bash command", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel · Tab to amend"];
    expect(states).toEqual([{ kind: "waiting", prompt: "permission", lines }]);
    scanner.push(at(5, "   1. Yes") + at(6, " ❯ 2. No"));
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toHaveLength(1);
    expect(scanner.state).toEqual({ kind: "waiting", prompt: "permission", lines: ["Bash command", "Do you want to proceed?", "  1. Yes", "❯ 2. No", "", "Esc to cancel · Tab to amend"] });
    scanner.dispose();
  });

  it("without a rule above the dialog, its rows start at the option row", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12 }, (s) => states.push(s));
    scanner.push(at(3, " Yes, I trust this folder") + at(5, " Enter to confirm · Esc to cancel"));
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toEqual([{ kind: "waiting", prompt: "trust", lines: ["Yes, I trust this folder", "", "Enter to confirm · Esc to cancel"] }]);
    scanner.dispose();
  });

  it("reports the folder-trust dialog", async () => {
    const trust = at(3, " ❯ No, exit") + at(4, "   Yes, I trust this folder") + at(6, " Enter to confirm · Esc to cancel");
    expect(await run("claude", [trust])).toEqual(["waiting:trust"]);
  });

  it("requires the question row above the options for a permission dialog", async () => {
    expect(await run("claude", [at(5, " ❯ 1. Yes") + at(8, " Esc to cancel")])).toEqual([]);
  });

  it("reports a turn that starts and ends inside one read, idle after it holds", async () => {
    expect(await run("claude", [title("◐ x") + "output" + title("✳ x")])).toEqual(["working", "idle"]);
  });

  it("holds idle back for idleAfterMs and drops it when work resumes first", async () => {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12, idleAfterMs: 200 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x"));
    scanner.push(title("✳ x"));
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual(["working"]);
    scanner.push(title("◑ x"));
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(["working"]);
    scanner.push(title("✳ x"));
    await vi.advanceTimersByTimeAsync(199);
    expect(events).toEqual(["working"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["working", "idle"]);
    expect(scanner.state).toEqual({ kind: "idle", background: false });
    scanner.dispose();
  });

  it("reports nothing after dispose, a pending idle included", async () => {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x") + title("✳ x"));
    await vi.advanceTimersByTimeAsync(10);
    scanner.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(["working"]);
  });

  it("reads the screen at the size given by resize", async () => {
    // At 60×4 the rows below clamp onto row 4 and overwrite each other; at 60×12 they are a dialog.
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 4 }, (s) => events.push(label(s)));
    scanner.resize(60, 12);
    scanner.push(CLAUDE_DIALOG);
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(["waiting:permission"]);
    scanner.dispose();

    const small: string[] = [];
    const unresized = new AgentStateScanner({ agent: "claude", cols: 60, rows: 4 }, (s) => small.push(label(s)));
    unresized.push(CLAUDE_DIALOG);
    await vi.advanceTimersByTimeAsync(10);
    expect(small).toEqual([]);
    unresized.dispose();
  });
});

// Synthetic claude screens at 80×12: transcript from the top, the composer on rows 9–11, the
// footer on row 12.
describe("AgentStateScanner — claude background work", () => {
  const WIDE = { cols: 80, rows: 12 };
  const row = (n: number, text: string): string => `\x1b[${n};1H\x1b[2K${text}`;
  const footer = (text: string): string => row(12, text);
  const COMPOSER = row(9, "─".repeat(80)) + row(10, "❯ ") + row(11, "─".repeat(80));
  const SHELL = "  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage";
  const PLAIN = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
  const STILL_RUNNING = "✻ Cooked for 4s · done 10:14 PM · 1 shell still running";
  const turnEnd = (closing: string, foot: string): string =>
    "\x1b[2J" + row(1, "⏺ Timer's running.") + row(3, closing) + COMPOSER + footer(foot);
  /** Like `run`, where a number is that many ms passing (idle reported once it holds 500 ms). */
  async function play(steps: (string | number)[]): Promise<string[]> {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE }, (s) => events.push(label(s)));
    for (const step of steps) {
      if (typeof step === "number") await vi.advanceTimersByTimeAsync(step);
      else scanner.push(step);
    }
    await vi.advanceTimersByTimeAsync(1000);
    scanner.dispose();
    return events;
  }

  it("reads the footer's count of background shells, as an item of its hints, on the last non-blank row", async () => {
    const cases: [string, boolean][] = [
      [SHELL, true],
      ["  ⏵⏵ bypass permissions on · 1 shell", true],
      ["  1 shell · ↓ to manage", true],
      ["  ⏵⏵ accept edits on · 12 shells · ↓ to manage", true],
      ["  ⏵⏵ bypass permissions on · 1 shell       1 MCP server failed · /mcp", true],
      [PLAIN, false],
      ["  ? for shortcuts", false],
      ["  ⏵⏵ bypass permissions on · 1 shellfish", false],
      ["  1 MCP server failed · /mcp", false],
      ["  Ran 1 shell command", false],
      [STILL_RUNNING, false],
    ];
    for (const [foot, background] of cases) {
      const events = await run("claude", [title("◐ x"), "\x1b[2J" + COMPOSER + footer(foot), title("✳ x")], WIDE);
      expect(events, foot).toEqual(["working", background ? "idle:background" : "idle"]);
    }
  });

  it("does not read a count of shells above the last non-blank row", async () => {
    expect(await run("claude", [title("◐ x"), "\x1b[2J" + row(1, "  note · 1 shell · old") + COMPOSER + footer(PLAIN), title("✳ x")], WIDE)).toEqual([
      "working",
      "idle",
    ]);
  });

  it("does not take the turn's closing line for background work: the footer decides", async () => {
    // The closing line says a shell still runs; the footer, claude's live status, counts none.
    expect(await run("claude", [title("◐ x"), turnEnd(STILL_RUNNING, PLAIN), title("✳ x")], WIDE)).toEqual(["working", "idle"]);
  });

  it("holds idle with background work back for idleAfterMs, and reports the screen's latest when it is reported", async () => {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE, idleAfterMs: 200 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x"));
    scanner.push(turnEnd("✻ Cooked for 4s", PLAIN) + title("✳ x"));
    await vi.advanceTimersByTimeAsync(100);
    scanner.push(footer(SHELL));
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toEqual(["working"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["working", "idle:background"]);
    expect(scanner.state).toEqual({ kind: "idle", background: true });
    scanner.dispose();
  });

  it("background work that ends while idle, without a new turn: idle without it, once that holds", async () => {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE, idleAfterMs: 200 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x"));
    scanner.push(turnEnd(STILL_RUNNING, SHELL) + title("✳ x"));
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual(["working", "idle:background"]);
    scanner.push(footer(PLAIN));
    await vi.advanceTimersByTimeAsync(199);
    expect(events).toEqual(["working", "idle:background"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["working", "idle:background", "idle"]);
    expect(scanner.state).toEqual({ kind: "idle", background: false });
    scanner.dispose();
  });

  it("a change of the footer that does not hold for idleAfterMs is not reported", async () => {
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE, idleAfterMs: 200 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x"));
    scanner.push(turnEnd(STILL_RUNNING, SHELL) + title("✳ x"));
    await vi.advanceTimersByTimeAsync(200);
    scanner.push(footer(PLAIN));
    await vi.advanceTimersByTimeAsync(150);
    scanner.push(footer(SHELL));
    await vi.advanceTimersByTimeAsync(150);
    scanner.push(footer(PLAIN));
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toEqual(["working", "idle:background"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(events).toEqual(["working", "idle:background", "idle"]);
    scanner.dispose();
  });

  it("a new turn after the background work ended ends idle without it, the old closing line still on screen", async () => {
    const newTurn = row(4, "⏺ こんにちは！") + row(6, "✻ Worked for 2s");
    expect(
      await play([title("◐ x"), turnEnd(STILL_RUNNING, SHELL), title("✳ x"), 600, title("◐ x") + footer(PLAIN), newTurn, title("✳ x")]),
    ).toEqual(["working", "idle:background", "working", "idle"]);
  });

  it("a turn that ends with no background work is idle without it, an earlier turn's closing line above", async () => {
    expect(await run("claude", [title("◐ x"), turnEnd(STILL_RUNNING, PLAIN) + row(5, "⏺ Done."), title("✳ x")], WIDE)).toEqual([
      "working",
      "idle",
    ]);
  });

  it("a turn that ends while an earlier turn's shell still runs is idle with background work", async () => {
    expect(await run("claude", [title("◐ x"), turnEnd("✻ Worked for 2s", SHELL), title("✳ x")], WIDE)).toEqual([
      "working",
      "idle:background",
    ]);
  });

  it("reads a turn that starts and ends inside one read with the screen's background work", async () => {
    expect(await run("claude", [title("◐ x") + turnEnd(STILL_RUNNING, SHELL) + title("✳ x")], WIDE)).toEqual([
      "working",
      "idle:background",
    ]);
  });

  const BACKGROUND_DIALOG =
    row(1, STILL_RUNNING) +
    row(2, "▔".repeat(80)) +
    row(3, "  Background work is running") +
    row(4, "  The following will stop when you exit:") +
    row(5, "  shell · Wait 3 minutes") +
    row(7, "  ❯ 1. Exit and stop tasks") +
    row(8, "    2. Move to background and exit") +
    row(9, "    3. Stay") +
    row(10, "") +
    row(11, "  Enter to confirm · Esc to cancel") +
    row(12, "");

  it("reads the background dialog after an exit asked while idle with background work; Esc back to the composer is idle with it again", async () => {
    expect(
      await play([title("◐ x"), turnEnd(STILL_RUNNING, SHELL), title("✳ x"), 600, BACKGROUND_DIALOG, 10, turnEnd(STILL_RUNNING, SHELL)]),
    ).toEqual(["working", "idle:background", "waiting:background", "idle:background"]);
  });

  it("gives the background dialog's rows from under its ▔ rule; a moved selection updates state only", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE }, (s) => states.push(s));
    scanner.push(BACKGROUND_DIALOG);
    await vi.advanceTimersByTimeAsync(10);
    const options = ["❯ 1. Exit and stop tasks", "  2. Move to background and exit", "  3. Stay"];
    const lines = (opts: string[]): string[] => [
      "Background work is running",
      "The following will stop when you exit:",
      "shell · Wait 3 minutes",
      "",
      ...opts,
      "",
      "Enter to confirm · Esc to cancel",
    ];
    expect(states).toEqual([{ kind: "waiting", prompt: "background", lines: lines(options) }]);
    scanner.push(row(7, "    1. Exit and stop tasks") + row(9, "  ❯ 3. Stay"));
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toHaveLength(1);
    expect(scanner.state).toEqual({
      kind: "waiting",
      prompt: "background",
      lines: lines(["  1. Exit and stop tasks", "  2. Move to background and exit", "❯ 3. Stay"]),
    });
    scanner.dispose();
  });

  it("without the ▔ rule, the background dialog's rows start at its first option", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", ...WIDE }, (s) => states.push(s));
    scanner.push(row(3, " Background work is running") + row(5, " ❯ 1. Exit and stop tasks") + row(6, "   3. Stay") + row(8, " Enter to confirm · Esc to cancel"));
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toEqual([
      { kind: "waiting", prompt: "background", lines: ["❯ 1. Exit and stop tasks", "  3. Stay", "", "Enter to confirm · Esc to cancel"] },
    ]);
    scanner.dispose();
  });

  it("requires the background dialog's question: its options over the shared footer alone are no dialog", async () => {
    expect(await run("claude", [row(5, " ❯ 1. Exit and stop tasks") + row(6, "   3. Stay") + row(8, " Enter to confirm · Esc to cancel")], WIDE)).toEqual([]);
  });

  it("does not read a quoted background dialog as one when the composer is drawn below it", async () => {
    const quoted = row(1, "  Background work is running") + row(2, "  ❯ 1. Exit and stop tasks") + row(3, "    3. Stay") + row(5, "  Enter to confirm · Esc to cancel");
    expect(await run("claude", [title("◐ x"), "\x1b[2J" + quoted + COMPOSER + footer(PLAIN), title("✳ x")], WIDE)).toEqual(["working", "idle"]);
  });
});

describe("AgentStateScanner — settled", () => {
  it("resolves once everything pushed has been evaluated", async () => {
    vi.useRealTimers();
    const events: string[] = [];
    const scanner = new AgentStateScanner({ agent: "claude", cols: 60, rows: 12 }, (s) => events.push(label(s)));
    scanner.push(title("◐ x"));
    scanner.push("\x1b[2J" + CLAUDE_DIALOG);
    await scanner.settled();
    expect(events).toEqual(["working", "waiting:permission"]);
    scanner.dispose();
  });
});

describe("AgentStateScanner — codex", () => {
  const spin = (c: string): string => title(`${c} repo`);
  const CODEX_APPROVAL =
    at(3, "  Would you like to run the following command?") +
    at(5, "› 1. Yes, proceed (y)") +
    at(6, "  3. No, and tell Codex what to do differently (esc)") +
    at(8, "  Press enter to confirm or esc to cancel");

  it("reads working from the braille spinner and idle from the plain title", async () => {
    expect(await run("codex", [title("repo"), spin("⠋"), spin("⠙"), title("repo")])).toEqual(["working", "idle"]);
  });

  it("stays unknown under a title without the spinner (a custom terminal_title)", async () => {
    expect(await run("codex", [title("repo"), title("repo · gpt"), "output"])).toEqual([]);
  });

  it("reports waiting from the Action Required title, blinking or not, without a screen", async () => {
    expect(
      await run("codex", [spin("⠋"), title("[ ! ] Action Required | repo"), title("[ . ] Action Required | repo"), spin("⠙")]),
    ).toEqual(["working", "waiting:permission", "working"]);
  });

  it("reports the title's wait without rows, again with the rows once the dialog shows; the blinking title keeps them", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "codex", cols: 60, rows: 12 }, (s) => states.push(s));
    scanner.push(spin("⠋"));
    scanner.push(title("[ ! ] Action Required | repo"));
    await vi.advanceTimersByTimeAsync(10);
    scanner.push("\x1b[2J" + CODEX_APPROVAL);
    await vi.advanceTimersByTimeAsync(10);
    scanner.push(title("[ . ] Action Required | repo"));
    await vi.advanceTimersByTimeAsync(10);
    const lines = [
      "  Would you like to run the following command?",
      "",
      "› 1. Yes, proceed (y)",
      "  3. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel",
    ];
    expect(states).toEqual([
      { kind: "working" },
      { kind: "waiting", prompt: "permission", lines: [] },
      { kind: "waiting", prompt: "permission", lines },
    ]);
    expect(scanner.state).toEqual({ kind: "waiting", prompt: "permission", lines });
    scanner.dispose();
  });

  it("a title's wait and its dialog in one read are reported once, with the rows", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "codex", cols: 60, rows: 12 }, (s) => states.push(s));
    scanner.push(spin("⠋") + title("[ ! ] Action Required | repo") + "\x1b[2J" + CODEX_APPROVAL + title("[ . ] Action Required | repo"));
    await vi.advanceTimersByTimeAsync(10);
    expect(states.map((s) => (s.kind === "waiting" ? s.lines.length : s.kind))).toEqual(["working", 6]);
    scanner.dispose();
  });

  it("reports the approval dialog on screen when the title does not say so", async () => {
    expect(await run("codex", [spin("⠋"), "\x1b[2J" + CODEX_APPROVAL])).toEqual(["working", "waiting:permission"]);
  });

  it("never reads background work: idle is without it, whatever the last row says", async () => {
    const states: AgentState[] = [];
    const scanner = new AgentStateScanner({ agent: "codex", cols: 60, rows: 12 }, (s) => states.push(s));
    scanner.push(spin("⠋"));
    scanner.push(at(12, "  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage") + title("repo"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual([{ kind: "working" }, { kind: "idle", background: false }]);
    scanner.dispose();
  });

  it("does not read claude's background dialog", async () => {
    const dialog = at(2, " Background work is running") + at(4, " ❯ 1. Exit and stop tasks") + at(5, "   3. Stay") + at(7, " Enter to confirm · Esc to cancel");
    expect(await run("codex", [spin("⠋"), "\x1b[2J" + dialog])).toEqual(["working"]);
  });

  it("reports the trust screen", async () => {
    const trust =
      at(1, "> You are in /tmp/x") +
      at(3, "  Do you trust the contents of this directory?") +
      at(5, "› 1. Yes, continue") +
      at(6, "  2. No, quit") +
      at(8, "  Press enter to continue");
    expect(await run("codex", [trust, "\x1b[2J" + title("x")])).toEqual(["waiting:trust", "unknown"]);
  });
});
