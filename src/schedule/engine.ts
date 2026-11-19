// Occurrences of a schedule. Pure: time is always a parameter. Dates are calendar dates; times
// are wall-clock times on the Mac's clock, turned into instants by `toInstant` (its DST rules).

import {
  addDays,
  addMonths,
  dateOfDayNumber,
  dayNumber,
  daysInMonth,
  localDateOf,
  MIDNIGHT,
  minutesOf,
  timeOfMinutes,
  toInstant,
  weekdayIndexOfDayNumber,
  WEEKDAYS,
  ymdOfDayNumber,
  type LocalDate,
  type Time,
} from "./local-time.js";
import type { MonthDay, Schedule } from "./schema.js";

/**
 * How far a search walks without finding an occurrence. The Gregorian calendar repeats every
 * 400 years, so a schedule with no occurrence in that span has none.
 */
const HORIZON_DAYS = 146_097;
const LAST_MINUTE = 23 * 60 + 59;

function monthDayMatches(d: MonthDay, day: number, weekdayIndex: number, dim: number): boolean {
  if (typeof d === "number") return day === Math.min(d, dim);
  if (d === "last") return day === dim;
  if (WEEKDAYS[weekdayIndex] !== d.weekday) return false;
  return d.nth === "last" ? day + 7 > dim : Math.ceil(day / 7) === d.nth;
}

/**
 * Whether day `n` is in the cycle of an `every`-th day or week counted from `anchor` (`start`;
 * the parser requires it when `every` > 1, a hand-built schedule without one counts from day 0).
 */
function inCycle(n: number, anchor: number, every: number, unit: "days" | "weeks"): boolean {
  if (every === 1) return true;
  const offset = unit === "days" ? n - anchor : n - weekdayIndexOfDayNumber(n) - (anchor - weekdayIndexOfDayNumber(anchor));
  const period = unit === "days" ? every : every * 7;
  return ((offset % period) + period) % period === 0;
}

/** The wall-clock times of a fixed schedule on day number `n`, or null when it has none that day. */
function timesOn(schedule: Schedule, n: number): Time[] | null {
  const { rule, only, start, end } = schedule;
  if (rule.kind === "once") return n === dayNumber(rule.date) ? [rule.at ?? MIDNIGHT] : null;
  if (rule.kind === "after-completion" || rule.kind === "always") return null;
  if (start !== null && n < dayNumber(start)) return null;
  if (end !== null && n > dayNumber(end)) return null;
  const wd = weekdayIndexOfDayNumber(n);
  const anchor = start === null ? 0 : dayNumber(start);
  if (only === "weekdays" && wd >= 5) return null;
  if (only === "weekends" && wd < 5) return null;
  switch (rule.kind) {
    case "every": {
      const step = rule.unit === "hours" ? rule.count * 60 : rule.count;
      const last = rule.to ? minutesOf(rule.to) : LAST_MINUTE;
      const times: Time[] = [];
      for (let m = rule.from ? minutesOf(rule.from) : 0; m <= last; m += step) times.push(timeOfMinutes(m));
      return times;
    }
    case "daily":
      if (!inCycle(n, anchor, rule.every, "days")) return null;
      return rule.at.length > 0 ? rule.at : [MIDNIGHT];
    case "weekly":
      if (!rule.days.includes(WEEKDAYS[wd] ?? "mon") || !inCycle(n, anchor, rule.every, "weeks")) return null;
      return rule.at.length > 0 ? rule.at : [MIDNIGHT];
    case "monthly": {
      const { year, month, day } = ymdOfDayNumber(n);
      if (rule.months && !rule.months.includes(month)) return null;
      const dim = daysInMonth(year, month);
      if (!rule.days.some((d) => monthDayMatches(d, day, wd, dim))) return null;
      return rule.at.length > 0 ? rule.at : [MIDNIGHT];
    }
  }
}

/** First and last day numbers a fixed schedule can occur on, within the search horizon around `from`. */
function dayRange(schedule: Schedule, from: number): [number, number] {
  const { rule, start, end } = schedule;
  if (rule.kind === "once") {
    const d = dayNumber(rule.date);
    return [d, d];
  }
  return [start === null ? from - HORIZON_DAYS : dayNumber(start), end === null ? from + HORIZON_DAYS : dayNumber(end)];
}

/** The instants of day `n`, ascending, duplicates (two times shifted onto one instant) merged. */
function instantsOn(schedule: Schedule, n: number): Date[] {
  const times = timesOn(schedule, n);
  if (!times) return [];
  const date = dateOfDayNumber(n);
  const ms = [...new Set(times.map((t) => toInstant(date, t).getTime()))].sort((a, b) => a - b);
  return ms.map((t) => new Date(t));
}

