# Pepita MVP Specification

## 1. Summary

Pepita is a WhatsApp-first personal assistant for non-technical users who need a second brain. The MVP targets one real user first, Maria, and then a small controlled pilot with several isolated users behind the same WhatsApp Business number.

The product is not "an agent framework for consumers". The product is a reliable assistant that receives messy thoughts, converts them into memory/tasks/reminders, follows up, drafts useful text, and asks for confirmation before taking risky actions.

## 2. Product Thesis

The wedge is mental load reduction.

Maria should be able to send Pepita a WhatsApp text or voice note such as:

> "Recuerdame llamar al gestor manana por la manana y prepara un correo para pedirle los papeles de la renta."

Pepita should:

- capture the task;
- store useful memory;
- create a reminder;
- draft the email;
- ask before sending anything;
- follow up later if the task remains open.

The user should never need to know what a skill, tool, prompt, cron job, vector store, or agent runtime is.

## 3. MVP Goals

The MVP must prove these behaviors:

1. A user can interact with Pepita through WhatsApp with no app install.
2. Pepita identifies each user by phone number and keeps all data isolated per user.
3. Pepita can remember durable facts about the user.
4. Pepita can extract tasks and reminders from natural language.
5. Pepita can send proactive reminders through approved WhatsApp templates when required.
6. Pepita can draft emails/messages but must ask for confirmation before sending.
7. Pepita can run safe web browsing tasks in a controlled worker, with explicit confirmation before irreversible actions.
8. An admin can inspect user state, queued actions, failures, and pending approvals.
9. The system can run locally for development without real WhatsApp/OpenAI/Pi credentials.

## 4. Non-Goals

The MVP will not include:

- public signup;
- billing;
- autonomous email sending without confirmation;
- autonomous form submission without confirmation;
- broad Gmail/Calendar/Drive integrations beyond one explicitly configured user;
- mobile app;
- complex multi-agent orchestration;
- end-user configuration UI;
- long-term vector-memory optimization;
- healthcare, legal, or financial advice workflows;
- production-scale observability;
- WhatsApp Web scraping.

## 5. Target Users

### Primary User

Maria: non-technical, chaotic, overloaded, uses WhatsApp naturally, needs help remembering, organizing, drafting, and following up.

### Secondary Users

Small pilot users in Spain who accept a manual onboarding process. They are identified by their WhatsApp phone number and configured by an admin.

## 6. User Experience

### Inbound Message

1. User sends WhatsApp text or voice note.
2. Pepita acknowledges quickly.
3. Pepita extracts intent:
   - remember fact;
   - create task;
   - create reminder;
   - draft content;
   - answer question;
   - prepare a web/email action requiring approval.
4. Pepita stores structured state.
5. Pepita replies with a short human-readable summary.

### Proactive Reminder

1. Scheduler detects a due reminder.
2. If the user is inside the WhatsApp 24-hour customer-service window, Pepita sends a normal message.
3. If outside the window, Pepita uses an approved WhatsApp template.
4. The reminder is marked as sent to avoid duplicates.

### Risky Action

Risky actions include sending email, submitting web forms, changing account settings, deleting data, or spending money.

Flow:

1. Pepita prepares the action.
2. Pepita creates a pending approval.
3. Pepita sends the user a clear confirmation message.
4. The action only executes after explicit approval.
5. The action result is logged.

## 7. System Architecture

Use a modular TypeScript monolith for the MVP.

```text
WhatsApp Cloud API
  -> Fastify webhook
  -> user resolver
  -> conversation service
  -> agent runtime
  -> tool registry
  -> store
  -> outbox
  -> WhatsApp sender

scheduler
  -> due reminders
  -> outbox

admin API
  -> users
  -> memory
  -> tasks
  -> approvals
  -> failures
```

The architecture has one rule: product state lives in Pepita, not inside the agent runtime.

Pi can run the reasoning/tool loop, but Postgres/SQLite/JSON store owns:

- users;
- memories;
- tasks;
- reminders;
- approvals;
- tool permissions;
- credentials metadata;
- audit logs;
- outbound messages.

## 8. Recommended Stack

For the first MVP:

- Node.js + TypeScript.
- Fastify for HTTP.
- Vitest for tests.
- SQLite or JSON file store for local MVP.
- Postgres when moving beyond local testing.
- Queue/scheduler in-process for MVP.
- Redis/BullMQ later if needed.
- WhatsApp Cloud API official integration.
- Pi Agent Harness as optional runtime adapter.
- Deterministic local runtime for tests and development.
- Playwright worker for controlled web browsing tasks later in the MVP.

## 9. Agent Runtime Decision

Pepita should not expose Pi directly.

Use an internal interface:

```text
AgentRuntime.handleMessage(context) -> AgentResult
```

Where `AgentResult` contains:

- reply text;
- memory writes;
- task writes;
- reminder writes;
- draft outputs;
- approval requests;
- errors.

Implement two runtimes:

1. `LocalAgentRuntime`
   - deterministic;
   - no LLM required;
   - used for tests/local development;
   - handles simple commands and obvious natural-language patterns.

