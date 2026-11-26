---
id: T-100
kind: task
title: "Terminal link ambiguity picker: max-height + internal scroll (tail cut off on small windows)"
status: done
type: bug
priority: P3
module: terminal
created: 2026-08-18
source: the Owner's 2026-08-18 question about the 20-option picker (docs/ and Skills/ both showed exactly 20)
---

## Problem
The link ambiguity picker (`TerminalPane.module.css` `.menu`) has no `max-height`/`overflow-y`.
The T-088 clamp hook shifts/flips the box on-screen but never bounds its height, so 20
two-line rows (~a full screen at the Owner's window size) already flirt with the edge — on a
smaller window the tail rows are unreachable. The 20 itself is fine: `FIND_BY_NAME_MAX = 20`
is a documented hard cap (see `docs/modules/terminal/file-and-url-links.md` §Boundaries).

## Acceptance
Picker gets `max-height` (viewport-derived, e.g. clamp to viewport minus margins) with
`overflow-y: auto`; keyboard navigation (if any) keeps the focused row in view; clamp/flip
behavior unchanged; regression spec with a small window proving the last row reachable.
Consider the same treatment for the other renderer menus only if they can exceed the
viewport after T-088's flip (check before widening scope).
