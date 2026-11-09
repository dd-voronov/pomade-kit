// pomade-kit/schedule — the recurrence format agents write in frontmatter, its validation, the
// occurrence engine (local time on the Mac's clock, DST-correct) and plain-language descriptions.
// Pure: time is always a parameter; runs in Node and in the browser.

export {
  formatSchedule,
  formatScheduleError,
  parseSchedule,
  SHAPE_KEYS,
  type MonthDay,
  type Nth,
  type Resolution,
  type Rule,
  type RuleKind,
  type Schedule,
  type ScheduleError,
  type ScheduleParseResult,
} from "./schema.js";
export { datesBetween, leadStart, nextDate, nextOccurrence, occurrencesBetween, occursOn, previousOccurrence } from "./engine.js";
export { describeDate, describeSchedule } from "./describe.js";
export {
  addDays,
  addMonths,
  daysBetween,
  formatTime,
  isLocalDate,
  localDateOf,
  localTimeOf,
  parseTime,
  toInstant,
  weekdayOf,
  WEEKDAYS,
  type LocalDate,
  type Time,
  type Weekday,
} from "./local-time.js";
