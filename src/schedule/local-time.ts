// Calendar dates and wall-clock times in the Mac's local time zone, on the JS Date local-time
// APIs. Calendar arithmetic (days, months, weekdays) runs on UTC day numbers, so it never meets
// a DST shift; only `toInstant` and `localDateOf` / `localTimeOf` touch the local zone.

/** A calendar date, `YYYY-MM-DD`. */
export type LocalDate = string;

/** A wall-clock time of day, 0:00–23:59. */
export interface Time {
  hour: number;
  minute: number;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Monday first, as the week reads in the UI. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const MIDNIGHT: Time = { hour: 0, minute: 0 };

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

interface Ymd {
  year: number;
  month: number;
  day: number;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYmd(date: string): Ymd | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** A real calendar date written `YYYY-MM-DD` (year 1000 or later). */
export function isLocalDate(value: string): boolean {
  return parseYmd(value) !== null;
}

function ymdOf(date: LocalDate): Ymd {
  const ymd = parseYmd(date);
  if (!ymd) throw new RangeError(`not a date: ${JSON.stringify(date)} (expected YYYY-MM-DD)`);
  return ymd;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatLocalDate(year: number, month: number, day: number): LocalDate {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Days since 1970-01-01 — the engine's day counter. */
export function dayNumber(date: LocalDate): number {
  const { year, month, day } = ymdOf(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function dateOfDayNumber(n: number): LocalDate {
  const d = new Date(n * DAY_MS);
  return formatLocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function ymdOfDayNumber(n: number): Ymd {
  const d = new Date(n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Weekday of a day number, Monday = 0. */
export function weekdayIndexOfDayNumber(n: number): number {
  return (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return dateOfDayNumber(dayNumber(date) + days);
}

/**
 * Same day `months` later (or earlier); a day the target month lacks becomes its last day
 * (Jan 31 + 1 month = Feb 28, or Feb 29 in a leap year).
 */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const { year, month, day } = ymdOf(date);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return formatLocalDate(y, m, Math.min(day, daysInMonth(y, m)));
}

/** `to − from` in days. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return dayNumber(to) - dayNumber(from);
}

export function weekdayOf(date: LocalDate): Weekday {
  return WEEKDAYS[weekdayIndexOfDayNumber(dayNumber(date))] as Weekday;
}

/** The local calendar date of an instant, by the Mac's clock. */
export function localDateOf(instant: Date): LocalDate {
  return formatLocalDate(instant.getFullYear(), instant.getMonth() + 1, instant.getDate());
}

/** The local wall-clock time of an instant (seconds dropped). */
export function localTimeOf(instant: Date): Time {
  return { hour: instant.getHours(), minute: instant.getMinutes() };
}

/**
 * The instant a local date + wall-clock time names. The DST rules are the ECMAScript ones for
 * local time:
 * - a time skipped by a spring-forward change happens as many minutes later as the change
 *   skipped (02:30 on a 02:00 → 03:00 day = 03:30);
 * - a time repeated by a fall-back change is its first pass (01:30 on a 02:00 → 01:00 day = the
 *   01:30 before the change).
 */
export function toInstant(date: LocalDate, time: Time): Date {
  const { year, month, day } = ymdOf(date);
  return new Date(year, month - 1, day, time.hour, time.minute, 0, 0);
}

/** `H:MM` or `HH:MM`, 0:00–23:59. */
export function parseTime(text: string): Time | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** `7:00`, `13:30` — the form the UI and the schedule files use. */
export function formatTime(time: Time): string {
  return `${time.hour}:${pad(time.minute)}`;
}

export function minutesOf(time: Time): number {
  return time.hour * 60 + time.minute;
}

export function timeOfMinutes(minutes: number): Time {
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}
