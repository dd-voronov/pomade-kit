import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFrontmatter } from "../protocol/frontmatter.js";
import { formatSchedule, formatScheduleError, parseSchedule, type Resolution, type Schedule } from "./schema.js";

/** The value under `key` in a frontmatter block, read the way Pomade reads frontmatter. */
function yamlValue(yaml: string, key = "schedule"): unknown {
  const r = readFrontmatter(`---\n${yaml}\n---\n`);
  if (!("frontmatter" in r) || r.frontmatter === null) throw new Error(`unreadable: ${JSON.stringify(r)}`);
  return r.frontmatter[key];
}

function parsed(yaml: string, resolution?: Resolution): Schedule {
  const r = parseSchedule(yamlValue(yaml), resolution ? { resolution } : {});
  if (!r.ok) throw new Error(r.errors.map((e) => formatScheduleError("schedule", e)).join("\n"));
  return r.schedule;
}

function errors(value: unknown, resolution?: Resolution): Array<[string, string]> {
  const r = parseSchedule(value, resolution ? { resolution } : {});
  if (r.ok) throw new Error("expected errors");
  return r.errors.map((e) => [e.field, e.message]);
}

const base = { only: null, start: null, end: null, leadDays: 0 };

describe("parseSchedule — every shape from YAML", () => {
  it("once at a date and time", () => {
    expect(parsed("schedule:\n  once: 2026-11-20 23:00")).toEqual({ ...base, rule: { kind: "once", date: "2026-11-20", at: { hour: 23, minute: 0 } } });
  });

  it("once on a date (day schedule)", () => {
    expect(parsed("schedule:\n  once: 2026-11-20", "day").rule).toEqual({ kind: "once", date: "2026-11-20", at: null });
  });

  it("every N minutes within hours, weekdays only", () => {
    expect(parsed("schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays")).toEqual({
      ...base,
      only: "weekdays",
      rule: { kind: "every", count: 30, unit: "minutes", from: { hour: 9, minute: 0 }, to: { hour: 19, minute: 0 } },
    });
  });

  it("every N hours, all day", () => {
    expect(parsed("schedule:\n  every: { hours: 2 }").rule).toEqual({ kind: "every", count: 2, unit: "hours", from: null, to: null });
  });

  it("daily at several times, sorted, duplicates dropped", () => {
    expect(parsed("schedule:\n  daily: { at: [20:00, 13:00, '13:00'] }").rule).toEqual({
      kind: "daily",
      every: 1,
      at: [{ hour: 13, minute: 0 }, { hour: 20, minute: 0 }],
    });
  });

  it("daily at one time written as a scalar, block style", () => {
    expect(parsed("schedule:\n  daily:\n    at: 7:00").rule).toEqual({ kind: "daily", every: 1, at: [{ hour: 7, minute: 0 }] });
  });

  it("daily with no times (day schedule)", () => {
    expect(parsed("schedule:\n  daily: {}", "day").rule).toEqual({ kind: "daily", every: 1, at: [] });
  });

  it("weekly on chosen days, full and short names, Monday-first order", () => {
    expect(parsed("schedule:\n  weekly: { days: [Friday, mon, wed, mon], at: 7:00 }").rule).toEqual({
      kind: "weekly",
      every: 1,
      days: ["mon", "wed", "fri"],
      at: [{ hour: 7, minute: 0 }],
    });
  });

  it("every N days from a start date", () => {
    expect(parsed("schedule:\n  daily: { every: 10 }\n  start: 2027-01-03", "day")).toEqual({
      ...base,
      start: "2027-01-03",
      rule: { kind: "daily", every: 10, at: [] },
    });
    expect(parsed("schedule:\n  daily: { every: 3, at: [9:00, 7:00] }\n  start: 2027-01-03", "time").rule).toEqual({
      kind: "daily",
      every: 3,
      at: [{ hour: 7, minute: 0 }, { hour: 9, minute: 0 }],
    });
  });

  it("every N weeks on chosen days from a start date", () => {
    expect(parsed("schedule:\n  weekly: { every: 2, days: [mon] }\n  start: 2026-11-23", "day")).toEqual({
      ...base,
      start: "2026-11-23",
      rule: { kind: "weekly", every: 2, days: ["mon"], at: [] },
    });
    expect(parsed("schedule:\n  weekly:\n    every: 3\n    days: [thu, Monday]\n    at: 7:00\n  start: 2026-11-23", "time").rule).toEqual({
      kind: "weekly",
      every: 3,
      days: ["mon", "thu"],
      at: [{ hour: 7, minute: 0 }],
    });
  });

  it("every: 1 is the plain shape and needs no start", () => {
    expect(parsed("schedule:\n  daily: { every: 1, at: 7:00 }")).toEqual(parsed("schedule:\n  daily: { at: 7:00 }"));
    expect(parsed("schedule:\n  weekly: { every: 1, days: [mon] }")).toEqual(parsed("schedule:\n  weekly: { days: [mon] }"));
  });

  it("monthly on numbers, the last day and nth weekdays, with a months filter", () => {
    expect(parsed("schedule:\n  monthly: { days: [last fri, 15, last, 1, first mon], months: [oct, 1, apr, jul], at: 9:00 }").rule).toEqual({
      kind: "monthly",
      days: [1, 15, "last", { nth: 1, weekday: "mon" }, { nth: "last", weekday: "fri" }],
      months: [1, 4, 7, 10],
      at: [{ hour: 9, minute: 0 }],
    });
  });

  it("monthly as the Planner writes it", () => {
    expect(parsed("schedule:\n  monthly: { days: [5] }\n  lead-days: 3\n  start: 2026-01-01", "day")).toEqual({
      ...base,
      start: "2026-01-01",
      leadDays: 3,
      rule: { kind: "monthly", days: [5], months: null, at: [] },
    });
  });

  it("after completion in days, weeks or months", () => {
    expect(parsed("schedule:\n  after-completion: { months: 3 }").rule).toEqual({ kind: "after-completion", count: 3, unit: "months" });
    expect(parsed("schedule:\n  after-completion: { weeks: 2 }").rule).toEqual({ kind: "after-completion", count: 2, unit: "weeks" });
    expect(parsed("schedule:\n  after-completion: { days: 10 }").rule).toEqual({ kind: "after-completion", count: 10, unit: "days" });
  });

  it("always on", () => {
    expect(parsed("schedule:\n  always: true", "time").rule).toEqual({ kind: "always" });
  });

  it("start and end dates", () => {
    expect(parsed("schedule:\n  daily: { at: 7:00 }\n  start: 2026-01-01\n  end: 2026-12-31")).toMatchObject({ start: "2026-01-01", end: "2026-12-31" });
  });
});

