---
# Ticket written by hand and by agents — keep the comments.
id: T-210
kind: task
title: "Board: drag a card to Done — keeps `status` quoting"
status: 'in-progress'   # moved by the Board
priority: P2
tags: [board, frontmatter, "rule-8"]
seams:
  - workspace-data
  - frontmatter-write   # the kit's block
parent: "[[E-030]]"
estimate: 3
blocked: false
created: 2026-11-10
---

# T-210 — Board: drag a card to Done

Links to [[E-030-workspace-data-api|E-030]] and [[PLATFORM#Rules]] stay as written.

- [ ] **Bold** and _italic_ and `code` and ~~strike~~ survive.
- [x] A table:

| col | value |
|-----|-------|
| a   | `x: y` |

```yaml
status: not-frontmatter
---
```

Trailing line without a newline at the end.