2. `PiAgentRuntime`
   - optional;
   - enabled by environment variable;
   - receives only scoped tools;
   - cannot directly send email or submit forms;
   - must create approval requests for risky actions.

## 10. Tool Safety Model

Every tool has metadata:

- name;
- description;
- input schema;
- permission scope;
- risk level;
- confirmation requirement;
- timeout;
- audit label.

Risk levels:

- `read`: safe lookup, memory search, task list.
- `write_local`: create task, memory, reminder.
- `draft`: prepare email/message/document.
- `external_read`: browse a web page or fetch email/calendar.
- `external_write`: send email, submit form, book appointment, modify external state.

Rules:

- `read`, `write_local`, and `draft` can run automatically.
- `external_read` can run only for configured users.
- `external_write` always requires explicit approval.
- No shell access in the consumer runtime.
- No unrestricted browser session with user credentials in the main process.

## 11. Data Model

Minimum entities:

### User

- `id`
- `phone_number`
- `display_name`
- `locale`
- `timezone`
- `created_at`
- `last_seen_at`
- `service_window_until`

### MemoryFact

- `id`
- `user_id`
- `text`
- `source_message_id`
- `confidence`
- `created_at`

### Task

- `id`
- `user_id`
- `title`
- `status`
- `due_at`
- `reminded_at`
- `source_message_id`
- `created_at`

### Approval

- `id`
- `user_id`
- `type`
- `title`
- `payload`
- `status`
- `created_at`
- `resolved_at`

### OutgoingMessage

- `id`
- `user_id`
- `channel`
- `to`
- `body`
- `template_name`
- `status`
- `scheduled_for`
- `sent_at`
- `error`
- `created_at`

### AuditLog

- `id`
- `user_id`
- `actor`
- `action`
- `payload`
- `created_at`

## 12. WhatsApp Constraints

Use WhatsApp Cloud API, not WhatsApp Web automation.

Constraints to design around:

- inbound user messages arrive through webhooks;
- outbound free-form replies are allowed inside the customer-service window;
- proactive messages outside the window require approved templates;
- new accounts have messaging limits for unique users contacted outside the service window;
- Cloud API throughput is not the MVP bottleneck;
- platform policy risk exists for general-purpose AI assistants, especially outside the EEA/Brazil exception context.

MVP implication:

- start with Spain/EEA users;
- keep message volume low;
- use templates for reminders and daily summaries;
- keep a fallback channel path in the architecture.

## 13. Admin Requirements

Admin API or minimal local dashboard must support:

- list users;
- inspect one user's memory, tasks, approvals, and outbox;
- send a simulated inbound message without WhatsApp;
- manually trigger scheduler;
- mark approvals approved/rejected;
- see recent errors.

No polished UI is required for the first implementation. HTTP endpoints are enough.

## 14. Privacy And Security Requirements

Minimum bar from day one:

- data isolated by `user_id`;
- no cross-user memory access;
- secrets never stored in source control;
- explicit user consent before pilot onboarding;
- ability to export one user's data;
- ability to delete one user's data;
- audit log for external actions;
- confirmation before irreversible actions;
- environment-based credentials;
- no production credentials in tests.

## 15. MVP Acceptance Criteria

The MVP is acceptable when all of these are true:

1. A local developer can run the app without external credentials.
2. `/health` returns OK.
3. WhatsApp webhook verification works.
4. A WhatsApp inbound text creates or resolves a user by phone number.
5. User A and User B have isolated state.
6. A message such as "recuerdame llamar al gestor manana" creates a task/reminder.
7. A message such as "recuerda que prefiero llamadas por la tarde" stores a memory fact.
8. A message such as "redacta un correo a mi gestor pidiendo los papeles" creates a draft approval, not an email send.
9. Due reminders enqueue one outgoing WhatsApp message and do not duplicate.
10. Pending approvals can be inspected by admin.
11. The test suite proves the critical behaviors above.
12. The code can be switched from local runtime to Pi runtime with configuration.

## 16. Implementation Order

1. Project skeleton and tests.
2. Domain model and store.
3. WhatsApp webhook parsing and sender abstraction.
4. User resolver and conversation service.
5. Local deterministic runtime.
6. Task, memory, reminder, and approval tools.
7. Scheduler and outbox.
8. Admin endpoints.
9. Pi runtime adapter behind a feature flag.
10. Optional real WhatsApp smoke test.

## 17. Open Decisions Before Plan

These must be resolved before writing the implementation plan:

1. Persistence for MVP: JSON file, SQLite, or Postgres.
2. Initial runtime: local-only first, or Pi adapter in the first build.
3. Whether voice notes are in scope for the first implementation plan.
4. Whether Gmail sending is in scope, or only draft approvals.
5. Whether admin surface is HTTP-only or a minimal web UI.

## 18. Recommended Decisions

Recommended for the first implementation plan:

1. Use SQLite instead of JSON file if we want fewer rewrites later.
2. Build local runtime first, Pi adapter second.
3. Defer voice transcription until text flow is reliable.
4. Include email drafts, defer real Gmail sending.
5. Use HTTP-only admin endpoints first.

This keeps the MVP small enough to ship, while preserving the architecture for real actions later.
