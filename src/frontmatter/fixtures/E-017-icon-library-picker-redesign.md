---
id: E-017
kind: epic
title: "Icon picker v2: predefined icon library (use-case + brand icons) + three-mode window redesign"
status: review
type: feature
priority: P2
module: projects
created: 2026-07-24
source: user-testing-2026-07-24
---

## Goal
Round-4 request for the Project / Group / Workspace icon window:

1. **Predefined icon library** — a third icon source next to emoji and image upload:
   - Use-case icons: Music, Film-making, Software engineering, Money management, Games, Knowledge management, Writing, Translation, Gym/Health, Personal life management.
   - Brand icons (v1 list from Daniil): YouTube, Instagram, LinkedIn, Slack, Telegram, Spotify, Obsidian, Notion, Apple, Android, Google Translate, Microsoft, MS Office, Amazon, X (ex-Twitter), Pinterest, Minecraft, Airbnb, McDonald's.
2. **Window redesign:** first pick one of three modes — Icons | Emoji | Image — then the mode's own UI below (reusing the existing emoji grid and image picker pieces).

## Notes
- **Sourcing (APPROVED by Daniil 2026-07-24: "go ahead and use simple-icons for start, icons that are missing — hand-made glyphs are fine for v1"):** brands → `simple-icons` npm package (MIT, official SVG set) — caveat: a few brands (some Microsoft properties, possibly others) have been removed from it under brand-policy pressure; anything missing gets a hand-made minimal glyph or is dropped from v1 with a note. Use-case icons → same monochrome SVG style (hand-made or a small icon set), token-tinted like the rest of the app.
- Icons render monochrome/tinted (consistent with UI taste) unless the brand mark demands its color — decide during delivery, default monochrome.

## Acceptance
Three-mode window; library searchable; chosen icon renders crisply at all tiers (48/40/32/16) incl. the collapsed rail; persists across restart; e2e.
