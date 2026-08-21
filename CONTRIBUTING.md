# Contributing

Orion Finance Lab is early-stage. Keep changes within the existing ownership boundaries: Finance state and authorization belong in `src/`, the embedded interface belongs in `ui/`, OpenClaw-facing tools belong in `openclaw-plugin/`, and external Python bridges belong in `integrations/`.

## Before opening a pull request

1. Use placeholders and synthetic identifiers in configuration, tests, documentation, and screenshots.
2. Run `npm run verify:public`.
3. Run `npm test`.
4. Run `npm run build`.
5. Update `docs/architecture.md` or `docs/api-and-tools.md` when a boundary, endpoint, permission, or persistence contract changes.

Do not commit `.env` files, credentials, account IDs, SQLite databases, logs, virtual environments, downloaded IBKR SDK files, generated UI output, or local filesystem paths. Report security issues using `SECURITY.md`, not a public issue.
