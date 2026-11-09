import { describe, expect, it } from "vitest";
import { datesBetween, leadStart, nextDate, nextOccurrence, occurrencesBetween, occursOn, previousOccurrence } from "./engine.js";
import { toInstant } from "./local-time.js";
import { parseSchedule, type Schedule } from "./schema.js";
import { useTimeZone } from "./test-helpers.js";

function s(value: Record<string, unknown>): Schedule {
  const r = parseSchedule(value);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.schedule;
}

/** A local wall-clock instant: "2026-11-09 07:00". */
function at(local: string): Date {
  const [date = "", time = "0:00"] = local.split(" ");
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return toInstant(date, { hour, minute });
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const isos = (ds: Date[]): string[] => ds.map((d) => d.toISOString());

describe("Europe/Madrid — DST (spring 2026-03-29 02:00→03:00, fall 2026-10-25 03:00→02:00)", () => {
  useTimeZone("Europe/Madrid");
  const daily0230 = s({ daily: { at: "2:30" } });

  it("a 02:30 daily run on the spring-forward day runs at 03:30, once", () => {
    expect(iso(nextOccurrence(daily0230, at("2026-03-28 12:00")))).toBe("2026-03-29T01:30:00.000Z");
    expect(isos(occurrencesBetween(daily0230, at("2026-03-27 12:00"), at("2026-03-31 12:00")))).toEqual([
      "2026-03-28T01:30:00.000Z", // 02:30 CET
      "2026-03-29T01:30:00.000Z", // 03:30 CEST — 02:30 did not exist
      "2026-03-30T00:30:00.000Z", // 02:30 CEST
      "2026-03-31T00:30:00.000Z",
    ]);
  });

  it("a 02:30 daily run on the fall-back day runs once, on the first pass", () => {
    expect(isos(occurrencesBetween(daily0230, at("2026-10-24 12:00"), at("2026-10-26 12:00")))).toEqual([
      "2026-10-25T00:30:00.000Z", // 02:30 CEST, the first pass
      "2026-10-26T01:30:00.000Z", // 02:30 CET
    ]);
    // Asked right after the first pass, during the repeated hour: the next run is tomorrow.
    expect(iso(nextOccurrence(daily0230, new Date("2026-10-25T00:30:00Z")))).toBe("2026-10-26T01:30:00.000Z");
    expect(iso(nextOccurrence(daily0230, new Date("2026-10-25T01:45:00Z")))).toBe("2026-10-26T01:30:00.000Z");
  });

  it("times on both sides of the change keep their wall-clock time", () => {
    const d = s({ daily: { at: ["1:00", "7:00"] } });
    expect(isos(occurrencesBetween(d, at("2026-03-29 0:00"), at("2026-03-29 23:00")))).toEqual([
      "2026-03-29T00:00:00.000Z", // 01:00 CET
      "2026-03-29T05:00:00.000Z", // 07:00 CEST
    ]);
  });

  it("an interval across the spring gap skips the missing wall times without duplicates", () => {
    const e = s({ every: { minutes: 30, from: "1:00", to: "4:00" } });
    expect(isos(occurrencesBetween(e, at("2026-03-29 0:00"), at("2026-03-29 12:00")))).toEqual([
      "2026-03-29T00:00:00.000Z", // 1:00 CET
      "2026-03-29T00:30:00.000Z", // 1:30 CET
      "2026-03-29T01:00:00.000Z", // 3:00 CEST (2:00 → 3:00)
      "2026-03-29T01:30:00.000Z", // 3:30 CEST
      "2026-03-29T02:00:00.000Z", // 4:00 CEST
    ]);
  });

  it("an interval across the fall-back runs each wall time once (the repeated hour gets no second pass)", () => {
    const e = s({ every: { minutes: 30, from: "1:30", to: "3:30" } });
    expect(isos(occurrencesBetween(e, at("2026-10-25 0:00"), at("2026-10-25 12:00")))).toEqual([
      "2026-10-24T23:30:00.000Z", // 1:30 CEST
      "2026-10-25T00:00:00.000Z", // 2:00 CEST
      "2026-10-25T00:30:00.000Z", // 2:30 CEST
      "2026-10-25T02:00:00.000Z", // 3:00 CET
      "2026-10-25T02:30:00.000Z", // 3:30 CET
    ]);
  });

  it("previousOccurrence across the spring change", () => {
    expect(iso(previousOccurrence(daily0230, at("2026-03-29 12:00")))).toBe("2026-03-29T01:30:00.000Z");
    expect(iso(previousOccurrence(daily0230, new Date("2026-03-29T01:30:00Z")))).toBe("2026-03-28T01:30:00.000Z");
  });
});

describe("America/New_York — DST (spring 2026-03-08 02:00→03:00, fall 2026-11-01 02:00→01:00)", () => {
  useTimeZone("America/New_York");

  it("a 02:30 daily run on the spring-forward day runs at 03:30", () => {
    const d = s({ daily: { at: "2:30" } });
    expect(isos(occurrencesBetween(d, at("2026-03-06 12:00"), at("2026-03-09 12:00")))).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  it("a 01:30 daily run on the fall-back day runs once, at 01:30 EDT", () => {
    const d = s({ daily: { at: "1:30" } });
    expect(isos(occurrencesBetween(d, at("2026-10-31 12:00"), at("2026-11-02 12:00")))).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT, the first pass
      "2026-11-02T06:30:00.000Z", // 01:30 EST
    ]);
    // During the repeated hour (01:30 EST = 06:30Z) the run already happened.
    expect(iso(nextOccurrence(d, new Date("2026-11-01T06:15:00Z")))).toBe("2026-11-02T06:30:00.000Z");
    expect(iso(previousOccurrence(d, new Date("2026-11-01T06:45:00Z")))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("an interval through the fall-back night leaves the repeated hour empty", () => {
    const e = s({ every: { minutes: 30, to: "3:00" } });
    expect(isos(occurrencesBetween(e, at("2026-10-31 23:59"), at("2026-11-01 3:00")))).toEqual([
      "2026-11-01T04:00:00.000Z", // 0:00 EDT
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:00:00.000Z", // 1:00 EDT
      "2026-11-01T05:30:00.000Z", // 1:30 EDT
      "2026-11-01T07:00:00.000Z", // 2:00 EST
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T08:00:00.000Z", // 3:00 EST
    ]);
  });

  it("an interval through the spring gap", () => {
    const e = s({ every: { hours: 1, from: "0:00", to: "4:00" } });
    expect(isos(occurrencesBetween(e, at("2026-03-07 23:59"), at("2026-03-08 4:00")))).toEqual([
      "2026-03-08T05:00:00.000Z", // 0:00 EST
      "2026-03-08T06:00:00.000Z", // 1:00 EST
      "2026-03-08T07:00:00.000Z", // 3:00 EDT (2:00 skipped, merged with 3:00)
      "2026-03-08T08:00:00.000Z", // 4:00 EDT
    ]);
  });

  it("weekly and monthly runs keep their wall-clock time across the change", () => {
    const w = s({ weekly: { days: ["sun"], at: "3:00" } });
    expect(isos(occurrencesBetween(w, at("2026-10-24 0:00"), at("2026-11-09 0:00")))).toEqual([
      "2026-10-25T07:00:00.000Z", // 3:00 EDT
      "2026-11-01T08:00:00.000Z", // 3:00 EST
      "2026-11-08T08:00:00.000Z",
    ]);
  });
});

describe("Europe/Madrid — fixed schedules", () => {
  useTimeZone("Europe/Madrid");

  it("once at: next, then nothing", () => {
    const o = s({ once: "2026-11-09 23:00" });
    expect(iso(nextOccurrence(o, at("2026-11-09 12:00")))).toBe("2026-11-09T22:00:00.000Z");
    expect(nextOccurrence(o, at("2026-11-09 23:00"))).toBeNull();
    expect(iso(previousOccurrence(o, at("2026-11-10 0:00")))).toBe("2026-11-09T22:00:00.000Z");
    expect(previousOccurrence(o, at("2026-11-09 23:00"))).toBeNull();
    expect(occurrencesBetween(o, at("2026-11-09 23:00"), at("2026-11-12 0:00"))).toEqual([]);
  });

  it("every 30 min, 9:00–19:00, weekdays only (Runner R2 acceptance)", () => {
    const e = s({ every: { minutes: 30, from: "9:00", to: "19:00" }, only: "weekdays" });
    const wed = occurrencesBetween(e, at("2026-11-11 0:00"), at("2026-11-11 23:59"));
    expect(wed).toHaveLength(21);
    expect(iso(wed[0] ?? null)).toBe(at("2026-11-11 9:00").toISOString());
    expect(iso(wed[1] ?? null)).toBe(at("2026-11-11 9:30").toISOString());
    expect(iso(wed[20] ?? null)).toBe(at("2026-11-11 19:00").toISOString());
    expect(occurrencesBetween(e, at("2026-11-14 0:00"), at("2026-11-15 23:59"))).toEqual([]);
    expect(nextOccurrence(e, at("2026-11-13 19:00"))).toEqual(at("2026-11-16 9:00"));
  });

  it("every N without a window restarts at midnight each day", () => {
    const e = s({ every: { hours: 5 } });
    expect(occurrencesBetween(e, at("2026-11-09 0:00"), at("2026-11-10 6:00"))).toEqual(
      ["2026-11-09 5:00", "2026-11-09 10:00", "2026-11-09 15:00", "2026-11-09 20:00", "2026-11-10 0:00", "2026-11-10 5:00"].map(at),
    );
  });

  it("a window the step does not divide ends at the last step inside it", () => {
    const e = s({ every: { minutes: 45, from: "9:00", to: "10:40" } });
    expect(occurrencesBetween(e, at("2026-11-09 0:00"), at("2026-11-09 23:00"))).toEqual(["2026-11-09 9:00", "2026-11-09 9:45", "2026-11-09 10:30"].map(at));
  });

  it("daily at several times, weekends only", () => {
    const d = s({ daily: { at: ["13:00", "20:00"] }, only: "weekends" });
    expect(occurrencesBetween(d, at("2026-11-13 0:00"), at("2026-11-16 23:00"))).toEqual(
      ["2026-11-14 13:00", "2026-11-14 20:00", "2026-11-15 13:00", "2026-11-15 20:00"].map(at),
    );
  });

  it("weekly on chosen days", () => {
    const w = s({ weekly: { days: ["mon", "fri"], at: "7:00" } });
    expect(nextOccurrence(w, at("2026-11-09 7:00"))).toEqual(at("2026-11-13 7:00"));
    expect(nextOccurrence(w, at("2026-11-09 6:59"))).toEqual(at("2026-11-09 7:00"));
    expect(previousOccurrence(w, at("2026-11-12 12:00"))).toEqual(at("2026-11-09 7:00"));
  });

  it("monthly on the 1st and 15th, the last day, the first Monday", () => {
    const m = s({ monthly: { days: [1, 15, "last", "first mon"], at: "9:00" } });
    expect(occurrencesBetween(m, at("2026-11-01 0:00"), at("2026-12-31 23:00"))).toEqual(
      ["2026-11-01", "2026-11-02", "2026-11-15", "2026-11-30", "2026-12-01", "2026-12-07", "2026-12-15", "2026-12-31"].map((d) => at(`${d} 9:00`)),
    );
  });

  it("start and end bound the occurrences (inclusive dates)", () => {
    const d = s({ daily: { at: "7:00" }, start: "2026-11-10", end: "2026-11-12" });
    expect(nextOccurrence(d, at("2026-01-01 0:00"))).toEqual(at("2026-11-10 7:00"));
    expect(occurrencesBetween(d, at("2026-11-01 0:00"), at("2026-11-30 0:00"))).toEqual(["2026-11-10 7:00", "2026-11-11 7:00", "2026-11-12 7:00"].map(at));
    expect(nextOccurrence(d, at("2026-11-12 7:00"))).toBeNull();
    expect(previousOccurrence(d, at("2026-11-10 7:00"))).toBeNull();
    expect(previousOccurrence(d, at("2027-06-01 0:00"))).toEqual(at("2026-11-12 7:00"));
  });

  it("occurrencesBetween is (from, to] and honours the limit", () => {
    const e = s({ every: { minutes: 1 } });
    expect(occurrencesBetween(e, at("2026-11-09 7:00"), at("2026-11-09 7:03"))).toEqual(["2026-11-09 7:01", "2026-11-09 7:02", "2026-11-09 7:03"].map(at));
    expect(occurrencesBetween(e, at("2026-11-01 0:00"), at("2026-11-09 0:00"), { limit: 3 })).toEqual(["2026-11-01 0:01", "2026-11-01 0:02", "2026-11-01 0:03"].map(at));
    expect(occurrencesBetween(e, at("2026-11-01 0:00"), at("2026-11-09 0:00"))).toHaveLength(1000);
    expect(occurrencesBetween(e, at("2026-11-09 7:00"), at("2026-11-09 6:00"))).toEqual([]);
  });

  it("missed-run detection after power-off: count and the latest missed run", () => {
    const d = s({ daily: { at: "3:00" } });
    const lastAlive = at("2026-11-06 23:00");
    const now = at("2026-11-09 8:30");
    expect(occurrencesBetween(d, lastAlive, now)).toHaveLength(3);
    expect(previousOccurrence(d, now)).toEqual(at("2026-11-09 3:00"));
    expect(nextOccurrence(d, now)).toEqual(at("2026-11-10 3:00"));
  });

  it("schedules without fixed times have no occurrences", () => {
    for (const v of [{ always: true }, { "after-completion": { days: 3 } }]) {
      expect(nextOccurrence(s(v), at("2026-11-09 0:00"))).toBeNull();
      expect(previousOccurrence(s(v), at("2026-11-09 0:00"))).toBeNull();
      expect(occurrencesBetween(s(v), at("2026-11-01 0:00"), at("2026-11-09 0:00"))).toEqual([]);
    }
  });

  it("a day schedule happens at local midnight in the time functions", () => {
    expect(nextOccurrence(s({ weekly: { days: ["wed"] } }), at("2026-11-09 12:00"))).toEqual(at("2026-11-11 0:00"));
  });
});

describe("month ends and leap years (whole days)", () => {
  it("day 31 falls on the last day of shorter months", () => {
    const m = s({ monthly: { days: [31] } });
    expect(datesBetween(m, "2026-01-01", "2026-07-01")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("days 30 and 31 in a 30-day month are one occurrence", () => {
    const m = s({ monthly: { days: [30, 31] } });
    expect(datesBetween(m, "2026-04-01", "2026-05-31")).toEqual(["2026-04-30", "2026-05-30", "2026-05-31"]);
    expect(datesBetween(m, "2026-02-01", "2026-03-01")).toEqual(["2026-02-28"]);
  });

  it("day 29 in February: the 29th in leap years, the 28th otherwise", () => {
    const m = s({ monthly: { days: [29], months: ["feb"] } });
    expect(nextDate(m, "2026-11-09")).toBe("2027-02-28");
    expect(nextDate(m, "2027-03-01")).toBe("2028-02-29");
    expect(datesBetween(m, "2099-01-01", "2101-12-31")).toEqual(["2099-02-28", "2100-02-28", "2101-02-28"]);
  });

  it("the last day and the last weekday through February", () => {
    expect(datesBetween(s({ monthly: { days: ["last"] } }), "2028-01-31", "2028-03-31")).toEqual(["2028-02-29", "2028-03-31"]);
    expect(datesBetween(s({ monthly: { days: ["last tue"] } }), "2028-01-31", "2028-03-31")).toEqual(["2028-02-29", "2028-03-28"]);
  });

  it("a fifth weekday happens only in months that have one", () => {
    const m = s({ monthly: { days: ["fifth mon"] } });
    expect(datesBetween(m, "2026-11-01", "2027-05-31")).toEqual(["2026-11-30", "2027-03-29", "2027-05-31"]);
  });

  it("the nth weekday", () => {
    expect(datesBetween(s({ monthly: { days: ["second tue", "third fri"] } }), "2026-10-31", "2026-11-30")).toEqual(["2026-11-10", "2026-11-20"]);
  });

  it("a months filter makes quarterly and yearly rules", () => {
    expect(datesBetween(s({ monthly: { days: [5], months: ["jan", "apr", "jul", "oct"] } }), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-05",
      "2026-04-05",
      "2026-07-05",
      "2026-10-05",
    ]);
    expect(nextDate(s({ monthly: { days: [15], months: ["mar"] } }), "2026-03-15")).toBe("2027-03-15");
  });
});

describe("whole-day schedules (Planner)", () => {
  const invoices = s({ monthly: { days: [5] }, "lead-days": 3 });

  it("nextDate is strictly after, or on/after with inclusive", () => {
    expect(nextDate(invoices, "2026-11-05")).toBe("2026-12-05");
    expect(nextDate(invoices, "2026-11-05", { inclusive: true })).toBe("2026-11-05");
    expect(nextDate(invoices, "2026-11-02")).toBe("2026-11-05");
  });

  it("missed occurrences between do-on and today (Planner E-005: one row, missed 2×)", () => {
    // do-on Oct 5 never ticked; today Nov 20 → the Nov 5 occurrence also passed.
    expect(datesBetween(invoices, "2026-10-05", "2026-11-20")).toEqual(["2026-11-05"]);
    expect(datesBetween(invoices, "2026-10-05", "2026-10-05")).toEqual([]);
    expect(nextDate(invoices, "2026-11-20")).toBe("2026-12-05");
  });

  it("lead time: shows from do-on − lead-days", () => {
    expect(leadStart(invoices, "2026-11-05")).toBe("2026-11-02");
    expect(leadStart(s({ daily: {} }), "2026-11-05")).toBe("2026-11-05");
    expect(leadStart(s({ monthly: { days: [1] }, "lead-days": 3 }), "2026-03-01")).toBe("2026-02-26");
  });

  it("lead-days ≥ the period keeps an item always visible", () => {
    const weekly = s({ weekly: { days: ["mon"] }, "lead-days": 7 });
    for (const today of ["2026-11-09", "2026-11-10", "2026-11-15"]) {
      const next = nextDate(weekly, today, { inclusive: true }) ?? "";
      expect(leadStart(weekly, next) <= today).toBe(true);
    }
  });

  it("after completion: completion date plus the period (toothbrush: done Nov 20 → Feb 20)", () => {
    const tb = s({ "after-completion": { months: 3 } });
    expect(nextDate(tb, "2026-11-20")).toBe("2027-02-20");
    expect(nextDate(tb, "2026-11-30")).toBe("2027-02-28");
    expect(nextDate(tb, "2027-11-30")).toBe("2028-02-29");
    expect(nextDate(s({ "after-completion": { weeks: 2 } }), "2026-12-25")).toBe("2027-01-08");
    expect(nextDate(s({ "after-completion": { days: 1 } }), "2028-02-28")).toBe("2028-02-29");
    expect(datesBetween(tb, "2026-01-01", "2026-12-31")).toEqual([]);
  });

  it("after completion respects start and end", () => {
    const tb = s({ "after-completion": { days: 10 }, start: "2026-12-01", end: "2027-01-05" });
    expect(nextDate(tb, "2026-11-09")).toBe("2026-12-01");
    expect(nextDate(tb, "2026-11-25")).toBe("2026-12-05");
    expect(nextDate(tb, "2026-12-27")).toBeNull();
  });

  it("start and end bound fixed dates; an ended schedule has no next date", () => {
    const m = s({ monthly: { days: [5] }, start: "2026-01-01", end: "2026-03-31" });
    expect(nextDate(m, "2025-06-01")).toBe("2026-01-05");
    expect(nextDate(m, "2026-03-05")).toBeNull();
    expect(datesBetween(m, "2025-01-01", "2027-01-01")).toEqual(["2026-01-05", "2026-02-05", "2026-03-05"]);
  });

  it("once on a date; always has no dates", () => {
    expect(nextDate(s({ once: "2026-11-20" }), "2026-11-09")).toBe("2026-11-20");
    expect(nextDate(s({ once: "2026-11-20" }), "2026-11-20")).toBeNull();
    expect(nextDate(s({ once: "2026-11-20" }), "2026-11-20", { inclusive: true })).toBe("2026-11-20");
    expect(nextDate(s({ always: true }), "2026-11-09")).toBeNull();
  });

  it("daily filters and occursOn", () => {
    const wd = s({ daily: {}, only: "weekdays" });
    expect(datesBetween(wd, "2026-11-12", "2026-11-17")).toEqual(["2026-11-13", "2026-11-16", "2026-11-17"]);
    expect(occursOn(wd, "2026-11-14")).toBe(false);
    expect(occursOn(wd, "2026-11-16")).toBe(true);
    expect(datesBetween(wd, "2025-12-31", "2026-12-31", { limit: 2 })).toEqual(["2026-01-01", "2026-01-02"]);
  });
});
