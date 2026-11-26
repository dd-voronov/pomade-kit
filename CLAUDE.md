# pomade-kit — instructions for agents

`pomade-kit` is the shared library of the Pomade family — the app SDK, shared pure logic and the
keeper; the platform is the sibling repo `../Pomade`. Personal working rules come from the workspace
`CLAUDE.md`, loaded automatically.

**Every session, before anything else, read:**

1. `../Pomade/private/WORKING-AGREEMENT.md` — how the Pomade family works, and which doc to read for
   which task. Read nothing else up front; it tells you what the task at hand needs.
2. `private/SESSION-HANDOFF.md` — work left hanging by this repo's last session (often empty).
3. `private/REPO.md` — this repo: its docs, what belongs here, releases, commands and local rules.

**A worker** — a sub-agent briefed by an orchestrating session — skips all three: read only what your
brief names.
