// Short typed phrases → dates: `fri`, `tomorrow`, `+3d`, `nov 20`, `tonight 23:00`, `in 2 hours`.
// Pure: `now` is a parameter. Day phrases count from the reference day — the calendar date, or
// the Planner's day when a day boundary is given (at 01:30 with a 03:00 boundary it is still
// yesterday).

import {
  addDays,
  addMonths,
  daysInMonth,
  formatLocalDate,
  isLocalDate,
  localDateOf,
  localTimeOf,
  minutesOf,
  monthOfName,
  parseTime,
  toInstant,
  weekdayOf,
  weekdayOfName,
  WEEKDAYS,
  type LocalDate,
  type Time,
} from "../schedule/local-time.js";

export type DatePhrase =
  /** A whole day. */
  | { kind: "date"; date: LocalDate }
  /** A moment: `at`, and its local date and wall-clock time (after the DST rules of `toInstant`). */
  | { kind: "date-time"; date: LocalDate; time: Time; at: Date }
  /** Reads as a date phrase but names no real date or time ("nov 31", "tomorrow 25:00"). */
  | { kind: "invalid"; message: string }
  /** Not a date phrase at all — treat the text as something else. */
  | { kind: "not-a-date" };

export interface DatePhraseOptions {
  /** The current instant. */
  now: Date;
  /** When a day starts; default 0:00 (the calendar date). The Planner passes 3:00. */
  dayBoundary?: Time;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_AMOUNT = 9999;
const NOT_A_DATE: DatePhrase = { kind: "not-a-date" };

/**
 * The day `now` belongs to: its calendar date, or the day before while the clock has not yet
 * reached the boundary today. It never moves backwards: on a fall-back night the boundary is
 * passed on the first pass of the repeated hour, and the day stays when the clock shows the
 * earlier wall times again (02:30 boundary, Madrid 03:00 → 02:00: the day starts at 02:30 CEST
 * and stays through 02:00–02:59 CET). On a spring-forward night a boundary inside the gap is
 * passed when the clock jumps over it.
 */
export function currentDay(now: Date, dayBoundary: Time = { hour: 0, minute: 0 }): LocalDate {
  const today = localDateOf(now);
  if (minutesOf(localTimeOf(now)) >= minutesOf(dayBoundary)) return today;
  return toInstant(today, dayBoundary) <= now ? today : addDays(today, -1);
}

type Parsed<T> = T | { invalid: string } | null;

const isInvalid = (v: unknown): v is { invalid: string } => typeof v === "object" && v !== null && "invalid" in v;

const TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

/** `23:00`, `9:30`, `9pm`, `9:30am`; a bare number is not a time. */
function parseClock(text: string): Parsed<Time> {
  const m = TIME_RE.exec(text);
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (m[3] === undefined) return parseTime(text) ?? { invalid: `${text} is not a time — use 0:00–23:59` };
  if (hour < 1 || hour > 12 || minute > 59) return { invalid: `${text} is not a time — use 1–12 with am/pm` };
  return { hour: (hour % 12) + (m[3] === "pm" ? 12 : 0), minute };
}

const DAY_UNITS: Record<string, "days" | "weeks" | "months"> = {
  d: "days", day: "days", days: "days",
  w: "weeks", wk: "weeks", wks: "weeks", week: "weeks", weeks: "weeks",
  mo: "months", month: "months", months: "months",
};
const TIME_UNITS: Record<string, number> = {
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  min: 1, mins: 1, minute: 1, minutes: 1,
};

/** A month-day in `year` or, without a year, the first one on/after `from`. */
function monthDay(month: number, day: number, year: number | null, from: LocalDate): Parsed<LocalDate> {
  const name = MONTH_NAMES[month - 1] ?? "";
  if (day < 1 || day > 31 || (month !== 2 && day > daysInMonth(2000, month)) || (month === 2 && day > 29)) {
    return { invalid: `${name} has no day ${day}` };
  }
  if (year !== null) {
    const date = formatLocalDate(year, month, day);
    return isLocalDate(date) ? date : { invalid: `${name} ${year} has ${daysInMonth(year, month)} days` };
  }
  const fromYear = Number(from.slice(0, 4));
  for (let y = fromYear; y <= fromYear + 8; y++) {
    const date = formatLocalDate(y, month, day);
    if (isLocalDate(date) && date >= from) return date;
  }
  return null;
}

/** A day phrase (no time) relative to the reference day `today`. */
function parseDay(text: string, today: LocalDate): Parsed<{ date: LocalDate; tonight: boolean }> {
  const day = (date: LocalDate) => ({ date, tonight: false });
  if (text === "today") return day(today);
  if (text === "tonight") return { date: today, tonight: true };
  if (text === "tomorrow") return day(addDays(today, 1));
  if (text === "yesterday") return day(addDays(today, -1));

  const weekday = weekdayOfName(text);
  if (weekday) {
    const ahead = (WEEKDAYS.indexOf(weekday) - WEEKDAYS.indexOf(weekdayOf(today)) + 7) % 7 || 7;
    return day(addDays(today, ahead));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isLocalDate(text) ? day(text) : { invalid: `${text} is not a real date` };

  const md = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(text);
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(text);
  const parts = md ? { month: md[1], day: md[2], year: md[3] } : dm ? { month: dm[2], day: dm[1], year: dm[3] } : null;
  const month = parts ? monthOfName(parts.month ?? "") : null;
  if (parts && month !== null) {
    const r = monthDay(month, Number(parts.day), parts.year === undefined ? null : Number(parts.year), today);
    return r === null || isInvalid(r) ? r : day(r);
  }

  const rel = /^(?:\+\s*|in\s+)(\d+)\s*([a-z]+)$/.exec(text);
  const unit = rel ? DAY_UNITS[rel[2] ?? ""] : undefined;
  if (rel && unit) {
    const n = Number(rel[1]);
    if (n > MAX_AMOUNT) return { invalid: `${n} ${unit} is too far ahead` };
    return day(unit === "months" ? addMonths(today, n) : addDays(today, unit === "weeks" ? n * 7 : n));
  }
  return null;
}

function dateTime(at: Date): DatePhrase {
  return { kind: "date-time", date: localDateOf(at), time: localTimeOf(at), at };
}

/**
 * Read a typed phrase:
 * - `today`, `tomorrow`, `yesterday`, `tonight` — the reference day and its neighbours.
 * - `fri`, `friday` — the next such day after the reference day (1–7 days ahead; today is `today`).
 * - `nov 20`, `20 nov`, `november 20th`, `nov 20 2027`, `2026-11-20` — without a year, the first
 *   such date on or after the reference day (`feb 29` → the next leap day).
 * - `+3d`, `+2w`, `+1mo`, `in 3 days`, `in 2 weeks` — counted from the reference day.
 * - `+2h`, `+30min`, `in 2 hours`, `in 30 minutes` — elapsed time from `now`.
 * - A time after a day phrase, optionally with `at`: `tomorrow 9:00`, `fri at 9pm`. `tonight` with
 *   a time before 12:00 is the next morning (`tonight 1:00`).
 * - A time alone (`23:00`, `at 7am`): its next occurrence after `now`.
 * - `2026-11-20T09:30` (what `<input type="datetime-local">` gives): that local date and time,
 *   whatever the reference day.
 * Case and extra spaces are ignored.
 */
export function parseDatePhrase(text: string, options: DatePhraseOptions): DatePhrase {
  const { now } = options;
  const phrase = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (phrase === "") return NOT_A_DATE;
  const today = currentDay(now, options.dayBoundary);

  const local = /^(\d{4}-\d{2}-\d{2})t(\d{2}:\d{2})$/.exec(phrase);
  if (local) {
    const date = local[1] ?? "";
    const time = parseTime(local[2] ?? "");
    if (!isLocalDate(date)) return { kind: "invalid", message: `${date} is not a real date` };
    if (!time) return { kind: "invalid", message: `${local[2] ?? ""} is not a time — use 00:00–23:59` };
    return dateTime(toInstant(date, time));
  }

  const rel = /^(?:\+ ?|in )(\d+) ?([a-z]+)$/.exec(phrase);
  const minutes = rel ? TIME_UNITS[rel[2] ?? ""] : undefined;
  if (rel && minutes !== undefined) {
    const n = Number(rel[1]);
    if (n > MAX_AMOUNT) return { kind: "invalid", message: `${n} ${rel[2] ?? ""} is too far ahead` };
    return dateTime(new Date(now.getTime() + n * minutes * 60_000));
  }

  const whole = parseDay(phrase, today);
  if (whole !== null) return isInvalid(whole) ? { kind: "invalid", message: whole.invalid } : { kind: "date", date: whole.date };

  const timed = /^(?:(.*?) )??(?:at )?(\d{1,2}(?::\d{2})?(?: ?[ap]m)?)$/.exec(phrase);
  if (!timed) return NOT_A_DATE;
  const clock = parseClock((timed[2] ?? "").replace(" ", ""));
  if (clock === null) return NOT_A_DATE;
  const head = timed[1] ?? "";

  if (head === "") {
    if (isInvalid(clock)) return { kind: "invalid", message: clock.invalid };
    const calendarToday = localDateOf(now);
    const at = toInstant(calendarToday, clock);
    return dateTime(at > now ? at : toInstant(addDays(calendarToday, 1), clock));
  }

  const dayPart = parseDay(head, today);
  if (dayPart === null) return NOT_A_DATE;
  if (isInvalid(dayPart)) return { kind: "invalid", message: dayPart.invalid };
  if (isInvalid(clock)) return { kind: "invalid", message: clock.invalid };
  const date = dayPart.tonight && clock.hour < 12 ? addDays(dayPart.date, 1) : dayPart.date;
  return dateTime(toInstant(date, clock));
}