describe("parseSchedule — readable errors", () => {
  it.each<[unknown, string, RegExp]>([
    [null, "", /expected a mapping with one of once, every/],
    [[], "", /expected a mapping/],
    ["daily at 7", "", /expected a mapping/],
    [{}, "", /no schedule shape — add one of/],
    [{ only: "weekdays" }, "", /no schedule shape/],
    [{ daily: { at: "7:00" }, weekly: { days: ["mon"], at: "7:00" } }, "", /one shape per schedule — found daily and weekly/],
    [{ daily: { at: "7:00" }, cron: "0 7 * * *" }, "cron", /unknown key — a schedule takes one of/],
    [{ once: "tonight" }, "once", /not a date and time — write it like 2026-11-20 23:00/],
    [{ once: "2026-02-30 10:00" }, "once", /not a date and time/],
    [{ once: "2026-11-20 25:00" }, "once", /not a date and time/],
    [{ every: 30 }, "every", /expected a mapping, like every: \{ minutes: 30 \}/],
    [{ every: {} }, "every", /required — minutes or hours/],
    [{ every: { minutes: 30, hours: 1 } }, "every", /minutes or hours, not both/],
    [{ every: { minutes: 0 } }, "every.minutes", /whole number from 1 to 1440/],
    [{ every: { minutes: 2.5 } }, "every.minutes", /whole number/],
    [{ every: { hours: 25 } }, "every.hours", /from 1 to 24/],
    [{ every: { minutes: 30, from: "19:00", to: "9:00" } }, "every.to", /9:00 is not after from \(19:00\)/],
    [{ every: { minutes: 30, from: "9" } }, "every.from", /"9" is not a time — write a time like 7:00/],
    [{ every: { minutes: 30, between: "9-19" } }, "every.between", /unknown key — every takes minutes, hours, from, to/],
    [{ daily: "7:00" }, "daily", /expected a mapping, like daily: \{ at: 7:00 \}/],
    [{ daily: { at: [] } }, "daily.at", /empty — list at least one/],
    [{ daily: { at: ["7:00", "7.30"] } }, "daily.at[1]", /"7.30" is not a time/],
    [{ daily: { at: 700 } }, "daily.at", /700 is not a time/],
    [{ weekly: { at: "7:00" } }, "weekly.days", /required — a weekday/],
    [{ daily: { every: 10 } }, "start", /required with daily.every — the date the days count from, like start: 2027-01-04/],
    [{ weekly: { every: 2, days: ["mon"] } }, "start", /required with weekly.every — the date the weeks count from/],
    [{ daily: { every: 0 }, start: "2027-01-03" }, "daily.every", /whole number from 1 to 1000/],
    [{ daily: { every: 1001 }, start: "2027-01-03" }, "daily.every", /from 1 to 1000/],
    [{ daily: { every: 2.5 }, start: "2027-01-03" }, "daily.every", /whole number/],
    [{ weekly: { every: "2", days: ["mon"] }, start: "2027-01-03" }, "weekly.every", /"2" is not allowed — use a whole number/],
    [{ daily: { days: 10 } }, "daily.days", /unknown key — daily takes every, at/],
    [{ weekly: { days: ["mon"], weeks: 2 } }, "weekly.weeks", /unknown key — weekly takes every, days, at/],
    [{ weekly: { every: 2, days: ["mon"] }, start: "2027-01-03", only: "weekdays" }, "only", /weekly picks its days itself/],
    [{ weekly: { days: ["mon", "fry"], at: "7:00" } }, "weekly.days[1]", /"fry" is not a weekday — use mon, tue, wed, thu, fri, sat or sun/],
    [{ monthly: { days: [0] } }, "monthly.days[0]", /not a day of the month — use a number 1–31/],
    [{ monthly: { days: [32] } }, "monthly.days[0]", /not a day of the month/],
    [{ monthly: { days: ["sixth mon"] } }, "monthly.days[0]", /nth weekday like "first mon"/],
    [{ monthly: { days: ["first"] } }, "monthly.days[0]", /not a day of the month/],
    [{ monthly: { days: [1], months: ["foo"] } }, "monthly.months[0]", /"foo" is not a month — use jan … dec or 1–12/],
    [{ monthly: { days: [1], months: [13] } }, "monthly.months[0]", /not a month/],
    [{ monthly: { days: [1], months: [] } }, "monthly.months", /empty/],
    [{ "after-completion": { months: 3, days: 2 } }, "after-completion", /exactly one of days, weeks or months/],
    [{ "after-completion": { years: 1 } }, "after-completion.years", /unknown key/],
    [{ "after-completion": { months: -1 } }, "after-completion.months", /whole number from 1/],
    [{ always: "yes" }, "always", /write always: true/],
    [{ daily: { at: "7:00" }, only: "workdays" }, "only", /use weekdays \(Mon–Fri\) or weekends \(Sat–Sun\)/],
    [{ weekly: { days: ["mon"], at: "7:00" }, only: "weekdays" }, "only", /weekly picks its days itself/],
    [{ monthly: { days: [1], at: "7:00" }, only: "weekends" }, "only", /works with every and daily only/],
    [{ daily: { at: "7:00" }, start: "2026-13-01" }, "start", /not a date — write a date like 2026-11-20/],
    [{ daily: { at: "7:00" }, start: "2026-12-01", end: "2026-11-01" }, "end", /2026-11-01 is before start \(2026-12-01\)/],
    [{ once: "2026-11-20 10:00", start: "2026-11-01" }, "start", /not used with once/],
    [{ always: true, end: "2026-11-01" }, "end", /not used with always/],
    [{ always: true, "lead-days": 1 }, "lead-days", /not used with always/],
    [{ daily: {}, "lead-days": -1 }, "lead-days", /whole number of days, 0 or more/],
    [{ daily: {}, "lead-days": "3" }, "lead-days", /"3" is not allowed/],
  ])("%j → %s", (value, field, message) => {
    const errs = errors(value);
    expect(errs.map((e) => e[0])).toContain(field);
    expect(errs.find((e) => e[0] === field)?.[1]).toMatch(message);
  });

  it("reports every problem at once", () => {
    expect(errors({ weekly: { days: ["fry", "sundae"], at: "25:00" }, start: "x" }).map((e) => e[0])).toEqual([
      "weekly.days[0]",
      "weekly.days[1]",
      "weekly.at",
      "start",
    ]);
  });

  it("formats an error with the frontmatter key", () => {
    const [field, message] = errors({ weekly: { days: ["fry"], at: "7:00" } })[0] ?? ["", ""];
    expect(formatScheduleError("repeat", { field, message })).toBe(
      'repeat.weekly.days[0]: "fry" is not a weekday — use mon, tue, wed, thu, fri, sat or sun',
    );
    expect(formatScheduleError("repeat", { field: "", message: "no schedule shape" })).toBe("repeat: no schedule shape");
  });
});

