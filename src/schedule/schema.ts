// The schedule format: a YAML mapping agents write under a frontmatter key (`schedule:` in
// Runner jobs, `repeat:` in Planner items). One shape key says when; modifiers narrow it.

import {
  formatTime,
  isLocalDate,
  MONTH_ABBR,
  monthOfName,
  parseTime,
  weekdayOfName,
  WEEKDAYS,
  type LocalDate,
  type Time,
  type Weekday,
} from "./local-time.js";

export type Nth = 1 | 2 | 3 | 4 | 5 | "last";

/** A day of the month: a number (clamped to short months), the last day, or the nth weekday. */
export type MonthDay = number | "last" | { nth: Nth; weekday: Weekday };

export type Rule =
  /** One date; `at` null in a day schedule. */
  | { kind: "once"; date: LocalDate; at: Time | null }
  /** A grid of times every `count` units from `from` (default 0:00) up to `to` (default 23:59), restarting each day. */
  | { kind: "every"; count: number; unit: "minutes" | "hours"; from: Time | null; to: Time | null }
  /** `at` empty in a day schedule. */
  | { kind: "daily"; at: Time[] }
  | { kind: "weekly"; days: Weekday[]; at: Time[] }
  /** `months` null = every month; else month numbers 1–12. */
  | { kind: "monthly"; days: MonthDay[]; months: number[] | null; at: Time[] }
  | { kind: "after-completion"; count: number; unit: "days" | "weeks" | "months" }
  | { kind: "always" };

export type RuleKind = Rule["kind"];

export interface Schedule {
  rule: Rule;
  /** Weekday filter for `every` and `daily`. */
  only: "weekdays" | "weekends" | null;
  /** First date with occurrences (inclusive). */
  start: LocalDate | null;
  /** Last date with occurrences (inclusive). */
  end: LocalDate | null;
  /** Days before an occurrence it shows up early (Planner). */
  leadDays: number;
}

/**
 * What a consumer accepts:
 * - `"day"` — whole days, no times (Planner): no `every`, `always` or `at`; `once` is a date.
 * - `"time"` — times of day (Runner): `at` is required, `once` needs a time; no
 *   `after-completion`, no `lead-days`.
 * - omitted — anything; a day schedule happens at 0:00.
 */
export type Resolution = "day" | "time";

export interface ScheduleError {
  /** Path inside the schedule mapping: `""` (the mapping itself), `weekly.days[2]`, `lead-days`. */
  field: string;
  /** Readable; says what is allowed. */
  message: string;
}

export type ScheduleParseResult = { ok: true; schedule: Schedule } | { ok: false; errors: ScheduleError[] };

export const SHAPE_KEYS: readonly RuleKind[] = ["once", "every", "daily", "weekly", "monthly", "after-completion", "always"];
const MODIFIER_KEYS = ["only", "start", "end", "lead-days"] as const;
const ALL_KEYS: readonly string[] = [...SHAPE_KEYS, ...MODIFIER_KEYS];

const NTH_WORDS: Record<string, Nth> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: "last",
};

const TIME_HINT = "a time like 7:00 or 13:30 (H:MM, 24-hour)";
const DATE_HINT = "a date like 2026-11-20 (YYYY-MM-DD)";
const WEEKDAY_HINT = "mon, tue, wed, thu, fri, sat or sun";
const show = (v: unknown): string => JSON.stringify(v);

type Fields = Record<string, unknown>;

