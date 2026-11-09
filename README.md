# pomade-kit

Shared library for the Pomade family: the app SDK (Host API client, types, fake host) and shared
pure logic.

Part of the Pomade family — the platform and its rules live in the sibling repo `Pomade`
(`docs/PLATFORM.md`); the protocol is `Pomade/docs/HOST-API.md`. Backlog: `docs/BACKLOG.md`.

## Install

```sh
npm install github:dd-voronov/pomade-kit#v0.1.0
```

The package installs from a git tag: npm clones it, installs its dev dependencies and builds
`dist/` through the `prepare` script. ESM only, with TypeScript declarations.

| Import | What | Runs in |
|---|---|---|
| `pomade-kit/protocol` | Host API v0 in code: messages, `ProjectRef`, `FileEntry`, `FileChange`, error codes, `Manifest` + `parseManifest`, `HOST_API_VERSION`, message guards, workspace path rules, `readFrontmatter` | browser and Node |
| `pomade-kit/sdk` | `connect()` and the typed client | browser (any `Transport` elsewhere) |
| `pomade-kit/fake-host` | the Host API in memory, for standalone runs and tests | browser and Node |
| `pomade-kit/frontmatter` | field-only frontmatter writes: `setField`, `removeField`, and the block core Pomade's editor uses | browser and Node |
| `pomade-kit/schedule` | the schedule format: `parseSchedule` with readable errors, the occurrence engine, `describeSchedule`, `formatSchedule` | browser and Node |
| `pomade-kit/dates` | date phrases: `parseDatePhrase` (`fri`, `tomorrow`, `+3d`, `nov 20`, `tonight 23:00`, `in 2 hours`) and `currentDay` with a day boundary | browser and Node |
| `pomade-kit/node` | `resolveWorkspace()` for commands | Node |

## Connect to Pomade

```ts
import { connect, HostError } from "pomade-kit/sdk";

const result = await connect();                 // never throws
if (result.status === "no-host") showNoHost();  // opened outside Pomade (no answer in 1500 ms)
else if (result.status === "rejected") {
  // "needs-newer-pomade": this Pomade is too old; "app-too-old": the app needs an update
  showRejected(result.reason);
} else {
  const host = result.host;
  host.welcome.project;                         // the project the frame was opened in
  await host.info();                            // { pomadeVersion, hostApi, appId, surface }
  await host.project.getActive();               // ProjectRef; the Workspace scope when none
  const off = host.project.onChange((project) => { /* switch */ });

  const { entries } = await host.files.readFolder({ path: "Projects/x/docs/roadmap", recursive: true, frontmatter: true });
  const watch = await host.files.watch({ path: "Projects/x/docs/roadmap", recursive: true }, (changes) => {
    /* FileChange[] — one batch */
  });
  await watch.close();

  try {
    await host.files.readFolder({ path: "../outside" });
  } catch (err) {
    if (err instanceof HostError) err.code;     // "outside-workspace"
  }
}
```

- Paths are workspace-relative; join a project's root with your own path:
  `joinPath(project.root, "docs/roadmap")` from `pomade-kit/protocol`.
- After `welcome` the client forwards every unhandled (`defaultPrevented === false`) Cmd/Ctrl
  keydown to Pomade (a modifier key pressed alone is not forwarded), so Pomade's shortcuts keep
  working while the app has focus. The decision
  waits one task, so any keydown handler of the app can still claim a key with
  `preventDefault()`. `connect({ keySource: null })` turns it off.
- `host.close()` detaches the client: no more events, pending calls reject.

## Develop and test without Pomade — the fake host

```ts
import { createFakeHost } from "pomade-kit/fake-host";
import { connect } from "pomade-kit/sdk";
import manifest from "./public/manifest.json" with { type: "json" };

const fake = createFakeHost({
  manifest,                                     // sets the app id and the granted capabilities
  projects: [{ id: "alpha", name: "Alpha", root: "Projects/alpha" }],
  activeProject: "alpha",                       // omit for the Workspace scope
  files: { "Projects/alpha/docs/roadmap/E-001-x.md": "---\nid: E-001\nstatus: planned\n---\n" },
});

const result = await connect({ transport: fake.transport });   // in-process
```

It implements all of HOST-API v0 with the same messages: frontmatter exactly as Pomade reads it
(js-yaml `JSON_SCHEMA` with non-finite numbers kept as their source text, Pomade's editor block
detection), the Workspace scope as `WORKSPACE_PROJECT_ID` (`"__workspace__"`), Pomade's default tree ignore list
(`.git`, `node_modules`, `.DS_Store`; `ignore` option), the manifest's capabilities, every error
code, and the events. Test controls emit the events Pomade would:

| Control | Emits |
|---|---|
| `fake.writeFile(path, content)` | `create` (and one per new parent folder) or `change` |
| `fake.deleteFile(path)` | `delete` |
| `fake.rename(from, to)` | `rename` (file or folder) |
| `fake.batch(() => …)` | the changes inside as one `files.changed` per watch |
| `fake.setActiveProject(id \| null)` | `project.changed` |

`fake.keys` lists the forwarded keys; `fake.createTransport()` gives another frame;
`createFakeHost({ hostApi: 1 })` makes the handshake reject.

**Browser e2e (Playwright):** a harness page creates the fake host, puts it on `window` for the
specs, and hosts the app's page in an iframe with `mountApp(fake, { src: appUrl })` — the app
runs unchanged, as inside Pomade. Working setup: `e2e/harness/` and `e2e/hello.spec.ts`, run by
`playwright.config.ts` (the built app served on one origin, the harness on another).

**`dev:fake`:** serve such a harness page with a fixture workspace from the app's own Vite dev
server, with `?app=` pointing at the app's page — a standalone app with live, scriptable data.

## Write one frontmatter field

```ts
import { setField, removeField } from "pomade-kit/frontmatter";

const r = setField(fileText, "status", "done");   // FieldValue: string | number | boolean | null | string[]
if (r.ok) save(r.text);                           // r.changed: false when the bytes are identical
else showError(r.reason);                         // "unreadable-frontmatter" | "unsupported-key" | "invalid-value"
removeField(fileText, "parked");
```

Only the field's own lines change; every other byte — other keys, their quoting, comments,
blank lines, key order, the body and its line endings — stays identical. A missing key is
appended at the end of the block (a file without frontmatter gets a new block on top). A string
is written plain when it reads back as the same string, otherwise double-quoted (`"true"`,
`"3"`); dates stay plain (`2026-11-09`). A block that is not a valid YAML mapping, or a first
`---` line that never closes, is refused — never rewritten.

Exceptions on the edited key itself (Pomade's editor has the same ones): a quoted value is
re-emitted plain when safe; a list edit rewrites all of the list's item lines (comments between
items are lost); an emptied block list becomes `key: []`; removing the last key drops the whole
block, its standalone comments and the blank lines after it. A block with mixed line endings is
written back with the block's CRLF.

The block core (`parseFrontmatter`, `setScalarValue`, `setBooleanValue`, `setListValue`,
`addProperty`, `removeProperty`, `moveKey`, `getKeyLines`, `setComplexKeyLines`, `validateYaml`,
`emitScalar`, `splitFrontmatter`) is Pomade's properties-panel logic with identical behavior and
signatures; it works on the LF-normalized block that `splitFrontmatter` returns.

## Schedules

One recurrence format for every piece of the family: Runner jobs write it under `schedule:`,
Planner recurring items under `repeat:`. It is a YAML mapping with **one shape key** and optional
**modifiers**. No cron syntax. Times are `H:MM`, 24-hour, on the Mac's local clock; dates are
`YYYY-MM-DD`.

```yaml
schedule:
  once: 2026-11-20 23:00                         # one run; a Planner item writes the date only
```
```yaml
schedule:
  every: { minutes: 30, from: 9:00, to: 19:00 }  # or { hours: 2 }; from/to optional
  only: weekdays                                 # weekdays (Mon–Fri) | weekends (Sat–Sun)
```
```yaml
schedule:
  daily: { at: [13:00, 20:00] }                  # one time or a list
```
```yaml
schedule:
  weekly: { days: [mon, tue, wed, thu, fri], at: 7:00 }
```
```yaml
schedule:
  monthly: { days: [1, 15, last, first mon], at: 9:00 }   # numbers 1–31, last, "<nth> <weekday>"
```
```yaml
schedule:
  monthly: { days: [5], months: [jan, apr, jul, oct], at: 9:00 }   # quarterly; one month = yearly
```
```yaml
schedule:
  always: true                                   # services
```
```yaml
repeat:                                          # a Planner recurring item: whole days, no `at`
  monthly: { days: [5] }
  start: 2026-01-01                              # first date with occurrences (inclusive)
  end: 2026-12-31                                # last date with occurrences (inclusive)
  lead-days: 3                                   # shows up 3 days early
```
```yaml
repeat:
  after-completion: { months: 3 }                # or { days: N } / { weeks: N }
```