describe("parseSchedule — resolution", () => {
  it.each<[unknown, string, RegExp]>([
    [{ every: { minutes: 30 } }, "every", /these schedules are whole days/],
    [{ always: true }, "always", /not a Planner schedule/],
    [{ daily: { at: "7:00" } }, "daily.at", /times are not used here/],
    [{ weekly: { days: ["mon"], at: "7:00" } }, "weekly.at", /times are not used here/],
    [{ once: "2026-11-20 10:00" }, "once", /write the date only, like 2026-11-20/],
  ])("day refuses %j", (value, field, message) => {
    expect(errors(value, "day")).toEqual([[field, expect.stringMatching(message)]]);
  });

  it.each<[unknown, string, RegExp]>([
    [{ daily: {} }, "daily.at", /required — a time like 7:00/],
    [{ weekly: { days: ["mon"] } }, "weekly.at", /required/],
    [{ monthly: { days: [1] } }, "monthly.at", /required/],
    [{ once: "2026-11-20" }, "once", /needs a time — write it like 2026-11-20 23:00/],
    [{ "after-completion": { months: 1 } }, "after-completion", /only for Planner items/],
    [{ daily: { at: "7:00" }, "lead-days": 2 }, "lead-days", /only for Planner items/],
  ])("time refuses %j", (value, field, message) => {
    expect(errors(value, "time")).toEqual([[field, expect.stringMatching(message)]]);
  });

  it("no resolution accepts both day and time schedules", () => {
    expect(parseSchedule({ daily: {} }).ok).toBe(true);
    expect(parseSchedule({ daily: { at: "7:00" }, "lead-days": 1 }).ok).toBe(true);
  });
});