function isMapping(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Collector {
  readonly errors: ScheduleError[] = [];
  add(field: string, message: string): void {
    this.errors.push({ field, message });
  }

  /** Unknown keys of a nested mapping. */
  keys(obj: Fields, field: string, allowed: readonly string[]): void {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) this.add(`${field}.${k}`, `unknown key — ${field} takes ${allowed.join(", ")}`);
    }
  }

  time(v: unknown, field: string): Time | null {
    const t = typeof v === "string" ? parseTime(v.trim()) : null;
    if (!t) this.add(field, `${show(v)} is not a time — write ${TIME_HINT}`);
    return t;
  }

  date(v: unknown, field: string): LocalDate | null {
    if (typeof v === "string" && isLocalDate(v.trim())) return v.trim();
    this.add(field, `${show(v)} is not a date — write ${DATE_HINT}`);
    return null;
  }

  positiveInt(v: unknown, field: string, max: number): number | null {
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max) return v;
    this.add(field, `${show(v)} is not allowed — use a whole number from 1 to ${max}`);
    return null;
  }

  /** A scalar or a list; a scalar reads as a one-item list. */
  list(v: unknown, field: string, what: string): Array<{ value: unknown; field: string }> | null {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        this.add(field, `empty — list at least one ${what}`);
        return null;
      }
      return v.map((value, i) => ({ value, field: `${field}[${i}]` }));
    }
    if (v === undefined || v === null || isMapping(v)) {
      this.add(field, `required — ${what}, or a list of them`);
      return null;
    }
    return [{ value: v, field }];
  }

  /** `at`: one time or a list; sorted, duplicates dropped. */
  times(v: unknown, field: string): Time[] | null {
    const items = this.list(v, field, TIME_HINT);
    if (!items) return null;
    const parsed = items.map((it) => this.time(it.value, it.field));
    if (parsed.some((t) => t === null)) return null;
    const unique = new Map((parsed as Time[]).map((t) => [t.hour * 60 + t.minute, t]));
    return [...unique.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  }
}

function sortedUnique<T>(items: T[], order: (t: T) => number): T[] {
  const seen = new Map<string, T>();
  for (const it of items) seen.set(JSON.stringify(it), it);
  return [...seen.values()].sort((a, b) => order(a) - order(b));
}

function parseWeekday(c: Collector, v: unknown, field: string): Weekday | null {
  const w = typeof v === "string" ? weekdayOfName(v.trim()) : null;
  if (!w) c.add(field, `${show(v)} is not a weekday — use ${WEEKDAY_HINT}`);
  return w;
}

function parseMonthDay(c: Collector, v: unknown, field: string): MonthDay | null {
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 1 && v <= 31) return v;
  } else if (typeof v === "string") {
    const words = v.trim().toLowerCase().split(/\s+/);
    if (words.length === 1 && words[0] === "last") return "last";
    if (words.length === 2) {
      const nth = NTH_WORDS[words[0] ?? ""];
      const weekday = weekdayOfName(words[1] ?? "");
      if (nth !== undefined && weekday) return { nth, weekday };
    }
  }
  c.add(
    field,
    `${show(v)} is not a day of the month — use a number 1–31 (a day a month lacks becomes its last day), ` +
      `last, or an nth weekday like "first mon", "second tue", "last fri"`,
  );
  return null;
}

function monthDayOrder(d: MonthDay): number {
  if (typeof d === "number") return d;
  if (d === "last") return 40;
  return 50 + (d.nth === "last" ? 6 : d.nth) * 7 + WEEKDAYS.indexOf(d.weekday);
}

function parseMonth(c: Collector, v: unknown, field: string): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12) return v;
  const m = typeof v === "string" ? monthOfName(v.trim()) : null;
  if (m === null) c.add(field, `${show(v)} is not a month — use jan … dec or 1–12`);
  return m;
}

function shapeMapping(c: Collector, v: unknown, field: string, example: string): Fields | null {
  if (isMapping(v)) return v;
  c.add(field, `expected a mapping, like ${field}: ${example}`);
  return null;
}

function parseAt(c: Collector, obj: Fields, field: string, resolution: Resolution | undefined): Time[] | null {
  if (obj.at === undefined) {
    if (resolution === "time") c.add(`${field}.at`, `required — ${TIME_HINT}, or a list like [13:00, 20:00]`);
    return [];
  }
  if (resolution === "day") {
    c.add(`${field}.at`, "times are not used here — these schedules are whole days; remove at");
    return null;
  }
  return c.times(obj.at, `${field}.at`);
}

