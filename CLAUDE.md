# CLAUDE.md

AI service of the personal finance app: finance chat agent (`/ask`), receipt scanner, spending insights, generated UIs. Fastify + LangGraph, models via OpenRouter, transaction data via the mcp-api MCP server, Postgres via Drizzle, traces in Langfuse. Also hosts the shared agent workflows in `.github/workflows/`. Solo project.

## Commands
- `deno task verify` - lint and tests. Use this to verify.
- `deno install` - install dependencies (`npm ci` fails on peer-dependency resolution; the Docker image uses Deno).
- `npm test` - unit tests (node:test + tsx); `node --import=tsx --test tests/foo.test.ts` for one file.
- `deno task lint` / `deno task check` (typecheck, not part of verify yet, see baseline)
- `npm run dev` (Node) or `deno task dev` (Deno, what production runs); both read `stack.env`.
- `npm run db:generate` after changing `db/drizzle/schema.ts`; migrations apply at boot.

## Architecture
- `main.ts` builds services, decorates them on Fastify (`fastify.db`, `openRouterClient`, `mcpClient`, `chatsService`, ...; typed in `types/fastify.d.ts`) and registers routes from `api/rest/`.
- `api/rest/*` HTTP routes -> `graph/*` LangGraph agents and nodes -> `services/*` (OpenRouter, MCP client, DB-backed services).
- `config/config.ts` reads env vars (models, token limits, timezone); `config/langfuse.ts` sets up tracing on import.
- Schema in `db/drizzle/schema.ts`; generated SQL in `db/drizzle/migrations/`.

## Conventions
- Imports use explicit `.ts` extensions (both runtimes need them); `@api/` maps to `./api/`.
- Code must run on both Deno (production) and Node + tsx (dev, tests): use `node:` builtins and `process.env`, no `Deno.*` APIs.
- Tests in `tests/*.test.ts` with `node:test` and hand-written mocks of `McpClientService`/OpenRouter; no network in tests.
- Quote style and indentation are not standardized; match the file you are editing and do not reformat others.

## Things Claude gets wrong
- Hand-writing or editing files in `db/drizzle/migrations/`; generate them from the schema.
- Calling real models or the MCP server in tests; mock the service instead.
- Hardcoding model slugs or token limits instead of `config/config.ts` (env-overridable).
- Logging prompts or user financial data outside Langfuse traces.
- Editing `.github/workflows/agent*.yml` casually: bff, financer, mcp-api and transactions call them from `@main`, so a change affects every repo.

## Verifying your work
Before saying a task is done, run `deno task verify` and paste the relevant output (lint summary and the `# pass`/`# fail` lines, plus any failure). If something fails, say so; do not call the task done.
Known baseline failures (not caused by your change, fix only if the task is about them): 3 `no-unused-vars` lint errors (`api/rest/health.ts` x2, `services/mcp_client.ts` `parseError`). `deno task check` reports about 60 type errors (mostly the Fastify decorators in `types/fastify.d.ts` not being picked up); do not add new ones in files you touch.

## Process
Non-trivial changes follow `docs/sdlc/README.md`: `/sdlc-intent` -> `/sdlc-spec` -> `/sdlc-plan` -> implement -> `/sdlc-review` -> commit. Review rules: `REVIEW.md`.
