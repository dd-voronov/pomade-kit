// The fake host as the parent window of an app frame — what an app's browser e2e runs against
// instead of Pomade.

import { OVERLAY_DEFAULT_HEIGHT, OVERLAY_WIDTH, type OverlayAnchor } from "../protocol/index.js";
import type { FakeHost, FakeOpenedOverlay, FrameOptions } from "./fake-host.js";

/** `surface` / `icon`: what the frame is opened for (default: a tab from the new-tab menu). */
export interface MountOptions extends FrameOptions {
  /** The app page to load. */
  src: string;
  /** Where the frame goes. Default `document.body`. */
  parent?: HTMLElement;
}

export interface MountedApp {
  /** The app's frame; `data-surface` says what it is opened for (`tab`, `panel`, `overlay`). */
  readonly iframe: HTMLIFrameElement;
  /** The overlay this frame opened (`overlay.open`) while it is open, else `null`. */
  readonly overlay: MountedApp | null;
  /** Navigate the frame's tab to `route` (`route.changed`), as Pomade does for `tabs.openApp`. */
  navigate(route: string): void;
  /** Hide or show the frame (the element too), as Pomade does when the user switches tabs or panels. */
  setHidden(hidden: boolean): void;
  /** Stop answering the frame and remove it (an overlay with its scrim, and any overlay it opened). */
  close(): void;
}

/** The gap an overlay keeps from the window's edges, as Pomade's card keeps from the pane area's. */
const OVERLAY_MARGIN = 16;
/** The smallest overlay frame height Pomade gives. */
const OVERLAY_MIN_HEIGHT = 120;
/** The largest overlay frame height, as a share of the window's height. */
const OVERLAY_MAX_HEIGHT_SHARE = 0.6;

/**
 * Load an app page in an `<iframe>` and answer its messages from `host`, the way Pomade hosts an
 * app frame. A reload of the frame starts a new handshake. The frame may write to the clipboard
 * (`allow="clipboard-write"`), as Pomade's app frames may.
 *
 * An overlay frame (`surface: "overlay"`, or the one a tab or panel frame opens with `overlay.open`)
 * is mounted as Pomade shows it: 420 wide, as high as the app asks (rounded, between 120 and 60% of
 * the window), centred in the window (`anchor: "panel"`: in its top-left corner), over a dimming
 * scrim, and it takes focus. It closes on `overlay.close`, a forwarded Escape or a click on the
 * scrim; focus then returns to the frame that called `overlay.open` (an overlay mounted directly:
 * to what had focus before). One overlay per opener: a new `overlay.open` replaces the open one.
 */
export function mountApp(host: FakeHost, options: MountOptions): MountedApp {
  return mount(host, options, null, "center", undefined);
}

function mount(
  host: FakeHost,
  options: MountOptions,
  opener: HTMLIFrameElement | null,
  anchor: OverlayAnchor,
  height: number | undefined,
): MountedApp {
  const parent = options.parent ?? document.body;
  const doc = parent.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("fake host: the parent element has no window");
  const isOverlay = options.surface === "overlay";
  const iframe = doc.createElement("iframe");
  iframe.dataset.surface = options.surface ?? "tab";
  // Where focus goes back when the overlay closes.
  const focusBack = isOverlay ? (opener ?? doc.activeElement) : null;
  let overlay: MountedApp | null = null;

  // An overlay sits on a scrim over the whole window; a click on the scrim closes it.
  const scrim = isOverlay ? doc.createElement("div") : null;
  const place = (requested: number | undefined): void => {
    const cap = Math.max(OVERLAY_MIN_HEIGHT, Math.floor(win.innerHeight * OVERLAY_MAX_HEIGHT_SHARE));
    const h = Math.min(cap, Math.max(OVERLAY_MIN_HEIGHT, Math.round(requested ?? OVERLAY_DEFAULT_HEIGHT)));
    const w = Math.min(OVERLAY_WIDTH, win.innerWidth - 2 * OVERLAY_MARGIN);
    const left = anchor === "panel" ? OVERLAY_MARGIN : Math.max(OVERLAY_MARGIN, Math.round((win.innerWidth - w) / 2));
    const top = anchor === "panel" ? OVERLAY_MARGIN : Math.max(OVERLAY_MARGIN, Math.round((win.innerHeight - h) / 2));
    Object.assign(iframe.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  };

  const dismiss = (): void => {
    mounted.close();
    if (focusBack instanceof win.HTMLElement && focusBack.isConnected) focusBack.focus({ preventScroll: true });
    options.onClose?.();
  };
  const frame = host.attach((message) => iframe.contentWindow?.postMessage(message, "*"), {
    ...options,
    // An overlay that asks to close is removed, as Pomade removes it.
    onClose: dismiss,
    onOverlayOpen: (opened: FakeOpenedOverlay) => {
      overlay?.close();
      overlay = mount(host, { src: options.src, parent, surface: "overlay", route: opened.route }, iframe, opened.anchor, opened.height);
      options.onOverlayOpen?.(opened);
    },
    onOverlayResize: (requested) => {
      if (isOverlay) place(requested);
      options.onOverlayResize?.(requested);
    },
  });
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== null && event.source === iframe.contentWindow) frame.receive(event.data);
  };
  win.addEventListener("message", onMessage);

  // As Pomade mounts an app frame: it may write text to the clipboard (after a user gesture), never read it.
  iframe.allow = "clipboard-write";
  iframe.src = options.src;
  iframe.hidden = options.hidden === true;
  if (scrim) {
    Object.assign(scrim.style, { position: "fixed", inset: "0", background: "rgba(0, 0, 0, 0.32)", zIndex: "2147483647" });
    Object.assign(iframe.style, { border: "0", borderRadius: "8px", boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)", background: "Canvas" });
    scrim.addEventListener("click", (event) => {
      if (event.target === scrim) dismiss();
    });
    place(height);
    scrim.appendChild(iframe);
    parent.appendChild(scrim);
    // The overlay takes keyboard focus, as Pomade gives it.
    iframe.focus({ preventScroll: true });
    iframe.addEventListener("load", () => iframe.focus({ preventScroll: true }), { once: true });
  } else {
    parent.appendChild(iframe);
  }
  const mounted: MountedApp = {
    iframe,
    get overlay() {
      return overlay?.iframe.isConnected === true ? overlay : null;
    },
    navigate: (route) => frame.navigate(route),
    setHidden(hidden) {
      iframe.hidden = hidden;
      frame.setHidden(hidden);
    },
    close() {
      overlay?.close();
      win.removeEventListener("message", onMessage);
      frame.detach();
      iframe.remove();
      scrim?.remove();
    },
  };
  return mounted;
}
