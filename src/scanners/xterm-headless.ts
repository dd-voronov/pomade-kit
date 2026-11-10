// @xterm/headless is a CommonJS bundle whose exports Node's ES-module loader cannot name, so it is
// imported whole and its `Terminal` taken from it. The same import resolves in Node and in bundlers.

import headless from "@xterm/headless";

export const { Terminal } = headless;
export type Terminal = InstanceType<typeof headless.Terminal>;
