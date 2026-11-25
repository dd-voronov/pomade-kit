// pomade-kit/scanners — readers of a terminal's output stream: Pomade's shell markers (a command
// started, a prompt was drawn), attention signals (bell, notification sequences), and the state
// of an agent CLI (working, idle at its empty prompt with or without background work, waiting at a
// permission, trust, background-work or question prompt, or at a screen no rule names). Pure; runs
// in Node and in the browser.

export { AttentionScanner, MarkerScanner, type MarkerEvent } from "./pty-scanners.js";
export {
  AgentStateScanner,
  type AgentKind,
  type AgentPrompt,
  type AgentState,
  type AgentStateScannerOptions,
  UNKNOWN_ROWS,
} from "./agent-state.js";
