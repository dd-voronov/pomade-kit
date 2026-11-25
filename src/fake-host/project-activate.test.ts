import { describe, expect, it } from "vitest";
import type { HostToAppMessage, ProjectRef } from "../protocol/index.js";
import { connect, type HostClient } from "../sdk/index.js";
import { createFakeHost, WORKSPACE_SCOPE, type FakeHost, type FakeHostOptions } from "./fake-host.js";

const PROJECTS = [
  { id: "pomade", name: "Pomade", root: "Projects/Pomade" },
  { id: "kit", name: "pomade-kit", root: "Projects/pomade-kit" },
];

function fake(options: FakeHostOptions = {}): FakeHost {
  return createFakeHost({ projects: PROJECTS, ...options });
}

async function client(host: FakeHost): Promise<HostClient> {
  const r = await connect({ transport: host.createTransport(), keySource: null });
  if (r.status !== "connected") throw new Error(`not connected: ${r.status}`);
  return r.host;
}

function raw(host: FakeHost, options?: Parameters<FakeHost["attach"]>[1]) {
  const got: HostToAppMessage[] = [];
  const frame = host.attach((m) => got.push(m), options);
  let id = 0;
  frame.receive({ channel: "pomade", type: "hello", hostApi: 0 });
  const errorOf = (method: string, params?: unknown) => {
    const callId = String(++id);
    frame.receive({ channel: "pomade", type: "call", id: callId, method, params });
    const reply = [...got].reverse().find((m) => m.type === "result" && m.id === callId);
    if (!reply || reply.type !== "result") throw new Error(`no result for ${method}`);
    return reply.ok ? null : reply.error.code;
  };
  return { got, errorOf };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("project.activate", () => {
  it("makes the project active and fires project.changed once; the active project again changes nothing; the Workspace scope works", async () => {
    const host = fake({ activeProject: "pomade" });
    const app = await client(host);
    const seen: ProjectRef[] = [];
    app.project.onChange((p) => seen.push(p));
    await app.project.activate("kit");
    await app.project.activate("kit");
    await flush();
    expect(host.activeProject.id).toBe("kit");
    expect(seen.map((p) => p.id)).toEqual(["kit"]);
    expect(await app.project.getActive()).toMatchObject({ id: "kit", name: "pomade-kit" });
    await app.project.activate(WORKSPACE_SCOPE.id);
    await flush();
    expect(host.activeProject.id).toBe(WORKSPACE_SCOPE.id);
    expect(seen.map((p) => p.id)).toEqual(["kit", WORKSPACE_SCOPE.id]);
  });

  it("opens no tab", async () => {
    const host = fake({ activeProject: "pomade" });
    const app = await client(host);
    await app.project.activate("kit");
    expect(host.openedTabs).toEqual([]);
    expect(host.appTabs).toEqual([]);
  });

  it("errors: an unknown id is not-found, a missing or non-string id invalid-params, no tabs.open capability-denied; the active project stays", () => {
    const host = fake({ activeProject: "pomade", manifest: { id: "x1", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["tabs.open"] } });
    const f = raw(host);
    expect(f.errorOf("project.activate", { projectId: "ghost" })).toBe("not-found");
    expect(f.errorOf("project.activate", {})).toBe("invalid-params");
    expect(f.errorOf("project.activate", { projectId: 3 })).toBe("invalid-params");
    expect(f.errorOf("project.activate", null)).toBe("invalid-params");
    expect(host.activeProject.id).toBe("pomade");
    expect(f.errorOf("project.activate", { projectId: "kit" })).toBeNull();
    expect(host.activeProject.id).toBe("kit");
    const denied = raw(fake({ manifest: { id: "x2", name: "X", version: "1.0.0", hostApi: 0, capabilities: ["project.write"] } }));
    expect(denied.errorOf("project.activate", { projectId: "kit" })).toBe("capability-denied");
  });

  it("answers a socket client too", () => {
    const host = fake({
      activeProject: "pomade",
      manifest: { id: "b1", name: "B", version: "1.0.0", hostApi: 0, capabilities: ["tabs.open"], backend: { entry: "b.mjs", mode: "with-pomade" } },
    });
    const backend = raw(host, { surface: "backend" });
    expect(backend.errorOf("project.activate", { projectId: "kit" })).toBeNull();
    expect(host.activeProject.id).toBe("kit");
  });
});