function parseOnce(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/.exec(v.trim()) : null;
  const date = m?.[1] !== undefined && isLocalDate(m[1]) ? m[1] : null;
  const at = m?.[2] !== undefined ? parseTime(m[2]) : null;
  if (!m || date === null || (m[2] !== undefined && at === null)) {
    c.add("once", `${show(v)} is not a date and time — write it like 2026-11-20 23:00 (YYYY-MM-DD H:MM)`);
    return null;
  }
  if (resolution === "time" && at === null) {
    c.add("once", `needs a time — write it like ${date} 23:00`);
    return null;
  }
  if (resolution === "day" && at !== null) {
    c.add("once", `times are not used here — write the date only, like ${date}`);
    return null;
  }
  return { kind: "once", date, at };
}

function parseEvery(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  if (resolution === "day") {
    c.add("every", "repeats within a day — these schedules are whole days; use daily, weekly or monthly");
    return null;
  }
  const obj = shapeMapping(c, v, "every", "{ minutes: 30 } or { hours: 2, from: 9:00, to: 19:00 }");
  if (!obj) return null;
  c.keys(obj, "every", ["minutes", "hours", "from", "to"]);
  let count: number | null = null;
  let unit: "minutes" | "hours" = "minutes";
  if (obj.minutes !== undefined && obj.hours !== undefined) {
    c.add("every", "give minutes or hours, not both");
  } else if (obj.minutes !== undefined) {
    count = c.positiveInt(obj.minutes, "every.minutes", 1440);
  } else if (obj.hours !== undefined) {
    unit = "hours";
    count = c.positiveInt(obj.hours, "every.hours", 24);
  } else {
    c.add("every", "required — minutes or hours, like every: { minutes: 30 }");
  }
  const from = obj.from === undefined ? null : c.time(obj.from, "every.from");
  const to = obj.to === undefined ? null : c.time(obj.to, "every.to");
  if (from && to && from.hour * 60 + from.minute >= to.hour * 60 + to.minute) {
    c.add("every.to", `${formatTime(to)} is not after from (${formatTime(from)}) — the window runs within one day`);
    return null;
  }
  if (count === null || (obj.from !== undefined && !from) || (obj.to !== undefined && !to)) return null;
  return { kind: "every", count, unit, from, to };
}

function parseDaily(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  const obj = shapeMapping(c, v, "daily", resolution === "day" ? "{}" : "{ at: 7:00 }");
  if (!obj) return null;
  c.keys(obj, "daily", ["at"]);
  const at = parseAt(c, obj, "daily", resolution);
  return at ? { kind: "daily", at } : null;
}

function parseWeekly(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  const obj = shapeMapping(c, v, "weekly", "{ days: [mon, fri], at: 7:00 }");
  if (!obj) return null;
  c.keys(obj, "weekly", ["days", "at"]);
  const items = c.list(obj.days, "weekly.days", `a weekday (${WEEKDAY_HINT})`);
  const days = items?.map((it) => parseWeekday(c, it.value, it.field));
  const at = parseAt(c, obj, "weekly", resolution);
  if (!days || days.some((d) => d === null) || !at) return null;
  return { kind: "weekly", days: sortedUnique(days as Weekday[], (d) => WEEKDAYS.indexOf(d)), at };
}

