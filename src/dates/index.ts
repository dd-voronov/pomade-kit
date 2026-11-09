// pomade-kit/dates — short typed phrases to dates (`fri`, `tomorrow`, `+3d`, `nov 20`,
// `tonight 23:00`, `in 2 hours`), with the Planner's day boundary. Pure: `now` is a parameter;
// runs in Node and in the browser.

export { currentDay, parseDatePhrase, type DatePhrase, type DatePhraseOptions } from "./phrases.js";
export type { LocalDate, Time } from "../schedule/local-time.js";