| Key | Values |
|---|---|
| `once` | `YYYY-MM-DD H:MM`, or `YYYY-MM-DD` in a day schedule |
| `every` | `minutes: 1–1440` or `hours: 1–24`; `from`, `to` (a window inside one day, both ends inclusive) |
| `daily` | `at`: a time or a list |
| `weekly` | `days`: `mon` … `sun` (full names too); `at` |
| `monthly` | `days`: `1`–`31`, `last`, `first`/`second`/`third`/`fourth`/`fifth`/`last` + weekday; `months`: `jan` … `dec` or `1`–`12`; `at` |
| `after-completion` | exactly one of `days`, `weeks`, `months` |
| `always` | `true` |
| `only` | `weekdays` · `weekends` — with `every` and `daily` |
| `start`, `end` | dates, inclusive — not with `once`, `always` |
| `lead-days` | whole days ≥ 0 — not with `always` |

Full day names, `1st`…`5th` and capitalised names are accepted; `formatSchedule` writes the
canonical form above.

**Meaning, where it could be read two ways:**
- **Day 29–31 in a shorter month** happens on that month's last day (`days: [31]` = Jan 31, Feb
  28 or 29, Mar 31, Apr 30 …). Two days that land on the same date are one occurrence. A **fifth
  weekday** happens only in months that have one.
- **`every`** is a grid of wall-clock times that restarts each day at `from` (default 0:00) and
  stops at `to` (default 23:59): `every: { hours: 5 }` = 0:00, 5:00, 10:00, 15:00, 20:00.
- **A time skipped by spring-forward** happens as many minutes later as the change skipped: a
  02:30 daily run on Madrid's 02:00 → 03:00 day runs at 03:30, once. Interval times that land on
  the same instant merge.
- **A time repeated by fall-back** happens once, on its first pass: a 01:30 run on New York's
  02:00 → 01:00 day runs at 01:30 EDT and not again at 01:30 EST. An interval leaves the repeated
  hour empty.
- **`after-completion`** has no fixed dates: the next date is the completion date plus the period
  (months keep the day, clamped like above), never before `start`.
- **A day schedule** (no `at`) in the time functions happens at local 0:00.

**Resolution.** `parseSchedule(value, { resolution })` checks what the consumer accepts:
`"day"` (Planner: no `every`, `always` or `at`), `"time"` (Runner: `at` required, `once` needs a
time, no `after-completion` or `lead-days`), or omitted (anything).

```ts
import {
  parseSchedule, formatScheduleError, formatSchedule, describeSchedule,
  nextOccurrence, previousOccurrence, occurrencesBetween, nextDate, datesBetween, leadStart,
} from "pomade-kit/schedule";

const r = parseSchedule(frontmatter.schedule, { resolution: "time" });
if (!r.ok) return r.errors.map((e) => formatScheduleError("schedule", e));
// → 'schedule.weekly.days[1]: "fry" is not a weekday — use mon, tue, wed, thu, fri, sat or sun'
const s = r.schedule;

describeSchedule(s);                          // "every 30 min on weekdays, 9:00–19:00"

// Runner — instants; time is always a parameter, never read inside.
nextOccurrence(s, now);                       // first occurrence > now, or null
occurrencesBetween(s, lastAlive, now);        // missed runs in (lastAlive, now], earliest first, ≤ 1000
previousOccurrence(s, now);                   // the latest occurrence < now

// Planner — whole days, as YYYY-MM-DD, relative to the planner day.
nextDate(s, today, { inclusive: true });      // first date ≥ today (strictly after without inclusive)
nextDate(afterCompletion, doneOn);            // doneOn + the period
datesBetween(s, doOn, today);                 // dates in (doOn, today] — "missed N×" = 1 + length
leadStart(s, doOn);                           // doOn − lead-days: in Today from this date

setComplexKeyLines(block, "repeat", formatSchedule("repeat", s));   // write it back
```

`after-completion` and `always` have no fixed times: the time functions return null / `[]`, and
`datesBetween` returns `[]`. Date helpers used by the engine are exported too (`addDays`,
`addMonths`, `daysBetween`, `localDateOf`, `toInstant`, …).

