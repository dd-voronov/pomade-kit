import { describe, expect, it } from "vitest";
import { toInstant } from "../schedule/local-time.js";
import { useTimeZone } from "../schedule/test-helpers.js";
import { currentDay, parseDatePhrase, type DatePhrase } from "./phrases.js";

/** A local wall-clock instant: "2026-11-09 14:00". */
function at(local: string): Date {
  const [date = "", time = "0:00"] = local.split(" ");
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return toInstant(date, { hour, minute });
}

/** A result in one comparable line: "2026-11-13", "2026-11-09 23:00", "invalid: …", "not-a-date". */
function show(r: DatePhrase): string {
  switch (r.kind) {
    case "date":
      return r.date;
    case "date-time":
      expect(r.at).toEqual(at(`${r.date} ${r.time.hour}:${r.time.minute}`));
      return `${r.date} ${r.time.hour}:${String(r.time.minute).padStart(2, "0")}`;
    case "invalid":
      return `invalid: ${r.message}`;
    case "not-a-date":
      return "not-a-date";
  }
}

describe("parseDatePhrase — Europe/Madrid, now Mon 2026-11-09 14:00", () => {
  useTimeZone("Europe/Madrid");
  const read = (text: string) => show(parseDatePhrase(text, { now: at("2026-11-09 14:00") }));

  it.each([
    ["today", "2026-11-09"],
    ["tomorrow", "2026-11-10"],
    ["yesterday", "2026-11-08"],
    ["tonight", "2026-11-09"],
  ])("relative day %s → %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["tue", "2026-11-10"],
    ["wed", "2026-11-11"],
    ["thu", "2026-11-12"],
    ["thurs", "2026-11-12"],
    ["fri", "2026-11-13"],
    ["Friday", "2026-11-13"],
    ["sat", "2026-11-14"],
    ["sun", "2026-11-15"],
    ["mon", "2026-11-16"],
    ["monday", "2026-11-16"],
  ])("weekday %s → the next one after today: %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["+3d", "2026-11-12"],
    ["+ 3d", "2026-11-12"],
    ["+0d", "2026-11-09"],
    ["+2w", "2026-11-23"],
    ["+1mo", "2026-12-09"],
    ["+3 days", "2026-11-12"],
    ["in 3 days", "2026-11-12"],
    ["in 1 day", "2026-11-10"],
    ["in 2 weeks", "2026-11-23"],
    ["in 3 months", "2027-02-09"],
    ["+60d", "2027-01-08"],
  ])("day offset %s → %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["+2h", "2026-11-09 16:00"],
    ["+12h", "2026-11-10 2:00"],
    ["+30min", "2026-11-09 14:30"],
    ["in 2 hours", "2026-11-09 16:00"],
    ["in 1 hour", "2026-11-09 15:00"],
    ["in 90 minutes", "2026-11-09 15:30"],
  ])("elapsed time %s → %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["nov 20", "2026-11-20"],
    ["Nov 20", "2026-11-20"],
    ["nov. 20", "2026-11-20"],
    ["20 nov", "2026-11-20"],
    ["november 20th", "2026-11-20"],
    ["20th november", "2026-11-20"],
    ["nov 9", "2026-11-09"],
    ["nov 8", "2027-11-08"],
    ["jan 5", "2027-01-05"],
    ["dec 31", "2026-12-31"],
    ["sept 1", "2027-09-01"],
    ["feb 29", "2028-02-29"],
    ["nov 20 2027", "2027-11-20"],
    ["nov 20, 2027", "2027-11-20"],
    ["20 nov 2025", "2025-11-20"],
    ["2026-11-20", "2026-11-20"],
    ["2028-02-29", "2028-02-29"],
  ])("month-day %s → %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["tonight 23:00", "2026-11-09 23:00"],
    ["tonight 1:00", "2026-11-10 1:00"],
    ["tonight 11pm", "2026-11-09 23:00"],
    ["tomorrow 9:00", "2026-11-10 9:00"],
    ["tomorrow at 9am", "2026-11-10 9:00"],
    ["tomorrow 9 am", "2026-11-10 9:00"],
    ["fri 9pm", "2026-11-13 21:00"],
    ["fri at 14:30", "2026-11-13 14:30"],
    ["nov 20 9:30", "2026-11-20 9:30"],
    ["2026-11-20 7:00", "2026-11-20 7:00"],
    ["today 12am", "2026-11-09 0:00"],
    ["today 12pm", "2026-11-09 12:00"],
    ["+1d 8:00", "2026-11-10 8:00"],
  ])("day + time %s → %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["23:00", "2026-11-09 23:00"],
    ["at 23:00", "2026-11-09 23:00"],
    ["9:00", "2026-11-10 9:00"],
    ["at 7am", "2026-11-10 7:00"],
    ["14:00", "2026-11-10 14:00"],
    ["14:01", "2026-11-09 14:01"],
  ])("a time alone %s → its next occurrence: %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each([
    ["nov 31", "invalid: Nov has no day 31"],
    ["31 apr", "invalid: Apr has no day 31"],
    ["feb 30", "invalid: Feb has no day 30"],
    ["nov 0", "invalid: Nov has no day 0"],
    ["feb 29 2027", "invalid: Feb 2027 has 28 days"],
    ["2026-02-30", "invalid: 2026-02-30 is not a real date"],
    ["tomorrow 25:00", "invalid: 25:00 is not a time — use 0:00–23:59"],
    ["tomorrow 7:60", "invalid: 7:60 is not a time — use 0:00–23:59"],
    ["13pm", "invalid: 13pm is not a time — use 1–12 with am/pm"],
    ["nov 31 9:00", "invalid: Nov has no day 31"],
    ["+99999d", "invalid: 99999 days is too far ahead"],
    ["in 10000 hours", "invalid: 10000 hours is too far ahead"],
  ])("invalid %s", (text, out) => {
    expect(read(text)).toBe(out);
  });

  it.each(["", "   ", "buy milk", "tomorrow buy milk", "fri 20", "next fri", "march", "nov", "20", "+3x", "in a week", "3d", "today9:00", "fri at"])(
    "not a date phrase: %j",
    (text) => {
      expect(read(text)).toBe("not-a-date");
    },
  );

  it("ignores case and extra spaces", () => {
    expect(read("  TOMORROW  ")).toBe("2026-11-10");
    expect(read("Nov   20")).toBe("2026-11-20");
    expect(read("Tonight  23:00")).toBe("2026-11-09 23:00");
  });
});

