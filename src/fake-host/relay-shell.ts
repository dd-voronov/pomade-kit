// The frame relay's shell page: a window laid out as Pomade's — the app's strip icons, the side
// panel, the tab strip with the app's own tabs — whose frames are mounted with `mountApp` against
// the fake host in Node (`node/relay.ts`), reached through the relay's stream and posts
// (`relay-wire.ts`). Served by `serveFrameRelay`; it loads from the built kit.

import type { HostToAppMessage } from "../protocol/index.js";
import type { FakeAppTab, FakeAppTabChange, FrameConnection, FrameOptions } from "./fake-host.js";
import { mountApp, type MountedApp } from "./mount.js";
import type { RelayApp, RelayFrameId, RelayToShell, ShellToRelay } from "./relay-wire.js";


const events = new EventSource("events");
let session: string | null = null;

// The page's messages reach the relay in order: one POST at a time, carrying all that queued up meanwhile.
let outbox: ShellToRelay[] = [];
let sending = false;
function send(message: ShellToRelay): void {
  outbox.push(message);
  if (!sending) void flush();
}
async function flush(): Promise<void> {
  sending = true;
  while (outbox.length > 0 && session !== null) {
    const batch = outbox;
    outbox = [];
    try {
      const res = await fetch(`send?session=${encodeURIComponent(session)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      disconnected(`the relay refused a message (${String(err)})`);
    }
  }
  sending = false;
}

/** The relay is gone (closed, or the test ended): stop, and say so on the page. */
function disconnected(why: string): void {
  if (session === null) return;
  session = null;
  outbox = [];
  events.close();
  document.documentElement.dataset.relay = "closed";
  console.warn(`frame relay: ${why}`);
}

// The fake host, as `mountApp` sees it: each attach is a frame of this session on the relay.
const posts = new Map<RelayFrameId, (message: HostToAppMessage) => void>();
/** The options each frame was attached with: their callbacks run when the relay says so. */
const callbacks = new Map<RelayFrameId, FrameOptions>();
let nextFrame = 1;
const remoteHost = {
  attach(post: (message: HostToAppMessage) => void, open: FrameOptions = {}): FrameConnection {
    const frame = `f${nextFrame++}`;
    const { onClose, onOverlayOpen, onOverlayResize, ...options } = open;
    callbacks.set(frame, open);
    posts.set(frame, post);
    send({ type: "attach", frame, options });
    return {
      receive: (data) => {
        if (posts.has(frame)) send({ type: "receive", frame, data });
      },
      navigate: (route) => send({ type: "navigate", frame, route }),
      setHidden: (hidden) => send({ type: "hidden", frame, hidden }),
      detach: () => {
        if (!posts.delete(frame)) return;
        callbacks.delete(frame);
        send({ type: "detach", frame });
      },
    };
  },
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent.appendChild(el);
  return el;
}

/** The window for `app`; returns what follows the app's tabs. */
function build(app: RelayApp): (change: FakeAppTabChange) => void {
  document.title = `Fake Pomade — ${app.name}`;
  const iconUrl = (path: string | undefined): string | null => {
    const icon = path ?? app.icon;
    return icon === null ? null : new URL(icon, app.url).href;
  };
  const addIcon = (parent: HTMLElement, path: string | undefined): void => {
    const url = iconUrl(path);
    if (url === null) return;
    const img = element("img", "icon", parent);
    img.src = url;
    img.alt = "";
  };

  const strip = element("nav", "strip", document.body);
  strip.setAttribute("aria-label", "App strip");
  const panel = element("section", "panel", document.body);
  const panelHeader = element("header", "panelHeader", panel);
  const main = element("div", "main", document.body);
  const tabStrip = element("div", "tabStrip", main);
  tabStrip.setAttribute("role", "tablist");
  const newTab = element("button", "newTab", tabStrip);
  newTab.type = "button";
  newTab.textContent = "+";
  newTab.title = `New ${app.name} tab`;
  newTab.dataset.testid = "new-tab";
  newTab.addEventListener("click", () => send({ type: "openAppTab" }));
  const panes = element("div", "panes", main);
  const empty = element("p", "empty", panes);
  empty.textContent = `No ${app.name} tab open`;

  // The side panel: one frame per panel icon, mounted when first shown; one shows at a time.
  const panels = new Map<string, { button: HTMLButtonElement; mounted: MountedApp }>();
  const buttons = new Map<string, HTMLButtonElement>();
  const showPanel = (iconId: string): void => {
    const icon = app.strip.find((s) => s.id === iconId);
    if (!icon) return;
    if (!panels.has(iconId)) {
      const mounted = mountApp(remoteHost, { src: app.url, parent: panel, surface: "panel", icon: iconId, hidden: true });
      mounted.iframe.dataset.testid = `panel-frame-${iconId}`;
      mounted.iframe.dataset.icon = iconId;
      mounted.iframe.title = icon.title;
      panels.set(iconId, { button: buttons.get(iconId) as HTMLButtonElement, mounted });
    }
    for (const [id, p] of panels) {
      p.mounted.setHidden(id !== iconId);
      p.button.setAttribute("aria-pressed", String(id === iconId));
    }
    panelHeader.textContent = icon.title;
    panel.hidden = false;
  };
  for (const icon of app.strip) {
    const button = element("button", "stripButton", strip);
    button.type = "button";
    button.title = icon.title;
    button.dataset.testid = `strip-${icon.id}`;
    button.setAttribute("aria-pressed", "false");
    if (iconUrl(icon.icon) === null) button.textContent = icon.title.slice(0, 1).toUpperCase();
    else addIcon(button, icon.icon);
    buttons.set(icon.id, button);
    button.addEventListener("click", () => {
      if (icon.action !== "tab") showPanel(icon.id);
      if (icon.action !== "panel") send({ type: "openAppTab", icon: icon.id });
    });
  }
  const firstPanel = app.strip.find((s) => s.action !== "tab");
  if (firstPanel) showPanel(firstPanel.id);
  else panel.hidden = true;

  // The tab area: one tab per app tab the fake host has open, each with its frame.
  const tabs = new Map<string, { button: HTMLButtonElement; label: HTMLSpanElement; mounted: MountedApp }>();
  const showTab = (tabId: string): void => {
    for (const [id, t] of tabs) {
      t.button.setAttribute("aria-selected", String(id === tabId));
      t.mounted.setHidden(id !== tabId);
    }
  };
  const tabTitle = (tab: FakeAppTab): string => tab.title ?? app.strip.find((s) => s.id === tab.icon)?.title ?? app.name;
  const removeTab = (tabId: string): void => {
    const t = tabs.get(tabId);
    if (!t) return;
    t.button.remove();
    t.mounted.close();
    tabs.delete(tabId);
    const last = [...tabs.keys()].at(-1);
    if (last !== undefined && ![...tabs.values()].some((x) => x.button.getAttribute("aria-selected") === "true")) showTab(last);
    empty.hidden = tabs.size > 0;
  };

  return ({ change, tab }) => {
    const t = tabs.get(tab.tabId);
    if (change === "open" && !t) {
      const button = document.createElement("button");
      tabStrip.insertBefore(button, newTab);
      button.className = "tab";
      button.type = "button";
      button.setAttribute("role", "tab");
      button.dataset.testid = `tab-${tab.tabId}`;
      button.title = `${tabTitle(tab)} — project ${tab.projectId}`;
      addIcon(button, app.strip.find((s) => s.id === tab.icon)?.icon);
      const label = element("span", "tabLabel", button);
      label.textContent = tabTitle(tab);
      const close = element("span", "tabClose", button);
      close.textContent = "×";
      close.title = "Close tab";
      close.dataset.testid = `close-tab-${tab.tabId}`;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        send({ type: "closeAppTab", tabId: tab.tabId });
      });
      button.addEventListener("click", () => showTab(tab.tabId));
      const mounted = mountApp(remoteHost, { src: app.url, parent: panes, tabId: tab.tabId, hidden: true, onClose: () => removeTab(tab.tabId) });
      mounted.iframe.dataset.testid = `tab-frame-${tab.tabId}`;
      mounted.iframe.dataset.tabId = tab.tabId;
      mounted.iframe.dataset.projectId = tab.projectId;
      mounted.iframe.title = tabTitle(tab);
      tabs.set(tab.tabId, { button, label, mounted });
      empty.hidden = true;
      showTab(tab.tabId);
    } else if ((change === "open" || change === "focus") && t) showTab(tab.tabId);
    else if (change === "title" && t) {
      t.label.textContent = tabTitle(tab);
      t.mounted.iframe.title = tabTitle(tab);
    } else if (change === "close") removeTab(tab.tabId);
  };
}

let onAppTab: ReturnType<typeof build> | null = null;

events.addEventListener("message", (event: MessageEvent<string>) => {
  const message = JSON.parse(event.data) as RelayToShell;
  switch (message.type) {
    case "ready":
      if (session !== null) return;
      session = message.session;
      onAppTab = build(message.app);
      if (outbox.length > 0) void flush();
      return;
    case "post":
      posts.get(message.frame)?.(message.message as HostToAppMessage);
      return;
    case "close":
      callbacks.get(message.frame)?.onClose?.();
      return;
    case "overlayOpen":
      callbacks.get(message.frame)?.onOverlayOpen?.(message.overlay);
      return;
    case "overlayResize":
      callbacks.get(message.frame)?.onOverlayResize?.(message.height);
      return;
    case "appTab":
      onAppTab?.(message.change);
      return;
  }
});
// An EventSource retries on its own; a new stream would be a new session, so a lost one ends the page's.
events.addEventListener("error", () => disconnected("the relay's stream ended"));
