import { describe, expect, it } from "vitest";
import { createClient } from "./client.js";
import { mockTransport, WELCOME } from "./test-helpers.js";
import { applyTheme, followTheme, THEME_ATTRIBUTE, type ThemeRoot } from "./theme.js";

function root(): ThemeRoot & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  return { attrs, setAttribute: (name, value) => void (attrs[name] = value) };
}

function client(theme: "light" | "dark" = "light") {
  const mock = mockTransport();
  const { hostApi, pomadeVersion, appId, surface, route, project } = WELCOME;
  const host = createClient(mock.transport, { hostApi, pomadeVersion, appId, surface, route, project, theme });
  const changed = (payload: unknown) => mock.deliver({ channel: "pomade", type: "event", name: "theme.changed", payload });
  return { host, changed };
}

describe("host.theme", () => {
  it("starts at the welcome's theme and follows theme.changed", () => {
    const { host, changed } = client("dark");
    const seen: string[] = [];
    const off = host.theme.onChange((t) => seen.push(t));
    expect(host.theme.get()).toBe("dark");
    changed({ theme: "light" });
    expect(host.theme.get()).toBe("light");
    expect(seen).toEqual(["light"]);
    off();
    changed({ theme: "dark" });
    expect(host.theme.get()).toBe("dark");
    expect(seen).toEqual(["light"]);
  });

  it("ignores a malformed theme.changed", () => {
    const { host, changed } = client();
    changed({ theme: "blue" });
    changed("dark");
    expect(host.theme.get()).toBe("light");
  });
});

describe("applyTheme / followTheme", () => {
  it("applyTheme writes data-theme on the root", () => {
    const r = root();
    applyTheme("dark", r);
    expect(THEME_ATTRIBUTE).toBe("data-theme");
    expect(r.attrs).toEqual({ "data-theme": "dark" });
  });

  it("followTheme puts the host's theme on the root now and on every change, until stopped", () => {
    const { host, changed } = client();
    const r = root();
    const stop = followTheme(host, r);
    expect(r.attrs["data-theme"]).toBe("light");
    changed({ theme: "dark" });
    expect(r.attrs["data-theme"]).toBe("dark");
    stop();
    changed({ theme: "light" });
    expect(r.attrs["data-theme"]).toBe("dark");
  });

  it("without a document, the root must be given", () => {
    expect(() => applyTheme("light")).toThrow(/no document/);
  });
});
