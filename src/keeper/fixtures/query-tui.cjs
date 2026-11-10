"use strict";
// A TUI-shaped fixture (from the pomade:E-034 keeper spike): switches to the alternate screen, turns
// on modes a real TUI uses, draws colours / emoji / CJK, asks the terminal two questions (cursor
// position, device attributes), then keeps scrolling text inside a scroll region. Every read from
// stdin is appended (JSON lines) to $QLOG, so a test can count which answers reached the program.
const fs = require("fs");
const LOG = process.env.QLOG;
const log = (d) => LOG && fs.appendFileSync(LOG, JSON.stringify(d) + "\n");
const w = (s) => process.stdout.write(s);

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  log(d);
  if (d === "q") {
    w("\x1b[?1049l\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?1l\x1b[?1004l\x1b[?25h");
    process.exit(0);
  }
});

w("\x1b[?1049h\x1b[H\x1b[2J");
w("\x1b[?2004h");
w("\x1b[?1002h\x1b[?1006h");
w("\x1b[?1h");
w("\x1b[?1004h");
w("\x1b[?25l");
w("\x1b[1;1H\x1b[1;31mRED bold\x1b[0m \x1b[38;5;208morange-256\x1b[0m \x1b[38;2;10;200;90mtruecolor\x1b[0m \x1b[7minverse\x1b[0m \x1b[3;4mitalic-ul\x1b[0m");
w("\x1b[2;1Hemoji: 👍🏽 🇪🇸 👨‍👩‍👧 ✅  CJK: 漢字テスト  combining: é  box: ┌─┐");
w("\x1b[6n");
w("\x1b[c");
w("\x1b[3;21r");
let n = 0;
setInterval(() => {
  n++;
  w(`\x1b[21;1H\n\x1b[3${(n % 7) + 1}mline ${n}\x1b[0m — ${"·".repeat(n % 40)}`);
  w(`\x1b7\x1b[23;1H\x1b[2Kcounter ${n}\x1b8`);
}, Number(process.env.QTICK || 50));