describe("formatSchedule — canonical YAML that reads back to the same schedule", () => {
  it.each([
    "schedule:\n  once: 2026-11-20 23:00",
    "schedule:\n  once: 2026-11-20",
    "schedule:\n  every: { minutes: 30, from: 9:00, to: 19:00 }\n  only: weekdays",
    "schedule:\n  every: { hours: 2 }",
    "schedule:\n  every: { minutes: 15, to: 6:00 }",
    "schedule:\n  daily: { at: [13:00, 20:00] }",
    "schedule:\n  daily: {}\n  only: weekends",
    "schedule:\n  weekly: { days: [mon, fri], at: 7:00 }",
    "schedule:\n  weekly: { days: [sun] }\n  start: 2026-01-01\n  end: 2026-12-31",
    "schedule:\n  daily: { every: 10 }\n  start: 2027-01-03",
    "schedule:\n  daily: { every: 3, at: [7:00, 19:00] }\n  only: weekdays\n  start: 2027-01-03\n  end: 2027-06-30",
    "schedule:\n  weekly: { every: 2, days: [mon] }\n  start: 2026-11-23\n  lead-days: 1",
    "schedule:\n  weekly: { every: 4, days: [tue, sat], at: 6:30 }\n  start: 2026-11-23",
    "schedule:\n  monthly: { days: [1, 15, last, first mon, last fri], months: [jan, apr, jul, oct], at: 9:00 }",
    "schedule:\n  monthly: { days: [5] }\n  start: 2026-01-01\n  lead-days: 3",
    "schedule:\n  after-completion: { months: 3 }\n  lead-days: 7",
    "schedule:\n  always: true",
  ])("%s", (yaml) => {
    const schedule = parsed(yaml);
    expect(formatSchedule("schedule", schedule)).toBe(yaml);
    expect(parsed(formatSchedule("schedule", schedule))).toEqual(schedule);
  });

  it("writes hand-written variants in canonical form", () => {
    expect(formatSchedule("repeat", parsed("schedule:\n  weekly:\n    days: [Friday, monday]\n    at: [07:00]"))).toBe(
      "repeat:\n  weekly: { days: [mon, fri], at: 7:00 }",
    );
    expect(formatSchedule("repeat", parsed("schedule:\n  weekly: { at: 7:00, days: [mon], every: 1 }"))).toBe("repeat:\n  weekly: { days: [mon], at: 7:00 }");
    expect(formatSchedule("repeat", parsed("schedule:\n  start: 2026-11-23\n  weekly:\n    days: Monday\n    every: 2"))).toBe(
      "repeat:\n  weekly: { every: 2, days: [mon] }\n  start: 2026-11-23",
    );
  });
});

describe("README examples", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Schedules"), readme.indexOf("## ", readme.indexOf("## Schedules") + 3));
  const blocks = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

  it("has the examples", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });

  it.each(blocks)("validates:\n%s", (yaml) => {
    const key = yaml.startsWith("repeat:") ? "repeat" : "schedule";
    const r = parseSchedule(yamlValue(yaml.trimEnd(), key), { resolution: key === "repeat" ? "day" : "time" });
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});
