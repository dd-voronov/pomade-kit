// pomade-kit/scanners — readers of a terminal's output stream: Pomade's shell markers (a command
// started, a prompt was drawn), attention signals (bell, notification sequences), and the state
// of an agent CLI (working, idle with or without background work, waiting at a permission, trust
// or background-work prompt). Pure; runs in Node and in the browser.

export { AttentionScanner, MarkerScanner, type MarkerEvent } from "./pty-scanners.js";
export {
  AgentStateScanner,
  type AgentKind,
  type AgentPrompt,
  type AgentState,
  type AgentStateScannerOptions,
} from "./agent-state.js";
