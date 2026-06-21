# AGENTS.md

## Role

Act like a high-performance senior engineer. Be concise, direct, decisive, and execution-focused. Prefer simple, maintainable, production-ready solutions. Do not over-engineer: avoid heavy abstractions, extra layers, or large dependencies for small changes.

This file applies to the entire repository.

## Operating Rules

- Prefix shell commands with `rtk` when available: `rtk npm test`, `rtk npm run typecheck`, `rtk rg "text" src`.
- `/Users/daviddelatorre/.codex/RTK.md` exists in this environment and requires `rtk`. `/Users/david/.codex/RTK.md` may not exist.
- Before editing, check `rtk git status --short`. There may be local changes from someone else; do not revert or reformat them.
- Use `rg`/`rtk rg` for search. Avoid slow manual exploration.
- Do not add dependencies unless the benefit is clear and proportional.
- Keep strict TypeScript, ESM, and relative imports with `.js` extensions, matching the current project.
- Do not put secrets, tokens, real sensitive phone numbers, or unnecessary personal data in code, tests, logs, or docs.

## Product

Pepita is a WhatsApp-first personal assistant for a small controlled pilot. It receives natural-language WhatsApp messages, identifies each user by phone number, keeps state isolated per user, stores memory, creates tasks/reminders, prepares risky actions as approvals, and exposes local HTTP admin endpoints.

The product thesis is mental-load reduction, not a generic agent framework.

## Stack

- Node.js `>=25.7.0`, required for `node:sqlite`.
- TypeScript `strict`, `moduleResolution: NodeNext`, ESM.
- Fastify for HTTP.
- Native SQLite through `node:sqlite`.
- Vitest for tests.
- Official WhatsApp Cloud API; no WhatsApp Web scraping.
- Deterministic local agent runtime and optional Pi/Codex runtime through `@earendil-works/pi-*`.

## Code Map

- `src/config.ts`: environment parsing and production validations.
- `src/domain.ts`: domain types, IDs, and clock helpers.
- `src/db.ts`: SQLite opening and directory creation.
- `src/repository.ts`: migration, queries, transactions, JSON serialization, user isolation.
- `src/whatsapp.ts`: webhook verification, inbound message parsing, and dry-run/cloud senders.
- `src/agent.ts`: `AgentRuntime` contract, local runtime, Pi runtime, and tools exposed to Pi.
- `src/services.ts`: conversation, approvals, outbox, user-data export and deletion.
- `src/scheduler.ts`: due reminder scanner.
- `src/app.ts`: Fastify app, webhook/admin routes, admin auth, WhatsApp signatures, outbox flush.
- `src/server.ts`: entrypoint, real config, migration, wiring, and clean shutdown.
- `tests/*.test.ts`: behavior contracts. Read the matching test before touching a module.

## Architecture Invariants

- Product state lives in Pepita, not inside the agent runtime.
- `AgentRuntime.handleMessage` returns structured effects (`reply`, `memoryFacts`, `tasks`, `approvals`); it must not mutate external systems directly.
- Each user is resolved by phone number and every persisted entity carries `userId`. Never mix memory, tasks, approvals, outbox, or audit logs across users.
- External or irreversible actions are not executed automatically. They must create an `Approval` of type `email_draft` or `browser_action`.
- The Pi runtime only receives scoped Pepita tools. Do not give it shell access, file editing, unrestricted browser access, or direct credentials.
- Real inbound messages must be claimed with `claimInboundMessage` for idempotency before processing effects.
- A conversation turn must be persisted atomically with `persistConversationTurn`: effects, outbox reply, and audit logs together.
- Reminders are claimed with `claimAndEnqueueReminder` to avoid duplicates and must audit `reminder.enqueued`.
- Respect WhatsApp's 24-hour service window: outside the window use `templateName`; inside the window use a free-form message.
- If `WHATSAPP_APP_SECRET` is configured, validate the HMAC over the raw body before trusting the JSON.
- Sanitize errors before storing or returning them. `sanitizeError` must keep redacting Bearer tokens, OpenAI keys, and WhatsApp tokens.

## Security And Production

- In production, `ADMIN_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_SEND_MODE=cloud`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and a non-default `WHATSAPP_VERIFY_TOKEN` are required.
- If `HOST` is not localhost, require `ADMIN_TOKEN`.
- Local defaults must be safe: SQLite under `.data/`, `local` runtime, WhatsApp `dry-run`.
- Tests and development must not make real calls to WhatsApp, OpenAI/Pi, or other external services.
- Do not implement real email sending, purchases, forms, account changes, or credentialed browsing without an explicit approval and audit flow.
- Keep user-data export and deletion scoped to one user without leaking other users' data.

## Implementation Conventions

- Keep changes small and explicit. Prefer concrete functions and simple types.
- Follow existing patterns: `ParseResult`, private helpers, repository `map*` mappers, and services with minimal interfaces.
- For persisted JSON payloads, use `JsonObject` and `safeJsonStringify`/`safeJsonParse`; do not store non-serializable values.
- If you change the SQLite schema, add repository tests and handle migration carefully. Update `PRAGMA user_version` only intentionally.
- Keep WhatsApp replies short, natural, and in Spanish.
- The local runtime must stay deterministic and useful for tests; do not turn it into a hidden LLM.
- WhatsApp sending code must validate recipients and normalize `+346...` to the Cloud API format without `+`.
- Do not add a UI unless explicitly requested; the current admin surface is HTTP.

## Tests

Base commands:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Targeted tests by area:

- Config, routes, admin auth, signatures, and webhooks: `rtk npm test tests/app.test.ts`
- WhatsApp parser/sender: `rtk npm test tests/whatsapp.test.ts`
- Local/Pi runtime and tools: `rtk npm test tests/agent.test.ts`
- Conversation, approvals, outbox, and export/delete: `rtk npm test tests/services.test.ts`
- SQLite, transactions, JSON, idempotency, and isolation: `rtk npm test tests/repository.test.ts`
- Reminders and service window: `rtk npm test tests/scheduler.test.ts`
- End-to-end MVP flow: `rtk npm test tests/acceptance.test.ts`

For behavior changes, add or adjust a focused test first. Before delivering broad changes, run at least the targeted test, `rtk npm run typecheck`, and, if time allows, `rtk npm test`.

## Local Operation

Setup:

```bash
rtk npm install
rtk cp .env.example .env
rtk npm run dev
```

Health check:

```bash
rtk curl http://127.0.0.1:3000/health
```

Local simulation:

```bash
rtk curl -s http://127.0.0.1:3000/admin/simulate-message \
  -H 'content-type: application/json' \
  -d '{"from":"+34600000001","messageId":"local.demo.1","text":"recuerdame llamar al gestor manana","timestamp":"2030-01-01T09:00:00.000Z","now":"2030-01-01T09:00:00.000Z"}'
```

If `ADMIN_TOKEN` is configured, add `authorization: Bearer <token>` to `/admin/*` endpoints.

## Context Documents

- `README.md`: setup, env vars, operations, and current safety model.
- `docs/superpowers/specs/2026-06-20-pepita-mvp-spec.md`: product context and MVP decisions.
- `docs/superpowers/plans/2026-06-20-pepita-mvp-implementation.md`: historical plan; use it as context, not as the source of truth when it conflicts with current code.

## Current Non-Goals

- Public signup.
- Billing.
- Final end-user UI.
- WhatsApp Web scraping.
- Autonomous email sending.
- Irreversible web actions without approval.
- Broad Gmail/Calendar/Drive integrations.
- Vector memory or production-scale observability.
