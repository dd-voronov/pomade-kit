import { describe, expect, it } from "vitest";
import { describeDate, describeSchedule } from "./describe.js";
import { parseSchedule } from "./schema.js";

function words(value: Record<string, unknown>): string {
  const r = parseSchedule(value);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return describeSchedule(r.schedule);
}

describe("describeSchedule", () => {
  it.each<[Record<string, unknown>, string]>([
    [{ once: "2026-11-20 23:00" }, "once on Nov 20, 2026 at 23:00"],
    [{ once: "2026-11-20" }, "once on Nov 20, 2026"],
    [{ every: { minutes: 30 } }, "every 30 min"],
    [{ every: { minutes: 1 } }, "every minute"],
    [{ every: { hours: 1 } }, "every hour"],
    [{ every: { hours: 2 } }, "every 2 hours"],
    [{ every: { minutes: 30, from: "9:00", to: "19:00" }, only: "weekdays" }, "every 30 min on weekdays, 9:00–19:00"],
    [{ every: { minutes: 15, from: "9:00" } }, "every 15 min, from 9:00"],
    [{ every: { minutes: 15, to: "6:00" }, only: "weekends" }, "every 15 min on weekends, until 6:00"],
    [{ daily: { at: "7:00" }, only: "weekdays" }, "weekdays at 7:00"],
    [{ daily: { at: "9:30" }, only: "weekends" }, "weekends at 9:30"],
    [{ daily: { at: ["13:00", "20:00"] } }, "daily at 13:00 and 20:00"],
    [{ daily: { at: ["8:00", "13:00", "20:00"] } }, "daily at 8:00, 13:00 and 20:00"],
    [{ daily: {} }, "every day"],
    [{ daily: {}, only: "weekdays" }, "every weekday"],
    [{ daily: {}, only: "weekends" }, "every weekend day"],
    [{ weekly: { days: ["mon", "tue", "wed", "thu", "fri"], at: "7:00" } }, "weekdays at 7:00"],
    [{ weekly: { days: ["sat", "sun"], at: "10:00" } }, "weekends at 10:00"],
    [{ weekly: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } }, "daily"],
    [{ weekly: { days: ["sun"], at: "3:00" } }, "every Sun at 3:00"],
    [{ weekly: { days: ["fri", "mon", "wed"] } }, "every Mon, Wed and Fri"],
    [{ monthly: { days: [5] } }, "monthly on the 5th"],
    [{ monthly: { days: [1, 15] } }, "monthly on the 1st and 15th"],
    [{ monthly: { days: [2, 3, 11, 12, 13, 21, 22, 23, 31] } }, "monthly on the 2nd, 3rd, 11th, 12th, 13th, 21st, 22nd, 23rd and 31st"],
    [{ monthly: { days: ["last"] } }, "monthly on the last day"],
    [{ monthly: { days: ["first mon"], at: "9:00" } }, "monthly on the first Monday at 9:00"],
    [{ monthly: { days: [1, 15, "last", "last fri"] } }, "monthly on the 1st, 15th, the last day and the last Friday"],
    [{ monthly: { days: [5], months: ["jan", "apr", "jul", "oct"] } }, "on the 5th of Jan, Apr, Jul and Oct"],
    [{ monthly: { days: [15], months: ["mar"] } }, "on the 15th of Mar"],
    [{ "after-completion": { months: 3 } }, "3 months after completion"],
    [{ "after-completion": { weeks: 1 } }, "1 week after completion"],
    [{ "after-completion": { days: 10 } }, "10 days after completion"],
    [{ always: true }, "always on"],
    [{ monthly: { days: [5] }, "lead-days": 3 }, "monthly on the 5th, shows 3 days early"],
    [{ daily: {}, "lead-days": 1 }, "every day, shows 1 day early"],
    [{ weekly: { days: ["mon"], at: "7:00" }, start: "2026-01-01" }, "every Mon at 7:00, from Jan 1, 2026"],
    [{ weekly: { days: ["mon"], at: "7:00" }, end: "2026-12-31" }, "every Mon at 7:00, until Dec 31, 2026"],
    [{ monthly: { days: [5] }, start: "2026-01-01", end: "2026-12-31", "lead-days": 3 }, "monthly on the 5th, from Jan 1, 2026 until Dec 31, 2026, shows 3 days early"],
  ])("%j → %s", (value, text) => {
    expect(words(value)).toBe(text);
  });

  it("describeDate", () => {
    expect(describeDate("2026-11-09")).toBe("Nov 9, 2026");
  });
});
