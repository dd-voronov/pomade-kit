import { describe, expect, it } from "vitest";
import { EventBus, type BusConnection } from "./bus.js";
import type { JsonValue } from "./types.js";

function conn(appId: string): BusConnection & { got: [string, JsonValue][] } {
  const got: [string, JsonValue][] = [];
  return { appId, got, deliver: (name, payload) => got.push([name, payload]) };
}

describe("EventBus", () => {
  it("delivers a platform event to its subscribers only", () => {
    const bus = new EventBus();
    const a = conn("planner");
    const b = conn("runner");
    const ma = bus.open(a);
    bus.open(b);
    ma.subscribe("project.renamed");
    bus.publish("project.renamed", { n: 1 });
    expect(a.got).toEqual([["project.renamed", { n: 1 }]]);
    expect(b.got).toEqual([]);
  });

  it("starts a connection with initial subscriptions", () => {
    const bus = new EventBus();
    const a = conn("planner");
    bus.open(a, ["project.changed"]);
    bus.publish("project.changed", 1);
    expect(a.got).toEqual([["project.changed", 1]]);
  });

  it("app events are qualified with the publisher's id and skip the publishing connection", () => {
    const bus = new EventBus();
    const runner = conn("pomade-runner");
    const runnerOther = conn("pomade-runner");
    const agents = conn("pomade-agents");
    const mRunner = bus.open(runner);
    bus.open(runnerOther).subscribe("pomade-runner:run.finished");
    bus.open(agents).subscribe("pomade-runner:run.finished");
    mRunner.subscribe("pomade-runner:run.finished");
    mRunner.publish("run.finished", { id: "r1" });
    expect(agents.got).toEqual([["pomade-runner:run.finished", { id: "r1" }]]);
    expect(runnerOther.got.filter(([n]) => n === "pomade-runner:run.finished")).toEqual([["pomade-runner:run.finished", { id: "r1" }]]);
    expect(runner.got.filter(([n]) => n === "pomade-runner:run.finished")).toEqual([]);
  });

  it("subscribing twice delivers once; unsubscribe and close stop delivery", () => {
    const bus = new EventBus();
    const a = conn("planner");
    const m = bus.open(a);
    m.subscribe("pomade.ready");
    m.subscribe("pomade.ready");
    expect(bus.count("pomade.ready")).toBe(1);
    m.unsubscribe("pomade.ready");
    m.unsubscribe("never");
    bus.publish("pomade.ready", {});
    m.subscribe("project.created");
    m.close();
    m.close();
    m.subscribe("project.created");
    bus.publish("project.created", 1);
    expect(a.got).toEqual([]);
    expect(m.subscriptions()).toEqual([]);
  });

  it("a sticky event reaches later subscribers once, through deliverAfter when given", () => {
    const bus = new EventBus();
    bus.publishSticky("pomade.ready", {});
    const a = conn("planner");
    const m = bus.open(a);
    const later: (() => void)[] = [];
    m.subscribe("pomade.ready", (deliver) => later.push(deliver));
    expect(a.got).toEqual([]);
    later[0]!();
    expect(a.got).toEqual([["pomade.ready", {}]]);
    m.subscribe("pomade.ready");
    expect(a.got).toHaveLength(1);
    bus.clearSticky("pomade.ready");
    const b = conn("runner");
    bus.open(b).subscribe("pomade.ready");
    expect(b.got).toEqual([]);
  });

  it("a deferred sticky delivery is dropped when the subscription ended meanwhile", () => {
    const bus = new EventBus();
    bus.publishSticky("pomade.ready", {});
    const a = conn("planner");
    const m = bus.open(a);
    let deliver: () => void = () => {};
    m.subscribe("pomade.ready", (d) => (deliver = d));
    m.unsubscribe("pomade.ready");
    deliver();
    expect(a.got).toEqual([]);
  });

  it("tells the publisher's connections when an event gains its first subscriber and loses its last", () => {
    const bus = new EventBus();
    const runner = conn("pomade-runner");
    const mRunner = bus.open(runner);
    const news = () => runner.got.filter(([n]) => n === "events.subscribersChanged").map(([, p]) => p);
    expect(mRunner.hasSubscribers("run.finished")).toBe(false);
    const a = bus.open(conn("pomade-agents"));
    const b = bus.open(conn("pomade-planner"));
    a.subscribe("pomade-runner:run.finished");
    b.subscribe("pomade-runner:run.finished");
    expect(mRunner.hasSubscribers("run.finished")).toBe(true);
    a.unsubscribe("pomade-runner:run.finished");
    expect(mRunner.hasSubscribers("run.finished")).toBe(true);
    b.close();
    expect(mRunner.hasSubscribers("run.finished")).toBe(false);
    expect(news()).toEqual([
      { name: "run.finished", subscribed: true },
      { name: "run.finished", subscribed: false },
    ]);
  });

  it("platform event subscriptions announce nothing; a closing publisher hears nothing", () => {
    const bus = new EventBus();
    const runner = conn("pomade-runner");
    const m = bus.open(runner);
    m.subscribe("project.renamed");
    m.subscribe("pomade-runner:run.finished");
    m.close();
    expect(runner.got).toEqual([["events.subscribersChanged", { name: "run.finished", subscribed: true }]]);
  });
});
