# Pepita MVP

Pepita is a WhatsApp-first personal assistant for a small controlled pilot. It receives natural-language WhatsApp messages, resolves each user by phone number, keeps user state isolated, stores memory, creates tasks and reminders, drafts risky actions for approval, and exposes HTTP admin endpoints for local operation.

## Requirements

- Node >=25.7.0 is required because the app uses built-in `node:sqlite`.
- npm.

## Local Setup

```bash
npm install
cp .env.example .env
```

The defaults in `.env.example` are safe for local development. They use SQLite under `.data/`, the local deterministic runtime, and WhatsApp dry-run mode.

## Env Vars

| Variable | Local default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Binding beyond localhost requires `ADMIN_TOKEN`. |
| `PORT` | `3000` | HTTP server port. |
| `ADMIN_TOKEN` | empty | Optional locally, required for production and non-localhost binds. |
| `PEPITA_DATABASE_PATH` | `.data/pepita.sqlite` | SQLite database path. |
| `PEPITA_AGENT_RUNTIME` | `local` | Use `local` or `pi`. |
| `WHATSAPP_VERIFY_TOKEN` | `change-me` | Webhook verification token. Use a non-default value in production. |
| `WHATSAPP_APP_SECRET` | empty | Validates `X-Hub-Signature-256` webhook signatures. |
| `WHATSAPP_SEND_MODE` | `dry-run` | Use `dry-run` locally or `cloud` for WhatsApp Cloud API sends. |
| `WHATSAPP_ACCESS_TOKEN` | empty | Required when `WHATSAPP_SEND_MODE=cloud`. |
| `WHATSAPP_PHONE_NUMBER_ID` | empty | Required when `WHATSAPP_SEND_MODE=cloud`. |
| `OPENAI_API_KEY` | empty | Optional for API-key providers. Not required for `openai-codex` subscription auth. |
| `PEPITA_PI_PROVIDER` | `openai-codex` | Pi provider used when `PEPITA_AGENT_RUNTIME=pi`. |
| `PEPITA_PI_MODEL` | `gpt-5.4-mini` | Pi model used when `PEPITA_AGENT_RUNTIME=pi`. |
| `PEPITA_PI_AUTH_PATH` | empty | Optional custom Pi auth file path. Leave empty to use `~/.pi/agent/auth.json`. |

Production requires `ADMIN_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_SEND_MODE=cloud`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and a non-default WHATSAPP_VERIFY_TOKEN.

## Pi / Codex Runtime

For real local AI replies through your ChatGPT/Codex subscription, authenticate Pi once:

```bash
./node_modules/.bin/pi-ai login openai-codex
```

Then set:

```env
PEPITA_AGENT_RUNTIME=pi
PEPITA_PI_PROVIDER=openai-codex
PEPITA_PI_MODEL=gpt-5.4-mini
```

Pepita exposes only Pepita-specific tools to Pi: queue memory facts, queue tasks, queue approval requests, and finish the WhatsApp turn. It does not expose shell, file edit, or unrestricted browser tools to the WhatsApp agent.

## Run Tests

```bash
npm test
npm test tests/acceptance.test.ts
npm run typecheck
```

## Run Dev Server

```bash
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

## Local Simulation

Use the admin simulation endpoint to exercise the conversation flow without WhatsApp credentials:

```bash
curl -s http://127.0.0.1:3000/admin/simulate-message \
  -H 'content-type: application/json' \
  -d '{
    "from": "+34600000001",
    "messageId": "local.demo.1",
    "text": "recuerdame llamar al gestor manana",
    "timestamp": "2030-01-01T09:00:00.000Z",
    "now": "2030-01-01T09:00:00.000Z"
  }'
```

Inspect state:

```bash
curl -s http://127.0.0.1:3000/admin/users
```

If `ADMIN_TOKEN` is configured, add:

```bash
-H 'authorization: Bearer YOUR_ADMIN_TOKEN'
```

## WhatsApp Webhook Setup Notes

Configure the WhatsApp Cloud API webhook URL to point at:

```text
GET/POST https://YOUR_HOST/webhooks/whatsapp
```

Use `WHATSAPP_VERIFY_TOKEN` as the webhook verification token. For production, set `WHATSAPP_APP_SECRET` so Pepita rejects unsigned or invalid `X-Hub-Signature-256` payloads.

Local development can use `WHATSAPP_SEND_MODE=dry-run`. Real outbound WhatsApp messages require `WHATSAPP_SEND_MODE=cloud`, `WHATSAPP_ACCESS_TOKEN`, and `WHATSAPP_PHONE_NUMBER_ID`.

Inbound WhatsApp webhook requests enqueue the assistant reply and immediately flush the outbox through the configured sender. The local `/admin/simulate-message` endpoint still only simulates the conversation and leaves sends to `/admin/outbox/flush`.

## Safety model

- User data is isolated by WhatsApp phone number and internal user id.
- Local memory, task, reminder, and draft writes can happen automatically.
- Risky external actions, such as sending email or submitting a web form, create pending approvals instead of executing.
- Admin endpoints can be protected with `ADMIN_TOKEN`.
- WhatsApp webhook signatures are enforced when `WHATSAPP_APP_SECRET` is set.
- Inbound WhatsApp message ids are claimed once, so duplicate webhook delivery is idempotent.
- Dry-run WhatsApp mode is the local default and does not call external APIs.

## Known non-goals

- Public signup.
- Billing.
- Autonomous email sending without confirmation.
- Autonomous web form submission without confirmation.
- Broad Gmail, Calendar, or Drive integrations.
- Mobile app.
- End-user configuration UI.
- Long-term vector-memory optimization.
- Production-scale observability.
- WhatsApp Web scraping.
