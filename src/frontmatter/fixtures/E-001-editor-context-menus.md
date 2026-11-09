---
id: E-001
kind: epic
title: "Editor context menus + in-document find"
status: done
type: feature
priority: P2
module: editor
created: 2026-07-17
updated: 2026-07-23
source: user-testing-2026-07-17
---

## Goal
Right-click inside the editor does nothing today. Deliver full context menus (no-selection and with-selection variants) plus Cmd+F find/replace within the document.

## Tasks
[[T-010]] no-selection menu · [[T-011]] selection menu · [[T-012]] Cmd+F find/replace

## Acceptance
Every menu item works in raw and rendered modes (or is hidden where not applicable); e2e per task. Workspace-wide search is out of scope ([[P-011]]).

User-testing round 2 (2026-07-18) follow-up: [[T-043]] selection menu + Cmd+F dead in raw md and CSV table view.

## Decisions
- **"New agent chat" with a selection (confirmed by Daniil, 2026-07-18, screenshot-3):** current behavior is the desired contract — `Read <path>` is submitted to the agent, and the selected text is placed in the terminal input **unsubmitted**, so Daniil finishes the prompt himself. Documented so nobody "fixes" it into auto-submitting.
- Find & replace panel UX will get a dedicated revisit later (noted in [[P-011]]); current panel accepted for now.

## Round-3 fixes (user test 2026-07-23)

CSV find + rendered-mode menu accepted. One failure:
- [x] **BUG — actually fixed on the third strike (2026-07-24, orchestrator-led).** True root cause: Milkdown's `destroy` listener fires ASYNCHRONOUSLY — on a rendered→raw toggle it landed AFTER RawEditor registered its controller and nulled it, so the pane permanently lost selection/find access (menu always no-selection variant, Cmd+F dead). Explains everything: only .md (only they mount rendered first), only after toggling to raw, CSV fine (sync cleanup), e2e blind (every fixture opened raw DIRECTLY — nobody toggled). The two earlier "fixes" (selection snapshot mechanics) were real improvements but aimed at the wrong layer. Fix: EditorPane ignores null-clears (every editor state mounts a successor that overwrites); regression e2e pins the toggle path and fails on pre-fix code (verified by temporary revert).
