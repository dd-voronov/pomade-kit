---
name: hello-roadmap
description: How the Hello example app reads a project's roadmap — use when writing tickets the Hello app should list.
---

# Hello roadmap

The Hello app lists every Markdown file in `<project>/docs/roadmap/` and shows three frontmatter
fields: `id`, `status`, `title`. A ticket the app should list therefore starts with:

```yaml
---
id: T-001
status: planned
title: What the ticket is about
---
```
