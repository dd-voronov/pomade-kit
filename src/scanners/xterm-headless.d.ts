// @xterm/headless ships an ES module build next to its CommonJS main but types only the package
// root. The scanners import the ES build directly (a named `Terminal` export that resolves the
// same in Node and in bundlers); this maps its types to the root's.
declare module "@xterm/headless/lib-headless/xterm-headless.mjs" {
  export { Terminal } from "@xterm/headless";
}