// A time on day n can land on day n + 1 only through a gap at midnight, never further, and never
// on day n − 1; so walking from the day before `after` covers every candidate.

/**
 * The first occurrence strictly after `after`, or null (ended, `once` passed, or a schedule with
 * no fixed times: `after-completion`, `always`).
 */
export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  const from = dayNumber(localDateOf(after)) - 1;
  const [lo, hi] = dayRange(schedule, from);
  for (let n = Math.max(from, lo); n <= Math.min(hi, from + HORIZON_DAYS); n++) {
    const hit = instantsOn(schedule, n).find((t) => t > after);
    if (hit) return hit;
  }
  return null;
}

/** The last occurrence strictly before `before`, or null. */
export function previousOccurrence(schedule: Schedule, before: Date): Date | null {
  const from = dayNumber(localDateOf(before));
  const [lo, hi] = dayRange(schedule, from);
  for (let n = Math.min(from, hi); n >= Math.max(lo, from - HORIZON_DAYS); n--) {
    const hit = instantsOn(schedule, n).reverse().find((t) => t < before);
    if (hit) return hit;
  }
  return null;
}

/**
 * Occurrences in `(from, to]`, earliest first, at most `limit` (default 1000) — the runs missed
 * while the Mac slept or was off. For the latest missed run use `previousOccurrence`.
 */
export function occurrencesBetween(schedule: Schedule, from: Date, to: Date, options: { limit?: number } = {}): Date[] {
  const limit = options.limit ?? 1000;
  const out: Date[] = [];
  const first = dayNumber(localDateOf(from)) - 1;
  const [lo, hi] = dayRange(schedule, first);
  const last = Math.min(hi, dayNumber(localDateOf(to)));
  for (let n = Math.max(first, lo); n <= last && out.length < limit; n++) {
    for (const t of instantsOn(schedule, n)) {
      if (t > from && t <= to && (out.length === 0 || t > (out[out.length - 1] as Date))) out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Whether a fixed schedule has an occurrence on `date`. */
export function occursOn(schedule: Schedule, date: LocalDate): boolean {
  return timesOn(schedule, dayNumber(date)) !== null;
}

/**
 * The next date of the schedule after `after` (Planner, whole days).
 * - Fixed schedules: the first date with an occurrence strictly after `after`, or on/after it with
 *   `inclusive`.
 * - `after-completion`: `after` is the completion date; the result is that date plus the period
 *   (months keep the day, clamped to short months), never before `start`.
 * - Null when the schedule has ended, `once` has passed, or for `always`.
 */
export function nextDate(schedule: Schedule, after: LocalDate, options: { inclusive?: boolean } = {}): LocalDate | null {
  const { rule, start, end } = schedule;
  if (rule.kind === "always") return null;
  if (rule.kind === "after-completion") {
    let next =
      rule.unit === "months" ? addMonths(after, rule.count) : addDays(after, rule.unit === "weeks" ? rule.count * 7 : rule.count);
    if (start !== null && next < start) next = start;
    return end !== null && next > end ? null : next;
  }
  const from = dayNumber(after) + (options.inclusive ? 0 : 1);
  const [lo, hi] = dayRange(schedule, from);
  for (let n = Math.max(from, lo); n <= Math.min(hi, from + HORIZON_DAYS); n++) {
    if (timesOn(schedule, n)) return dateOfDayNumber(n);
  }
  return null;
}

/**
 * Dates with an occurrence in `(from, to]`, earliest first, at most `limit` (default 1000) — the
 * Planner's "missed N×" counts these between `do-on` and today. Empty for `after-completion` and
 * `always`, which have no fixed dates.
 */
export function datesBetween(schedule: Schedule, from: LocalDate, to: LocalDate, options: { limit?: number } = {}): LocalDate[] {
  const limit = options.limit ?? 1000;
  const out: LocalDate[] = [];
  const first = dayNumber(from) + 1;
  const [lo, hi] = dayRange(schedule, first);
  const last = Math.min(hi, dayNumber(to));
  for (let n = Math.max(first, lo); n <= last && out.length < limit; n++) {
    if (timesOn(schedule, n)) out.push(dateOfDayNumber(n));
  }
  return out;
}

/** The first date an occurrence on `date` shows up early: `date − lead-days`. */
export function leadStart(schedule: Schedule, date: LocalDate): LocalDate {
  return addDays(date, -schedule.leadDays);
}