function parseMonthly(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  const obj = shapeMapping(c, v, "monthly", "{ days: [1, 15] } or { days: [last, first mon] }");
  if (!obj) return null;
  c.keys(obj, "monthly", ["days", "months", "at"]);
  const items = c.list(obj.days, "monthly.days", 'a day of the month (1–31, last, "first mon")');
  const days = items?.map((it) => parseMonthDay(c, it.value, it.field));
  let months: Array<number | null> | null = null;
  if (obj.months !== undefined) {
    months = c.list(obj.months, "monthly.months", "a month (jan … dec)")?.map((it) => parseMonth(c, it.value, it.field)) ?? [null];
  }
  const at = parseAt(c, obj, "monthly", resolution);
  if (!days || days.some((d) => d === null) || months?.some((m) => m === null) || !at) return null;
  return {
    kind: "monthly",
    days: sortedUnique(days as MonthDay[], monthDayOrder),
    months: months ? sortedUnique(months as number[], (m) => m) : null,
    at,
  };
}

function parseAfterCompletion(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  if (resolution === "time") {
    c.add("after-completion", "only for Planner items — a job runs on fixed times; use once, every, daily, weekly or monthly");
    return null;
  }
  const obj = shapeMapping(c, v, "after-completion", "{ months: 3 }");
  if (!obj) return null;
  c.keys(obj, "after-completion", ["days", "weeks", "months"]);
  const units = (["days", "weeks", "months"] as const).filter((u) => obj[u] !== undefined);
  const unit = units[0];
  if (units.length !== 1 || unit === undefined) {
    c.add("after-completion", "give exactly one of days, weeks or months, like after-completion: { months: 3 }");
    return null;
  }
  const count = c.positiveInt(obj[unit], `after-completion.${unit}`, 1000);
  return count === null ? null : { kind: "after-completion", count, unit };
}

function parseAlways(c: Collector, v: unknown, resolution: Resolution | undefined): Rule | null {
  if (resolution === "day") {
    c.add("always", "not a Planner schedule — use daily, weekly, monthly or after-completion");
    return null;
  }
  if (v !== true) {
    c.add("always", `${show(v)} is not allowed — write always: true`);
    return null;
  }
  return { kind: "always" };
}

const SHAPE_PARSERS: Record<RuleKind, (c: Collector, v: unknown, r: Resolution | undefined) => Rule | null> = {
  once: parseOnce,
  every: parseEvery,
  daily: parseDaily,
  weekly: parseWeekly,
  monthly: parseMonthly,
  "after-completion": parseAfterCompletion,
  always: parseAlways,
};

/**
 * Validate a schedule as read from frontmatter (js-yaml JSON values: dates and times are
 * strings). Every problem is reported, each naming its field and what is allowed.
 */
export function parseSchedule(value: unknown, options: { resolution?: Resolution } = {}): ScheduleParseResult {
  const { resolution } = options;
  const c = new Collector();
  if (!isMapping(value)) {
    c.add("", `expected a mapping with one of ${SHAPE_KEYS.join(", ")} — like daily: { at: 7:00 }`);
    return { ok: false, errors: c.errors };
  }
  for (const k of Object.keys(value)) {
    if (!ALL_KEYS.includes(k)) c.add(k, `unknown key — a schedule takes one of ${SHAPE_KEYS.join(", ")}, plus ${MODIFIER_KEYS.join(", ")}`);
  }
  const shapes = SHAPE_KEYS.filter((k) => value[k] !== undefined);
  let rule: Rule | null = null;
  const shape = shapes[0];
  if (shape === undefined) {
    c.add("", `no schedule shape — add one of ${SHAPE_KEYS.join(", ")}`);
  } else if (shapes.length > 1) {
    c.add("", `one shape per schedule — found ${shapes.join(" and ")}; keep one`);
  } else {
    rule = SHAPE_PARSERS[shape](c, value[shape], resolution);
  }

  let only: Schedule["only"] = null;
  if (value.only !== undefined) {
    if (value.only === "weekdays" || value.only === "weekends") only = value.only;
    else c.add("only", `${show(value.only)} is not allowed — use weekdays (Mon–Fri) or weekends (Sat–Sun)`);
    if (shape !== undefined && shape !== "every" && shape !== "daily") {
      c.add("only", `works with every and daily only — ${shape === "weekly" ? "weekly picks its days itself" : `remove it from a ${shape} schedule`}`);
    }
  }

  const bounded = shape !== "once" && shape !== "always";
  const start = value.start === undefined ? null : c.date(value.start, "start");
  const end = value.end === undefined ? null : c.date(value.end, "end");
  for (const k of ["start", "end"] as const) {
    if (value[k] !== undefined && !bounded) c.add(k, `not used with ${shape} — remove it`);
  }
  if (start && end && end < start) c.add("end", `${end} is before start (${start})`);

  let leadDays = 0;
  if (value["lead-days"] !== undefined) {
    const v = value["lead-days"];
    if (resolution === "time") c.add("lead-days", "only for Planner items — remove it");
    else if (shape === "always") c.add("lead-days", "not used with always — remove it");
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3660) leadDays = v;
    else c.add("lead-days", `${show(v)} is not allowed — use a whole number of days, 0 or more (0 = only on the day)`);
  }

  if (c.errors.length > 0 || rule === null) return { ok: false, errors: c.errors };
  return { ok: true, schedule: { rule, only, start, end, leadDays } };
}

