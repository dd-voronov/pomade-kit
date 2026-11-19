// The parent window of app frames whose fake host runs in the test process — where the app's
// backend reaches it over the socket (`pomade-kit/fake-host/node`). The page only hosts the frames
// and relays their postMessage traffic: the spec attaches each frame to the fake host
// (`fake.attach`), hands this page what the host posts (`deliver`), and hears what the frame
// posts through the `toHost` binding it exposes.

declare global {
  interface Window {
    /** Exposed by the spec (`page.exposeBinding`): a message a frame posted to its parent. */
    toHost(frameId: string, data: unknown): Promise<void>;
    /** Create a frame (`data-frame`, `data-surface`) loading `src`; a tab frame hides the other tabs. */
    mountFrame(frameId: string, src: string, surface: string): void;
    /** Show a tab frame, hiding the other tabs (a tab brought to the front). */
    showTab(frameId: string): void;
    /** Post a host message into a frame. */
    deliver(frameId: string, message: unknown): void;
  }
}

const frames = new Map<string, HTMLIFrameElement>();

window.addEventListener("message", (event) => {
  for (const [frameId, iframe] of frames) {
    if (event.source !== null && event.source === iframe.contentWindow) void window.toHost(frameId, event.data);
  }
});

window.mountFrame = (frameId, src, surface) => {
  const iframe = document.createElement("iframe");
  iframe.dataset.frame = frameId;
  iframe.dataset.surface = surface;
  iframe.src = src;
  frames.set(frameId, iframe);
  document.body.append(iframe);
  if (surface === "tab") window.showTab(frameId);
};

window.showTab = (frameId) => {
  for (const [id, iframe] of frames) if (iframe.dataset.surface === "tab") iframe.hidden = id !== frameId;
};

window.deliver = (frameId, message) => {
  frames.get(frameId)?.contentWindow?.postMessage(message, "*");
};

export {};
