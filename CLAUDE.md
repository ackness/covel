# CLAUDE.md

Project instructions for Claude Code live in [`AGENTS.md`](./AGENTS.md), shared
with every other coding agent so the rules cannot drift. Edit that file, not this
one. Nested directories follow the same pattern: a directory-level `AGENTS.md`
holds the rules and a sibling `CLAUDE.md` imports it (see `docs/v2/`).

The import below brings in the whole guide. When a change touches one of these,
update the matching section there rather than adding notes here:

- Root scripts and how to verify a change → Commands
- Packages, templates, and scaffolds → Monorepo Structure
- Where documentation lives and what must not stay in `docs/` → Documentation
- Which page to update for which kind of change → Documentation sync
- Pull request contents → Commits & Pull Requests
- Project skills (`/create-plugin`, `/create-world`) → Agent Skills

@AGENTS.md
