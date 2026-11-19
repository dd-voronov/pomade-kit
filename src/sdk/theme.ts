// Pomade's theme on an app's own root element (HOST-API §3 `welcome.theme`, §4 `theme.changed`).
// Pomade's design tokens (`pomade-kit/tokens.css`) key each theme by `data-theme` on the root,
// `color-scheme` included, so an app that loads them and follows the theme looks like Pomade —
// whatever appearance the Mac has.

import type { Theme } from "../protocol/index.js";
import type { HostClient } from "./client.js";

/** The root attribute that names the theme: `<html data-theme="light">`. */
export const THEME_ATTRIBUTE = "data-theme";

/** Where the theme is written: by default the document's root element. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

function documentRoot(): ThemeRoot {
  if (typeof document === "undefined") throw new Error("pomade-kit: no document — pass the root element");
  return document.documentElement;
}

/** Put `theme` on the root (`data-theme`). An app outside Pomade (no host) calls it with "light". */
export function applyTheme(theme: Theme, root: ThemeRoot = documentRoot()): void {
  root.setAttribute(THEME_ATTRIBUTE, theme);
}

/** Put Pomade's theme on the root now and on every `theme.changed`; returns the stop function. */
export function followTheme(host: Pick<HostClient, "theme">, root: ThemeRoot = documentRoot()): () => void {
  applyTheme(host.theme.get(), root);
  return host.theme.onChange((theme) => applyTheme(theme, root));
}