**Why JS `Date` local time and no time-zone library:** schedules follow the Mac's clock, and the
`Date` local-time APIs are exactly that clock — in Node and in the browser, with no zone database
to ship or keep current. ECMAScript defines how they resolve skipped and repeated wall times (the
rules above), so the DST behavior is specified, not engine-dependent. Calendar arithmetic runs on
UTC day numbers, so it never meets a DST shift. Tests pin a zone through `process.env.TZ`
(`src/schedule/test-helpers.ts`), which Node applies on assignment; the matrix covers
Europe/Madrid and America/New_York across both changes.

## Date phrases

Short typed phrases become dates the same way everywhere — the Planner's quick add, Pomade's
editor, Runner's "Run at…".

```ts
import { parseDatePhrase, currentDay } from "pomade-kit/dates";

const r = parseDatePhrase(input, { now: new Date(), dayBoundary: { hour: 3, minute: 0 } });
switch (r.kind) {
  case "date":       r.date; break;                  // "2026-11-13" — a whole day
  case "date-time":  r.at; r.date; r.time; break;    // a moment: the instant, its local date and time
  case "invalid":    r.message; break;               // "Nov has no day 31" — looks like a date, isn't one
  case "not-a-date": break;                          // treat the text as text
}
currentDay(now, { hour: 3, minute: 0 });             // the Planner day: at 01:30 still yesterday
```

| Phrase | Result (now = Mon 2026-11-09 14:00) |
|---|---|
| `today` · `tomorrow` · `yesterday` · `tonight` | 2026-11-09 · 2026-11-10 · 2026-11-08 · 2026-11-09 |
| `fri`, `friday` (any weekday name) | 2026-11-13 — the next one after today, 1–7 days ahead (`mon` → 2026-11-16) |
| `nov 20`, `20 nov`, `november 20th` | 2026-11-20 — the first on or after today (`nov 8` → 2027-11-08, `feb 29` → 2028-02-29) |
| `nov 20 2027`, `nov 20, 2027`, `2026-11-20` | that date |
| `+3d` or `in 3 days` · `+2w` or `in 2 weeks` · `+1mo` | 2026-11-12 · 2026-11-23 · 2026-12-09 (months clamp to short months) |
| `+2h` · `+30min` · `in 2 hours` · `in 90 minutes` | `now` plus that much elapsed time |
| `tonight 23:00` · `tonight 1:00` | 2026-11-09 23:00 · 2026-11-10 1:00 (before 12:00 = the next morning) |
| `tomorrow 9:00`, `fri at 9pm`, `nov 20 9:30` | that day at that time |
| `23:00`, `at 7am` (a time alone) | its next occurrence after `now` |

- **Day boundary.** Day phrases count from the reference day: the calendar date, or with
  `dayBoundary` the Planner's day — at 01:30 with a 03:00 boundary, `today` is still yesterday's
  date and `tomorrow` is today's. Elapsed-time phrases (`+2h`) and a time alone ignore it.
- **Times** are `H:MM` 24-hour or `9pm` / `9:30am`; they follow the schedule module's DST rules (a
  skipped time moves forward by the gap, a repeated one is its first pass). `date` and `time` in
  the result are where `at` actually falls.
- **Invalid** means the text reads as a date but names none: `nov 31`, `feb 29 2027`,
  `2026-02-30`, `tomorrow 25:00`, `13pm`, `+99999d`.
- Case and extra spaces are ignored. Anything else — `buy milk`, `next fri`, `fri 20` — is
  `not-a-date`.

## Commands run with Pomade closed

```ts
import { resolveWorkspace } from "pomade-kit/node";
const root = resolveWorkspace();   // absolute POMADE_WORKSPACE, or null
```

Reading the workspace pointer Pomade records joins with `pomade:E-028`.

## Example

`examples/hello/` — the smallest app: lists the active project's `docs/roadmap/` frontmatter rows
and follows project and file events. `npm run hello:build` writes the installable folder
`examples/hello/dist/` (`index.html`, `manifest.json`, assets).

## Develop this repo

```sh
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

`npm test` runs the unit matrix (vitest) and the e2e (Playwright, Chromium).

## Release

1. On `main`, with the gate green, bump `version` in `package.json` and commit.
2. Tag with the changelog in the tag message and push the tag:
   ```sh
   git tag -a v0.2.0 -m "v0.2.0

   - what changed, one line per change
   - BREAKING: … (a breaking change is a major version)"
   git push origin v0.2.0
   ```
3. Consumers bump their pin: `npm install github:dd-voronov/pomade-kit#v0.2.0`. A breaking change
   is announced in each consumer's backlog.
