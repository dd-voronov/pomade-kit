---
doc: docs/modules/index.md
audience: engineers, product
holds: the module map — each module's scope and where it lives in code
kind: reference
---

# Modules

A module is a real area of the kit with a home in the code. Tickets name one in `module:`; process
and repo items use `meta`. A new area gets its row here first. How to use each module is in the
[README](../../README.md), module by module.

| Module | Covers | Where in code |
|---|---|---|
| `protocol` | the wire types and checks Pomade, the SDK and app backends share: Host API messages, events, manifests, git runs, agent sessions and tabs, notices, the broker | `src/protocol/` (the attach protocol, `attach.ts`, belongs to `keeper`) |
| `sdk` | the Host API client for app frames and backends, design tokens and theme, the fake host (browser and Node), launching Pomade from a test | `src/sdk/`, `src/tokens/`, `src/fake-host/`, `src/node/`; `examples/hello/`, `e2e/` |
| `frontmatter` | field-only frontmatter writes | `src/frontmatter/` |
| `schedule` | the recurrence format and the next-occurrence engine | `src/schedule/` |
| `dates` | date phrases | `src/dates/` |
| `scanners` | agent output scanners | `src/scanners/` |
| `keeper` | the keeper and the attach protocol | `src/keeper/`, `src/protocol/attach.ts`, `src/node/keeper.ts` |
| `meta` | process and repo items | the configs at the root |
