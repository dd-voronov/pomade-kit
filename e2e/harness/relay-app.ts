// A scripted app page for the frame relay's spec (`e2e/relay.spec.ts`): what it is opened as, its
// backend's answer to a broker call, the events it hears, and buttons for the calls a frame makes
// to Pomade (open its own tab, open and close its overlay).

import { connect, type HostClient } from "pomade-kit/sdk";

function line(testId: string, text = ""): HTMLParagraphElement {
  const p = document.createElement("p");
  p.dataset.testid = testId;
  p.textContent = text;
  document.body.append(p);
  return p;
}

function button(testId: string, label: string, onClick: () => Promise<unknown>): void {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.testid = testId;
  b.textContent = label;
  b.addEventListener("click", () => void onClick());
  document.body.append(b);
}

async function start(host: HostClient): Promise<void> {
  const where = line("where");
  let route = host.welcome.route;
  const show = (): void => void (where.textContent = `${host.welcome.surface} · ${route}`);
  show();
  host.onRouteChange((next) => {
    route = next;
    show();
  });
  if (host.welcome.surface === "overlay") {
    button("close-overlay", "Close", () => host.overlay.close());
    return;
  }
  const answer = line("answer");
  const heard = line("heard");
  button("ask", "Ask the backend", async () => {
    answer.textContent = JSON.stringify(await host.apps.call(host.welcome.appId, "echo", { text: "hello" }));
  });
  button("open-tab", "Open a tab", () => host.tabs.openApp({ route: "notes/1" }));
  button("open-overlay", "Open the overlay", () => host.overlay.open({ route: "quick" }));
  await host.events.subscribe(`${host.welcome.appId}:pinged`, (payload) => void (heard.textContent = JSON.stringify(payload)));
  line("subscribed", "subscribed");
}

async function main(): Promise<void> {
  const result = await connect();
  if (result.status === "connected") await start(result.host);
  else line("where", result.status);
}

void main();
