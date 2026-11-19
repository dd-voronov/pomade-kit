import { describe, expect, it } from "vitest";
import { addDays, toInstant } from "../schedule/local-time.js";
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

describe("currentDay never moves backwards across DST", () => {
  const MIN = 60_000;
  const boundaries = (step: number, from = 0, to = 24 * 60 - 1) => {
    const out: Array<{ hour: number; minute: number }> = [];
    for (let m = from; m <= to; m += step) out.push({ hour: Math.floor(m / 60), minute: m % 60 });
    return out;
  };

  /** currentDay at every `step` minutes over [from, to]: never backwards, one change per night. */
  function sweep(from: Date, to: Date, boundary: { hour: number; minute: number }, step: number): string[] {
    const days: string[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += step * MIN) {
      const day = currentDay(new Date(t), boundary);
      if (days.length > 0) expect(day >= (days[days.length - 1] as string), `${new Date(t).toISOString()} boundary ${boundary.hour}:${boundary.minute}`).toBe(true);
      if (days[days.length - 1] !== day) days.push(day);
    }
    return days;
  }

  describe("Europe/Madrid (fall 2026-10-25 03:00 → 02:00, spring 2026-03-29 02:00 → 03:00)", () => {
    useTimeZone("Europe/Madrid");

    it.each([
      ["2:30", "2026-10-25T00:29:00Z", "2026-10-24"], // 02:29 CEST
      ["2:30", "2026-10-25T00:30:00Z", "2026-10-25"], // 02:30 CEST — the day starts
      ["2:30", "2026-10-25T01:00:00Z", "2026-10-25"], // 02:00 CET, the clock is back at 02:00
      ["2:30", "2026-10-25T01:29:00Z", "2026-10-25"], // 02:29 CET
      ["2:30", "2026-10-25T01:30:00Z", "2026-10-25"], // 02:30 CET
      ["2:00", "2026-10-24T23:59:00Z", "2026-10-24"], // 01:59 CEST
      ["2:00", "2026-10-25T00:00:00Z", "2026-10-25"], // 02:00 CEST
      ["2:00", "2026-10-25T01:00:00Z", "2026-10-25"], // 02:00 CET
      ["2:59", "2026-10-25T00:58:00Z", "2026-10-24"], // 02:58 CEST
      ["2:59", "2026-10-25T00:59:00Z", "2026-10-25"], // 02:59 CEST
      ["2:59", "2026-10-25T01:58:00Z", "2026-10-25"], // 02:58 CET
      ["3:00", "2026-10-25T00:59:00Z", "2026-10-24"], // 02:59 CEST
      ["3:00", "2026-10-25T01:59:00Z", "2026-10-24"], // 02:59 CET — 03:00 happens once, after the repeated hour
      ["3:00", "2026-10-25T02:00:00Z", "2026-10-25"], // 03:00 CET
      ["2:30", "2026-03-29T00:59:00Z", "2026-03-28"], // 01:59 CET
      ["2:30", "2026-03-29T01:00:00Z", "2026-03-29"], // 03:00 CEST — the clock jumped over 02:30
      ["3:00", "2026-03-29T00:59:00Z", "2026-03-28"], // 01:59 CET
      ["3:00", "2026-03-29T01:00:00Z", "2026-03-29"], // 03:00 CEST
      ["3:30", "2026-03-29T01:29:00Z", "2026-03-28"], // 03:29 CEST
      ["3:30", "2026-03-29T01:30:00Z", "2026-03-29"], // 03:30 CEST
    ])("boundary %s at %s → %s", (b, instant, day) => {
      const [hour = 0, minute = 0] = b.split(":").map(Number);
      expect(currentDay(new Date(instant), { hour, minute })).toBe(day);
    });

    it("every boundary 2:00–2:59, minute by minute through the fall-back night: one change, never back", () => {
      for (const b of boundaries(1, 120, 179)) {
        expect(sweep(new Date("2026-10-24T22:00:00Z"), new Date("2026-10-25T04:00:00Z"), b, 1)).toEqual(["2026-10-24", "2026-10-25"]);
      }
    });

    it("every boundary 2:00–2:59, minute by minute through the spring-forward night: one change, never back", () => {
      for (const b of boundaries(1, 120, 179)) {
        expect(sweep(new Date("2026-03-28T22:00:00Z"), new Date("2026-03-29T04:00:00Z"), b, 1)).toEqual(["2026-03-28", "2026-03-29"]);
      }
    });

    it("every quarter-hour boundary over both change days: days follow one another, never back", () => {
      const consecutive = (days: string[]) => days.every((d, i) => i === 0 || d === addDays(days[i - 1] as string, 1));
      for (const b of boundaries(15)) {
        expect(consecutive(sweep(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-27T00:00:00Z"), b, 5))).toBe(true);
        expect(consecutive(sweep(new Date("2026-03-28T00:00:00Z"), new Date("2026-03-31T00:00:00Z"), b, 5))).toBe(true);
      }
      // ~3 s alone: 96 boundaries × two 3-day sweeps at 5-minute steps; room for a loaded machine.
    }, 30_000);
  });

  describe("America/New_York (fall 2026-11-01 02:00 → 01:00)", () => {
    useTimeZone("America/New_York");

    it("a 1:30 boundary stays passed through the repeated hour", () => {
      expect(currentDay(new Date("2026-11-01T05:29:00Z"), { hour: 1, minute: 30 })).toBe("2026-10-31"); // 01:29 EDT
      expect(currentDay(new Date("2026-11-01T05:30:00Z"), { hour: 1, minute: 30 })).toBe("2026-11-01"); // 01:30 EDT
      expect(currentDay(new Date("2026-11-01T06:00:00Z"), { hour: 1, minute: 30 })).toBe("2026-11-01"); // 01:00 EST
      for (const b of boundaries(1, 60, 119)) {
        expect(sweep(new Date("2026-11-01T03:00:00Z"), new Date("2026-11-01T09:00:00Z"), b, 1)).toEqual(["2026-10-31", "2026-11-01"]);
      }
    });
  });
});

describe("datetime-local — YYYY-MM-DDTHH:MM", () => {
  describe("Europe/Madrid", () => {
    useTimeZone("Europe/Madrid");
    const now = at("2026-11-09 14:00");
    const read = (text: string, dayBoundary?: { hour: number; minute: number }) =>
      show(parseDatePhrase(text, dayBoundary ? { now, dayBoundary } : { now }));

    it.each([
      ["2026-11-20T09:30", "2026-11-20 9:30"],
      ["2026-11-20t09:30", "2026-11-20 9:30"],
      [" 2026-11-20T23:59 ", "2026-11-20 23:59"],
      ["2026-11-20T00:00", "2026-11-20 0:00"],
      ["2026-11-09T13:00", "2026-11-09 13:00"], // earlier today: the moment as written, not moved ahead
      ["2025-01-01T08:00", "2025-01-01 8:00"],
      ["2028-02-29T12:00", "2028-02-29 12:00"],
    ])("%s → %s", (text, out) => {
      expect(read(text)).toBe(out);
    });

    it("is that local moment", () => {
      expect(parseDatePhrase("2026-11-20T09:30", { now })).toEqual({
        kind: "date-time",
        date: "2026-11-20",
        time: { hour: 9, minute: 30 },
        at: new Date("2026-11-20T08:30:00Z"),
      });
    });

    it("ignores the day boundary", () => {
      expect(read("2026-11-10T01:30", { hour: 3, minute: 0 })).toBe("2026-11-10 1:30");
    });

    it.each([
      ["2026-02-30T10:00", "invalid: 2026-02-30 is not a real date"],
      ["2027-02-29T10:00", "invalid: 2027-02-29 is not a real date"],
      ["2026-11-20T24:00", "invalid: 24:00 is not a time — use 00:00–23:59"],
      ["2026-11-20T09:60", "invalid: 09:60 is not a time — use 00:00–23:59"],
      ["2026-11-20T9:30", "not-a-date"],
      ["2026-11-20T09:30:15", "not-a-date"],
      ["2026-11-20T09", "not-a-date"],
      ["2026-11-20T", "not-a-date"],
    ])("%s → %s", (text, out) => {
      expect(read(text)).toBe(out);
    });

    it("follows the DST rules: a skipped time moves forward, a repeated one is its first pass", () => {
      const spring = parseDatePhrase("2026-03-29T02:30", { now });
      expect(show(spring)).toBe("2026-03-29 3:30");
      expect(spring.kind === "date-time" && spring.at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
      const fall = parseDatePhrase("2026-10-25T02:30", { now });
      expect(show(fall)).toBe("2026-10-25 2:30");
      expect(fall.kind === "date-time" && fall.at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    });
  });

  describe("America/New_York", () => {
    useTimeZone("America/New_York");

    it("is the local moment in that zone", () => {
      const r = parseDatePhrase("2026-11-20T09:30", { now: at("2026-11-09 14:00") });
      expect(r.kind === "date-time" && r.at.toISOString()).toBe("2026-11-20T14:30:00.000Z");
    });
  });
});
