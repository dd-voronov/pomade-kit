---
id: E-029
kind: epic
title: "Side panels — left icon strip, panel slot, app contributions"
status: planned
type: feature
priority: P1
module: core
problem: P-029
seams: [side-panels]
created: 2026-11-09
updated: 2026-11-09
source: session-2026-11-09
---

# E-029 — Side panels — left icon strip, panel slot, app contributions

## Goal

One vertical icon strip at the left edge of the file-tree column, always visible, holding Files,
Git and app icons; each icon fills the side panel, opens a tab, or both; icons carry badges.

## Scope

- [ ] The strip (expanded and collapsed column), built for many icons; Files moves into it.
- [ ] Icon actions: fill the panel · open (or focus) a tab · both at once.
- [ ] Badges on icons (count, red when urgent) — the visual side of [[E-032]].
- [ ] App contributions from the manifest: several icons per app, each with its action; an
      app's panel is its UI in a side-panel frame.
- [ ] Selected icon remembered per project.

## Users

Files and the Git panel (git slice 2), Board ("Needs you" panel + board tab), Planner
(panel + "Open in full tab"), Runner (panel), Agents ("Live now" panel → two tabs).

## Acceptance

- Files and a test app's two icons live in the strip; one fills the panel, one opens a tab, one
  does both; a badge shows and clears.
- The tab strip stays unchanged when only panels are used.

## Notes

Whichever ships first — git slice 2 or this epic — builds the strip; the design is in the G1
outcome ([[2026-11-08-g1-git-and-document-versions]] §3 "Shape").
