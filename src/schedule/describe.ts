// A schedule in plain words for UIs: "weekdays at 7:00", "monthly on the 5th, shows 3 days early".

import { formatTime, WEEKDAYS, type LocalDate, type Time, type Weekday } from "./local-time.js";
import type { MonthDay, Schedule } from "./schema.js";

const WEEKDAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEKDAY_LONG: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NTH_WORD = ["first", "second", "third", "fourth", "fifth"];

/** "a", "a and b", "a, b and c". */
function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "Nov 20, 2026". */
export function describeDate(date: LocalDate): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTH_SHORT[(m ?? 1) - 1] ?? ""} ${d ?? ""}, ${y ?? ""}`;
}

function atWords(at: Time[]): string {
  return at.length === 0 ? "" : ` at ${joinWords(at.map(formatTime))}`;
}

function dayWords(days: Weekday[]): string {
  const set = days.join(",");
  if (set === WEEKDAYS.join(",")) return "daily";
  if (set === "mon,tue,wed,thu,fri") return "weekdays";
  if (set === "sat,sun") return "weekends";
  return `every ${joinWords(days.map((d) => WEEKDAY_SHORT[d]))}`;
}

function monthDayWords(days: MonthDay[]): string {
  let theUsed = false;
  const words = days.map((d) => {
    if (typeof d === "number") {
      const w = theUsed ? ordinal(d) : `the ${ordinal(d)}`;
      theUsed = true;
      return w;
    }
    if (d === "last") return "the last day";
    return `the ${d.nth === "last" ? "last" : NTH_WORD[d.nth - 1]} ${WEEKDAY_LONG[d.weekday]}`;
  });
  return joinWords(words);
}

function ruleWords(s: Schedule): string {
  const { rule, only } = s;
  switch (rule.kind) {
    case "once":
      return `once on ${describeDate(rule.date)}${rule.at ? ` at ${formatTime(rule.at)}` : ""}`;
    case "every": {
      const base =
        rule.count === 1 ? `every ${rule.unit === "hours" ? "hour" : "minute"}` : `every ${rule.count} ${rule.unit === "hours" ? "hours" : "min"}`;
      const filter = only ? ` on ${only}` : "";
      let window = "";
      if (rule.from && rule.to) window = `, ${formatTime(rule.from)}–${formatTime(rule.to)}`;
      else if (rule.from) window = `, from ${formatTime(rule.from)}`;
      else if (rule.to) window = `, until ${formatTime(rule.to)}`;
      return `${base}${filter}${window}`;
    }
    case "daily":
      if (rule.every > 1) return `every ${rule.every} days${only ? ` on ${only}` : ""}${atWords(rule.at)}`;
      if (rule.at.length === 0) return only === "weekdays" ? "every weekday" : only === "weekends" ? "every weekend day" : "every day";
      return `${only ?? "daily"}${atWords(rule.at)}`;
    case "weekly":
      if (rule.every > 1) {
        const days = joinWords(rule.days.map((d) => WEEKDAY_SHORT[d]));
        if (rule.every === 2 && rule.days.length === 1) return `every other ${days}${atWords(rule.at)}`;
        const weeks = rule.every === 2 ? "every other week" : `every ${rule.every} weeks`;
        return `${weeks} on ${days}${atWords(rule.at)}`;
      }
      return `${dayWords(rule.days)}${atWords(rule.at)}`;
    case "monthly": {
      const days = monthDayWords(rule.days);
      const months = rule.months ? ` of ${joinWords(rule.months.map((m) => MONTH_SHORT[m - 1] ?? ""))}` : "";
      return `${rule.months ? "on" : "monthly on"} ${days}${months}${atWords(rule.at)}`;
    }
    case "after-completion":
      return `${plural(rule.count, rule.unit.slice(0, -1))} after completion`;
    case "always":
      return "always on";
  }
}

/** The schedule in plain words, e.g. "weekdays at 7:00" or "every 30 min on weekdays, 9:00–19:00". */
export function describeSchedule(schedule: Schedule): string {
  const parts = [ruleWords(schedule)];
  if (schedule.start && schedule.end) parts.push(`from ${describeDate(schedule.start)} until ${describeDate(schedule.end)}`);
  else if (schedule.start) parts.push(`from ${describeDate(schedule.start)}`);
  else if (schedule.end) parts.push(`until ${describeDate(schedule.end)}`);
  if (schedule.leadDays > 0) parts.push(`shows ${plural(schedule.leadDays, "day")} early`);
  return parts.join(", ");
}
