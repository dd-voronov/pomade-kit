"use strict";
// Asks the terminal "where is the cursor?" and "what are you?" when told to (`q`), and logs every
// read (JSON lines, $PROBE_LOG): the test checks the answers reach it before a key typed after the
// questions were shown.
const fs = require("fs");
const log = (d) => fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(d) + "\n");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("probe ready\r\n");
process.stdin.on("data", (d) => {
  log(d);
  if (d.includes("q")) process.stdout.write("asking\r\n\x1b[6n\x1b[c");
});
