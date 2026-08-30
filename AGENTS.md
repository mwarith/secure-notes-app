## Project requirements

The full product requirements are documented in `docs/PRD.md`. Read this before starting work on any ticket if you're unsure how a feature should behave, and cite the relevant PRD section when a design decision depends on it.

## Audit event naming

Audit event names use dot-style `<entity>.<event>` strings: `account.created`, `login.success`, `login.failed`, `logout.success`. Apply this convention to all new audit events; write them via `src/lib/audit.ts` and keep secrets, tokens, and passwords out of metadata.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
