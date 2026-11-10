// The event bus's bookkeeping (HOST-API §4 `events`, pomade:E-031), with no transport: who is
// subscribed to what, who hears a published event, the sticky `pomade.ready`, and the
// publisher's "has subscribers" news. Pomade's main process and the fake host both run it; a
// subscriber is an abstract connection (an app frame, a backend's socket), so a new transport
// only opens connections.

import { parseBusEventName } from "./events.js";
import type { JsonValue } from "./types.js";

/** One subscriber or publisher on the bus: an app frame today, a backend's socket tomorrow. */
export interface BusConnection {
  /** The app it speaks for: the publisher of its own events, the receiver of their news. */
  readonly appId: string;
  /** Hand it one event (a bus event, or `events.subscribersChanged`). */
  deliver(name: string, payload: JsonValue): void;
}

/** An open connection's handle: the calls a host makes for it. */
export interface BusMember {
  readonly appId: string;
  /** Subscribe (idempotent). A sticky event already raised is delivered at once — after `deliverAfter`, when given. */
  subscribe(name: string, deliverAfter?: (deliver: () => void) => void): void;
  /** Unsubscribe (idempotent; an unknown name is a no-op). */
  unsubscribe(name: string): void;
  /** Publish this connection's app's event `name` (unqualified) to every other subscribed connection. */
  publish(name: string, payload: JsonValue): void;
  /** Whether the app's own event `name` (unqualified) has any subscriber. */
  hasSubscribers(name: string): boolean;
  /** The names this connection is subscribed to. */
  subscriptions(): string[];
  /** Leave the bus: every subscription ends. Idempotent. */
  close(): void;
}

interface Member {
  conn: BusConnection;
  subs: Set<string>;
  open: boolean;
}

export class EventBus {
  private readonly members = new Set<Member>();
  private readonly sticky = new Map<string, JsonValue>();

  /** Add a connection. `subscriptions` start subscribed (e.g. `project.changed` for an app frame). */
  open(conn: BusConnection, subscriptions: readonly string[] = []): BusMember {
    const member: Member = { conn, subs: new Set(), open: true };
    this.members.add(member);
    for (const name of subscriptions) this.subscribe(member, name);
    return {
      appId: conn.appId,
      subscribe: (name, deliverAfter) => {
        if (!member.open) return;
        const sticky = this.subscribe(member, name);
        if (sticky === undefined) return;
        const deliver = (): void => {
          if (member.open && member.subs.has(name)) conn.deliver(name, sticky);
        };
        if (deliverAfter) deliverAfter(deliver);
        else deliver();
      },
      unsubscribe: (name) => {
        if (member.open) this.unsubscribe(member, name);
      },
      publish: (name, payload) => {
        if (member.open) this.deliver(`${conn.appId}:${name}`, payload, member);
      },
      hasSubscribers: (name) => this.count(`${conn.appId}:${name}`) > 0,
      subscriptions: () => [...member.subs],
      close: () => {
        if (!member.open) return;
        member.open = false;
        for (const name of [...member.subs]) this.unsubscribe(member, name);
        this.members.delete(member);
      },
    };
  }

  /** Publish a platform event to every subscribed connection. */
  publish(name: string, payload: JsonValue): void {
    this.deliver(name, payload, null);
  }

  /** Publish a platform event to one app's subscribed connections only (`attachedTab.action`
   *  goes to the app that owns the session). */
  publishTo(appId: string, name: string, payload: JsonValue): void {
    for (const m of [...this.members]) {
      if (m.open && m.conn.appId === appId && m.subs.has(name)) m.conn.deliver(name, payload);
    }
  }

  /** Publish a platform event and keep it: a later subscription gets it at once, until `clearSticky`. */
  publishSticky(name: string, payload: JsonValue): void {
    this.sticky.set(name, payload);
    this.deliver(name, payload, null);
  }

  /** Forget a sticky event (the state it announced is over). */
  clearSticky(name: string): void {
    this.sticky.delete(name);
  }

  /** How many connections subscribe to `name`. */
  count(name: string): number {
    let n = 0;
    for (const m of this.members) if (m.subs.has(name)) n++;
    return n;
  }

  /** Returns the sticky payload to deliver for a NEW subscription, else undefined. */
  private subscribe(member: Member, name: string): JsonValue | undefined {
    if (member.subs.has(name)) return undefined;
    const before = this.count(name);
    member.subs.add(name);
    if (before === 0) this.announce(name, true);
    return this.sticky.get(name);
  }

  private unsubscribe(member: Member, name: string): void {
    if (!member.subs.delete(name)) return;
    if (this.count(name) === 0) this.announce(name, false);
  }

  private deliver(name: string, payload: JsonValue, from: Member | null): void {
    for (const m of [...this.members]) {
      if (m !== from && m.open && m.subs.has(name)) m.conn.deliver(name, payload);
    }
  }

  /** An app event gained its first subscriber or lost its last: tell the publisher's connections. */
  private announce(name: string, subscribed: boolean): void {
    const bus = parseBusEventName(name);
    if (bus?.kind !== "app") return;
    for (const m of [...this.members]) {
      if (m.open && m.conn.appId === bus.appId) m.conn.deliver("events.subscribersChanged", { name: bus.event, subscribed });
    }
  }
}
