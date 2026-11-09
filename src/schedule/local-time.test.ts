import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  formatTime,
  isLocalDate,
  localDateOf,
  localTimeOf,
  parseTime,
  toInstant,
  weekdayOf,
} from "./local-time.js";
import { useTimeZone } from "./test-helpers.js";

describe("calendar dates", () => {
  it.each([
    ["2026-11-09", true],
    ["2028-02-29", true],
    ["2026-02-29", false],
    ["2100-02-29", false],
    ["2000-02-29", true],
    ["2026-04-31", false],
    ["2026-13-01", false],
    ["2026-00-10", false],
    ["2026-1-5", false],
    ["0999-01-01", false],
    ["nov 20", false],
  ])("isLocalDate(%s) = %s", (d, ok) => {
    expect(isLocalDate(d)).toBe(ok);
  });

  it.each([
    [2026, 2, 28],
    [2028, 2, 29],
    [2100, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
  ])("daysInMonth(%i, %i) = %i", (y, m, n) => {
    expect(daysInMonth(y, m)).toBe(n);
  });

  it("adds days across month, year and leap-day ends", () => {
    expect(addDays("2026-11-09", 3)).toBe("2026-11-12");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("adds months, clamping a day the target month lacks to its last day", () => {
    expect(addMonths("2026-11-20", 3)).toBe("2027-02-20");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("counts days and names weekdays", () => {
    expect(daysBetween("2026-11-09", "2026-11-20")).toBe(11);
    expect(daysBetween("2026-11-20", "2026-11-09")).toBe(-11);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(weekdayOf("2026-11-09")).toBe("mon");
    expect(weekdayOf("2026-11-15")).toBe("sun");
    expect(weekdayOf("2028-02-29")).toBe("tue");
  });

  it("throws on a malformed date passed to arithmetic", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("times of day", () => {
  it.each([
    ["7:00", { hour: 7, minute: 0 }],
    ["07:05", { hour: 7, minute: 5 }],
    ["0:00", { hour: 0, minute: 0 }],
    ["23:59", { hour: 23, minute: 59 }],
  ])("parseTime(%s)", (t, v) => {
    expect(parseTime(t)).toEqual(v);
  });

  it.each(["24:00", "7:60", "7", "7:5", "700", "7:00pm", " 7:00", "-1:00"])("parseTime(%s) = null", (t) => {
    expect(parseTime(t)).toBeNull();
  });

  it("formats without a leading zero on the hour", () => {
    expect(formatTime({ hour: 7, minute: 0 })).toBe("7:00");
    expect(formatTime({ hour: 13, minute: 5 })).toBe("13:05");
  });
});

describe("toInstant — Europe/Madrid (spring 2026-03-29 02:00→03:00, fall 2026-10-25 03:00→02:00)", () => {
  useTimeZone("Europe/Madrid");

  it("an ordinary time", () => {
    expect(toInstant("2026-11-09", { hour: 7, minute: 0 }).toISOString()).toBe("2026-11-09T06:00:00.000Z");
    expect(toInstant("2026-07-01", { hour: 7, minute: 0 }).toISOString()).toBe("2026-07-01T05:00:00.000Z");
  });

  it("a skipped time happens as many minutes later as the change skipped", () => {
    const t = toInstant("2026-03-29", { hour: 2, minute: 30 });
    expect(t.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(localTimeOf(t)).toEqual({ hour: 3, minute: 30 });
    expect(toInstant("2026-03-29", { hour: 2, minute: 0 }).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("a repeated time is its first pass", () => {
    expect(toInstant("2026-10-25", { hour: 2, minute: 30 }).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("localDateOf follows the local day, not UTC", () => {
    expect(localDateOf(new Date("2026-11-09T23:30:00Z"))).toBe("2026-11-10");
  });
});

describe("toInstant — America/New_York (spring 2026-03-08 02:00→03:00, fall 2026-11-01 02:00→01:00)", () => {
  useTimeZone("America/New_York");

  it("a skipped time moves forward by the gap", () => {
    expect(toInstant("2026-03-08", { hour: 2, minute: 30 }).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("a repeated time is its first pass (EDT)", () => {
    expect(toInstant("2026-11-01", { hour: 1, minute: 30 }).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("localDateOf follows the local day", () => {
    expect(localDateOf(new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
  });
});