/** One error as a line for a person or an agent: `repeat.weekly.days[1]: "fry" is not a weekday — …`. */
export function formatScheduleError(key: string, error: ScheduleError): string {
  return `${error.field === "" ? key : `${key}.${error.field}`}: ${error.message}`;
}

function flowList(items: string[]): string {
  return items.length === 1 ? (items[0] as string) : `[${items.join(", ")}]`;
}

function flowMap(entries: Array<[string, string | null]>): string {
  const parts = entries.filter((e): e is [string, string] => e[1] !== null).map(([k, v]) => `${k}: ${v}`);
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

function atText(at: Time[]): string | null {
  return at.length === 0 ? null : flowList(at.map(formatTime));
}

function monthDayText(d: MonthDay): string {
  if (typeof d === "number") return String(d);
  if (d === "last") return "last";
  const nth = d.nth === "last" ? "last" : (["first", "second", "third", "fourth", "fifth"][d.nth - 1] as string);
  return `${nth} ${d.weekday}`;
}

function ruleText(rule: Rule): string {
  switch (rule.kind) {
    case "once":
      return rule.at ? `${rule.date} ${formatTime(rule.at)}` : rule.date;
    case "every":
      return flowMap([
        [rule.unit, String(rule.count)],
        ["from", rule.from && formatTime(rule.from)],
        ["to", rule.to && formatTime(rule.to)],
      ]);
    case "daily":
      return flowMap([["at", atText(rule.at)]]);
    case "weekly":
      return flowMap([
        ["days", `[${rule.days.join(", ")}]`],
        ["at", atText(rule.at)],
      ]);
    case "monthly":
      return flowMap([
        ["days", `[${rule.days.map(monthDayText).join(", ")}]`],
        ["months", rule.months && `[${rule.months.map((m) => MONTH_ABBR[m - 1]).join(", ")}]`],
        ["at", atText(rule.at)],
      ]);
    case "after-completion":
      return flowMap([[rule.unit, String(rule.count)]]);
    case "always":
      return "true";
  }
}

/**
 * The schedule as frontmatter lines under `key` — the canonical form, which reads back through
 * `parseSchedule` to the same schedule. Fits `setComplexKeyLines` from `pomade-kit/frontmatter`.
 */
export function formatSchedule(key: string, schedule: Schedule): string {
  const lines = [`${key}:`, `  ${schedule.rule.kind}: ${ruleText(schedule.rule)}`];
  if (schedule.only) lines.push(`  only: ${schedule.only}`);
  if (schedule.start) lines.push(`  start: ${schedule.start}`);
  if (schedule.end) lines.push(`  end: ${schedule.end}`);
  if (schedule.leadDays > 0) lines.push(`  lead-days: ${schedule.leadDays}`);
  return lines.join("\n");
}