describe("day boundary — the Planner's 03:00", () => {
  useTimeZone("Europe/Madrid");
  const boundary = { hour: 3, minute: 0 };
  const night = at("2026-11-10 1:30");

  it("currentDay: before the boundary it is still yesterday", () => {
    expect(currentDay(night, boundary)).toBe("2026-11-09");
    expect(currentDay(at("2026-11-10 2:59"), boundary)).toBe("2026-11-09");
    expect(currentDay(at("2026-11-10 3:00"), boundary)).toBe("2026-11-10");
    expect(currentDay(night)).toBe("2026-11-10");
  });

  it.each([
    ["today", "2026-11-09", "2026-11-10"],
    ["tomorrow", "2026-11-10", "2026-11-11"],
    ["yesterday", "2026-11-08", "2026-11-09"],
    ["tue", "2026-11-10", "2026-11-17"],
    ["fri", "2026-11-13", "2026-11-13"],
    ["+3d", "2026-11-12", "2026-11-13"],
    ["nov 9", "2026-11-09", "2027-11-09"],
  ])("%s at 01:30 → %s with the boundary, %s with the calendar date", (text, planner, calendar) => {
    expect(show(parseDatePhrase(text, { now: night, dayBoundary: boundary }))).toBe(planner);
    expect(show(parseDatePhrase(text, { now: night }))).toBe(calendar);
  });

  it("elapsed time ignores the boundary", () => {
    expect(show(parseDatePhrase("+2h", { now: night, dayBoundary: boundary }))).toBe("2026-11-10 3:30");
  });
});

describe("DST and year ends", () => {
  describe("Europe/Madrid", () => {
    useTimeZone("Europe/Madrid");

    it("a time skipped by spring-forward moves forward by the gap", () => {
      const r = parseDatePhrase("tomorrow 2:30", { now: at("2026-03-28 22:00") });
      expect(show(r)).toBe("2026-03-29 3:30");
      expect(r.kind === "date-time" && r.at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    });

    it("elapsed hours count real time across fall-back", () => {
      // 01:30 CEST + 2 h = the second 02:30 (CET) — not the first pass `toInstant` would name.
      expect(parseDatePhrase("+2h", { now: at("2026-10-25 1:30") })).toEqual({
        kind: "date-time",
        date: "2026-10-25",
        time: { hour: 2, minute: 30 },
        at: new Date("2026-10-25T01:30:00Z"),
      });
      expect(show(parseDatePhrase("in 1 day", { now: at("2026-10-25 1:30") }))).toBe("2026-10-26");
    });

    it("phrases cross the year end", () => {
      const now = at("2026-12-30 10:00");
      expect(show(parseDatePhrase("jan 2", { now }))).toBe("2027-01-02");
      expect(show(parseDatePhrase("+3d", { now }))).toBe("2027-01-02");
      expect(show(parseDatePhrase("fri", { now }))).toBe("2027-01-01");
      expect(show(parseDatePhrase("dec 30", { now }))).toBe("2026-12-30");
    });

    it("+1mo clamps to a shorter month", () => {
      expect(show(parseDatePhrase("+1mo", { now: at("2027-01-31 10:00") }))).toBe("2027-02-28");
    });
  });

  describe("America/New_York", () => {
    useTimeZone("America/New_York");

    it("a repeated time is its first pass", () => {
      const r = parseDatePhrase("tomorrow 1:30", { now: at("2026-10-31 20:00") });
      expect(show(r)).toBe("2026-11-01 1:30");
      expect(r.kind === "date-time" && r.at.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    });

    it("a time alone after the spring gap", () => {
      expect(show(parseDatePhrase("2:30", { now: at("2026-03-08 1:00") }))).toBe("2026-03-08 3:30");
    });
  });
});
