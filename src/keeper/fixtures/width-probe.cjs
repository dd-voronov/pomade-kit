"use strict";
// Prints ✅ (two cells in Unicode 11, one in xterm's default tables), asks where the cursor is,
// prints the answer it got, and exits.
process.stdin.setRawMode(true);
process.stdout.write("✅\x1b[6n");
process.stdin.once("data", (d) => {
  process.stdout.write("\r\nanswer:" + JSON.stringify(String(d)) + "\r\n");
  process.exit(0);
});
