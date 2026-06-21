# Pepita MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pepita MVP: a WhatsApp-first second brain with isolated users, memory, tasks, reminders, draft approvals, admin HTTP endpoints, local deterministic runtime, and a Pi runtime adapter behind configuration.

**Architecture:** Implement a modular TypeScript monolith. HTTP routes call application services; services persist state in SQLite through a repository; agent runtimes return structured effects instead of mutating external systems directly. External writes are represented as approvals and audit log entries, never executed automatically.

**Tech Stack:** Node.js 25, TypeScript, Fastify, Vitest, built-in `node:sqlite`, optional `@earendil-works/pi-*` packages, official WhatsApp Cloud API sender abstraction.

---

## Global Constraints

- Work in `/Users/david/Downloads/pepita-mvp`.
- Follow the approved spec at `docs/superpowers/specs/2026-06-20-pepita-mvp-spec.md`.
- Use TDD for each implementation task: failing test first, verify red, minimal code, verify green.
- Keep the implementation small. No frontend UI. Admin endpoints only.
- Do not use WhatsApp Web automation.
- Do not send real WhatsApp, email, or browser actions in tests.
- Do not store credentials in source control.
- Commit after each task once tests pass.

## Final File Structure

- `package.json`: scripts and dependencies.
- `tsconfig.json`: strict TypeScript config.
- `vitest.config.ts`: test config.
- `.env.example`: safe environment variable template.
- `.gitignore`: excludes local data, env, build artifacts, dependencies.
- `src/config.ts`: environment parsing with defaults.
- `src/domain.ts`: domain types, ID helpers, clock helpers.
- `src/db.ts`: SQLite connection and schema migration.
- `src/repository.ts`: SQLite repository for users, memory, tasks, reminders, approvals, outbox, audit logs.
- `src/whatsapp.ts`: webhook verification, inbound parser, sender abstraction.
- `src/agent.ts`: `AgentRuntime` contract, local deterministic runtime, Pi adapter stub/runtime selector.
- `src/services.ts`: conversation service, approval service, outbox service, export/delete service.
- `src/scheduler.ts`: due reminder scanner.
- `src/app.ts`: Fastify app and routes.
- `src/server.ts`: process entrypoint.
- `tests/*.test.ts`: focused behavior tests.

---

## Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Write basic config files**

Create `package.json` with:

```json
{
  "name": "pepita-mvp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-ai": "^0.79.8",
    "@earendil-works/pi-coding-agent": "^0.79.8",
    "fastify": "^5.4.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^24.0.3",
    "tsx": "^4.20.3",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

Create `tsconfig.json` with NodeNext, strict mode, and includes for `src`, `tests`, and `vitest.config.ts`.

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

Create `.env.example`:

```env
PORT=3000
PEPITA_DATABASE_PATH=.data/pepita.sqlite
PEPITA_AGENT_RUNTIME=local

WHATSAPP_VERIFY_TOKEN=change-me
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=

OPENAI_API_KEY=
PEPITA_PI_PROVIDER=openai
PEPITA_PI_MODEL=gpt-4.1-mini
```

Create `.gitignore`:

```gitignore
node_modules/
.data/
.env
dist/
coverage/
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: dependencies installed and `package-lock.json` created.

- [ ] **Step 3: Verify baseline**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` may report no tests yet; `npm run typecheck` passes once no source files exist or after TypeScript config accepts the project.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "chore: scaffold pepita project"
```

---

## Task 2: Domain Model And SQLite Repository

**Files:**
- Create: `tests/repository.test.ts`
- Create: `src/domain.ts`
- Create: `src/db.ts`
- Create: `src/repository.ts`

- [ ] **Step 1: Write failing repository tests**

Create `tests/repository.test.ts` with tests for:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { SqliteRepository } from "../src/repository.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), "pepita-repo-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "pepita.sqlite"));
  const repo = new SqliteRepository(db);
  await repo.migrate();
  return repo;
}

describe("SqliteRepository", () => {
  it("resolves the same phone number to the same user", async () => {
    const repo = await createRepo();
    const first = await repo.findOrCreateUserByPhone("+34600000001");
    const second = await repo.findOrCreateUserByPhone("+34600000001");
    expect(second.id).toBe(first.id);
    expect(second.phoneNumber).toBe("+34600000001");
  });

  it("keeps memory and tasks isolated per user", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    await repo.addMemoryFact({ userId: maria.id, text: "Prefiere llamadas por la tarde", sourceMessageId: "m1", confidence: 0.9 });
    await repo.addTask({ userId: ana.id, title: "Enviar factura", dueAt: null, sourceMessageId: "m2" });
    expect(await repo.listMemoryFacts(maria.id)).toHaveLength(1);
    expect(await repo.listTasks(maria.id)).toHaveLength(0);
    expect(await repo.listMemoryFacts(ana.id)).toHaveLength(0);
    expect(await repo.listTasks(ana.id)).toHaveLength(1);
  });

  it("persists users, tasks, approvals, outbox, and audit logs", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const task = await repo.addTask({ userId: user.id, title: "Llamar al gestor", dueAt: "2030-01-01T09:00:00.000Z", sourceMessageId: "m1" });
    const approval = await repo.addApproval({ userId: user.id, type: "email_draft", title: "Correo al gestor", payload: { body: "Hola" } });
    const outgoing = await repo.enqueueOutgoingMessage({ userId: user.id, to: user.phoneNumber, body: "Recordatorio", templateName: null, scheduledFor: null });
    await repo.addAuditLog({ userId: user.id, actor: "agent", action: "task.created", payload: { taskId: task.id } });
    expect(task.status).toBe("open");
    expect(approval.status).toBe("pending");
    expect(outgoing.status).toBe("queued");
    expect(await repo.listAuditLogs(user.id)).toMatchObject([{ action: "task.created" }]);
  });
});
```

- [ ] **Step 2: Run test to verify red**

Run:

```bash
npm test tests/repository.test.ts
```

Expected: fails because `src/db.ts` and `src/repository.ts` do not exist.

- [ ] **Step 3: Implement domain types**

Create `src/domain.ts` exporting:

- `User`
- `MemoryFact`
- `Task`
- `Approval`
- `OutgoingMessage`
- `AuditLog`
- `NewMemoryFact`
- `NewTask`
- `NewApproval`
- `NewOutgoingMessage`
- `NewAuditLog`
- `createId(prefix: string): string`
- `nowIso(): string`

Use camelCase properties in TypeScript and map to snake_case columns in SQLite.

- [ ] **Step 4: Implement SQLite connection and migration**

Create `src/db.ts` using built-in `node:sqlite`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}
```

Migration must create tables:

- `users`
- `memory_facts`
- `tasks`
- `approvals`
- `outgoing_messages`
- `audit_logs`

Use `CREATE TABLE IF NOT EXISTS`. Add unique index on `users.phone_number`.

- [ ] **Step 5: Implement repository**

Create `src/repository.ts` with class `SqliteRepository`.

Required methods:

- `migrate()`
- `findOrCreateUserByPhone(phoneNumber)`
- `getUser(userId)`
- `listUsers()`
- `addMemoryFact(input)`
- `listMemoryFacts(userId)`
- `addTask(input)`
- `listTasks(userId)`
- `updateTask(task)`
- `addApproval(input)`
- `listApprovals(userId)`
- `resolveApproval(id, status)`
- `enqueueOutgoingMessage(input)`
- `listOutgoingMessages(userId)`
- `listQueuedOutgoingMessages(now)`
- `updateOutgoingMessage(message)`
- `addAuditLog(input)`
- `listAuditLogs(userId)`
- `exportUserData(userId)`
- `deleteUserData(userId)`

- [ ] **Step 6: Run test to verify green**

```bash
npm test tests/repository.test.ts
npm run typecheck
```

Expected: repository tests pass and typecheck passes.

- [ ] **Step 7: Commit**

```bash
git add src/domain.ts src/db.ts src/repository.ts tests/repository.test.ts
git commit -m "feat: add sqlite repository"
```

---

## Task 3: WhatsApp Channel

**Files:**
- Create: `tests/whatsapp.test.ts`
- Create: `src/whatsapp.ts`

- [ ] **Step 1: Write failing tests**

Create tests for:

- valid webhook verification returns challenge;
- invalid verification returns `false`;
- inbound text messages parse into `{ messageId, from, timestamp, type: "text", text }`;
- unsupported messages parse into a safe unsupported message;
- Cloud API sender posts correct JSON and bearer token;
- sender throws on non-2xx response.

Use this expected outbound body:

```ts
{
  messaging_product: "whatsapp",
  to: "34600000001",
  type: "text",
  text: { body: "Hola Maria" }
}
```

- [ ] **Step 2: Run test to verify red**

```bash
npm test tests/whatsapp.test.ts
```

Expected: module missing failure.

- [ ] **Step 3: Implement WhatsApp module**

Create `src/whatsapp.ts` exporting:

- `IncomingWhatsAppMessage`
- `verifyWhatsAppWebhook(query, expectedVerifyToken)`
- `parseIncomingWhatsAppMessages(payload)`
- `WhatsAppSender`
- `WhatsAppCloudSender`
- `DryRunWhatsAppSender`

Parsing rules:

- normalize `from` to `+<digits>`;
- support only text in MVP;
- convert unsupported message types to explanatory text;
- ignore malformed messages without `id` or `from`.

- [ ] **Step 4: Run test to verify green**

```bash
npm test tests/whatsapp.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp.ts tests/whatsapp.test.ts
git commit -m "feat: add whatsapp channel"
```

---

## Task 4: Local Agent Runtime And Tool Effects

**Files:**
- Create: `tests/agent.test.ts`
- Create: `src/agent.ts`

- [ ] **Step 1: Write failing tests**

Create tests proving:

```ts
const runtime = new LocalAgentRuntime();
```

Behaviors:

- `"recuerda que prefiero llamadas por la tarde"` returns one memory write and a short reply.
- `"recuerdame llamar al gestor manana"` returns one task with `dueAt` set.
- `"redacta un correo a mi gestor pidiendo los papeles"` returns one approval request of type `email_draft`.
- `"entra en la web de hacienda y mira mis notificaciones"` returns one approval/request for controlled browser action, not an executed action.
- ordinary chat returns a fallback reply and no writes.
- `createAgentRuntime({ runtime: "local" })` returns `LocalAgentRuntime`.
- `createAgentRuntime({ runtime: "pi" })` returns a Pi adapter object without executing external calls during construction.

- [ ] **Step 2: Run test to verify red**

```bash
npm test tests/agent.test.ts
```

Expected: module missing failure.

- [ ] **Step 3: Implement runtime contract**

Create:

```ts
export type AgentContext = {
  userId: string;
  phoneNumber: string;
  text: string;
  messageId: string;
  now: Date;
};

export type AgentResult = {
  reply: string;
  memoryFacts: Array<{ text: string; confidence: number }>;
  tasks: Array<{ title: string; dueAt: string | null }>;
  approvals: Array<{ type: "email_draft" | "browser_action"; title: string; payload: Record<string, unknown> }>;
};

export interface AgentRuntime {
  handleMessage(context: AgentContext): Promise<AgentResult>;
}
```

- [ ] **Step 4: Implement `LocalAgentRuntime`**

Rules:

- Lowercase and trim input for detection.
- Memory detection: starts with or includes `recuerda que`.
- Reminder/task detection: includes `recuerdame` or `recuérdame`.
- Email draft detection: includes `redacta` and `correo`.
- Browser action detection: includes `entra en`, `abre`, or `mira` plus `web`.
- For `manana`/`mañana`, due date should be next day at `09:00:00.000` in local date terms, serialized as ISO.
- Do not overbuild NLP. Simple deterministic extraction is enough.

- [ ] **Step 5: Implement Pi adapter selector**

Implement `PiAgentRuntime` with the same interface.

For this MVP, the adapter may return a safe message if Pi credentials are not configured:

```ts
"Pi runtime configurado, pero este MVP aun requiere conectar herramientas reales. Uso modo seguro."
```

It must not call external APIs in tests. Keep the class ready for later integration.

- [ ] **Step 6: Run test to verify green**

```bash
npm test tests/agent.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat: add local agent runtime"
```

---

## Task 5: Conversation And Application Services

**Files:**
- Create: `tests/services.test.ts`
- Create: `src/services.ts`

- [ ] **Step 1: Write failing tests**

Create tests for `ConversationService`:

- inbound text resolves user by phone number;
- agent memory effects create `memory_facts`;
- agent task effects create `tasks`;
- agent approvals create `approvals`;
- service enqueues one WhatsApp reply;
- all writes include the correct `userId`;
- audit logs are written for task, memory, approval, and outgoing reply.

Create tests for `UserDataService`:

- export returns one user's data only;
- delete removes one user's data and leaves another user's data intact.

- [ ] **Step 2: Run test to verify red**

```bash
npm test tests/services.test.ts
```

Expected: module missing failure.

- [ ] **Step 3: Implement services**

Create:

- `ConversationService`
- `ApprovalService`
- `OutboxService`
- `UserDataService`

`ConversationService.handleInboundMessage(input)`:

```ts
type InboundInput = {
  from: string;
  messageId: string;
  text: string;
  timestamp: string;
};
```

Flow:

1. Resolve user by phone.
2. Update `lastSeenAt` and `serviceWindowUntil` to now plus 24 hours.
3. Call agent runtime.
4. Persist memory/task/approval effects.
5. Enqueue reply to outbox.
6. Add audit logs.
7. Return `{ user, result }`.

`OutboxService.flushQueued(now)`:

1. Load queued messages due by `now`.
2. Send each through `WhatsAppSender`.
3. Mark sent or failed.

- [ ] **Step 4: Run test to verify green**

```bash
npm test tests/services.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/services.ts tests/services.test.ts
git commit -m "feat: add conversation services"
```

---

## Task 6: Reminder Scheduler

**Files:**
- Create: `tests/scheduler.test.ts`
- Create: `src/scheduler.ts`

- [ ] **Step 1: Write failing tests**

Create tests proving:

- due open task with `dueAt <= now` and `remindedAt = null` enqueues one outgoing message;
- second scheduler run does not enqueue duplicate reminder;
- future tasks do not enqueue messages;
- done tasks do not enqueue messages;
- scheduler uses template name when outside `serviceWindowUntil`;
- scheduler uses free-form message when inside service window.

- [ ] **Step 2: Run test to verify red**

```bash
npm test tests/scheduler.test.ts
```

Expected: module missing failure.

- [ ] **Step 3: Implement scheduler**

Create `ReminderScheduler`.

Constructor inputs:

- repository;
- `reminderTemplateName`, default `"pepita_reminder"`;

Method:

```ts
runDueReminders(now: Date): Promise<{ enqueued: number }>;
```

Rules:

- scan all users and open tasks;
- due means `dueAt` exists and is less than or equal to now;
- skip tasks with `remindedAt`;
- enqueue body: `Recordatorio: <task.title>`;
- set `templateName` if `now > user.serviceWindowUntil`;
- set `remindedAt` to now after enqueue;
- audit `reminder.enqueued`.

- [ ] **Step 4: Run test to verify green**

```bash
npm test tests/scheduler.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: add reminder scheduler"
```

---

## Task 7: HTTP App And Admin Endpoints

**Files:**
- Create: `tests/app.test.ts`
- Create: `src/config.ts`
- Create: `src/app.ts`
- Create: `src/server.ts`

- [ ] **Step 1: Write failing app tests**

Create tests using `app.inject()` for:

- `GET /health` returns `{ ok: true }`;
- `GET /webhooks/whatsapp` returns challenge for valid verify token;
- `GET /webhooks/whatsapp` returns 403 for invalid token;
- `POST /webhooks/whatsapp` parses inbound text, persists user state, returns `{ received: true, messages: 1 }`;
- `POST /admin/simulate-message` handles a local inbound message without WhatsApp payload;
- `GET /admin/users` lists users;
- `GET /admin/users/:id` returns user, memory, tasks, approvals, outbox, audit logs;
- `POST /admin/scheduler/run` triggers reminders;
- `POST /admin/outbox/flush` sends queued messages through injected dry-run sender;
- `POST /admin/approvals/:id/resolve` approves or rejects pending approval;
- `GET /admin/users/:id/export` returns only that user's data;
- `DELETE /admin/users/:id` deletes only that user's data.

- [ ] **Step 2: Run test to verify red**

```bash
npm test tests/app.test.ts
```

Expected: module missing failure.

- [ ] **Step 3: Implement config**

Create `src/config.ts`:

```ts
export type AppConfig = {
  port: number;
  databasePath: string;
  agentRuntime: "local" | "pi";
  whatsappVerifyToken: string;
  whatsappAccessToken: string | null;
  whatsappPhoneNumberId: string | null;
};
```

Defaults:

- `PORT=3000`
- `PEPITA_DATABASE_PATH=.data/pepita.sqlite`
- `PEPITA_AGENT_RUNTIME=local`
- `WHATSAPP_VERIFY_TOKEN=change-me`

- [ ] **Step 4: Implement app factory**

Create `createApp(deps)` in `src/app.ts`.

Dependencies:

- config;
- repository;
- agent runtime;
- WhatsApp sender;
- optional logger.

Routes:

- `GET /health`
- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`
- `POST /admin/simulate-message`
- `GET /admin/users`
- `GET /admin/users/:id`
- `GET /admin/users/:id/export`
- `DELETE /admin/users/:id`
- `POST /admin/scheduler/run`
- `POST /admin/outbox/flush`
- `POST /admin/approvals/:id/resolve`

- [ ] **Step 5: Implement server entrypoint**

Create `src/server.ts`:

1. Load config.
2. Open SQLite database.
3. Migrate.
4. Create runtime.
5. Create WhatsApp sender:
   - real Cloud sender only if access token and phone number ID are configured;
   - dry-run sender otherwise.
6. Start Fastify.

- [ ] **Step 6: Run test to verify green**

```bash
npm test tests/app.test.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/app.ts src/server.ts tests/app.test.ts
git commit -m "feat: add http app and admin api"
```

---

## Task 8: End-To-End Acceptance Tests And Docs

**Files:**
- Create: `tests/acceptance.test.ts`
- Create: `README.md`
- Modify: `.env.example` if needed

- [ ] **Step 1: Write acceptance tests**

Create `tests/acceptance.test.ts` proving the approved acceptance criteria:

1. local app starts without external credentials;
2. `/health` is OK;
3. WhatsApp webhook verification works;
4. WhatsApp inbound text creates/resolves a user;
5. two users have isolated state;
6. "recuerdame llamar al gestor manana" creates a task/reminder;
7. "recuerda que prefiero llamadas por la tarde" stores memory;
8. "redacta un correo..." creates approval, not sent email;
9. due reminders enqueue one message and do not duplicate;
10. pending approvals can be inspected by admin;
11. runtime can switch to Pi mode by config without external API calls.

- [ ] **Step 2: Run acceptance tests to verify red or partial failures**

```bash
npm test tests/acceptance.test.ts
```

Expected: failures only for missing wiring or docs-related behavior.

- [ ] **Step 3: Fix acceptance gaps**

Modify existing implementation only where acceptance tests expose missing behavior.

- [ ] **Step 4: Add README**

Create `README.md` with:

- what Pepita MVP is;
- local setup;
- env vars;
- how to run tests;
- how to run dev server;
- local simulation example with `curl`;
- WhatsApp webhook setup notes;
- safety model;
- known non-goals.

- [ ] **Step 5: Run final verification**

```bash
npm test
npm run typecheck
```

Expected: all tests pass and typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add tests/acceptance.test.ts README.md .env.example src tests
git commit -m "test: add mvp acceptance coverage"
```

---

## Task 9: Final Review And Run Smoke Server

**Files:**
- Modify only if review finds defects.

- [ ] **Step 1: Run full verification**

```bash
npm test
npm run typecheck
```

Expected: all tests pass, typecheck exits 0.

- [ ] **Step 2: Start local server**

Run:

```bash
npm start
```

Expected:

- server listens on `http://localhost:3000`;
- no external credentials required;
- dry-run sender is used if WhatsApp credentials are absent.

- [ ] **Step 3: Smoke test health route**

In another process:

```bash
curl -s http://localhost:3000/health
```

Expected:

```json
{"ok":true}
```

- [ ] **Step 4: Stop server**

Stop the `npm start` process after smoke test.

- [ ] **Step 5: Final git status**

```bash
git status --short
git log --oneline --max-count=8
```

Expected: clean or only intentional uncommitted changes.

---

## Self-Review Checklist

- Spec coverage:
  - WhatsApp route covered by Tasks 3 and 7.
  - User isolation covered by Tasks 2, 5, and 8.
  - Memory/task/reminder/draft approval covered by Tasks 4, 5, 6, and 8.
  - Admin API covered by Task 7.
  - Local run without credentials covered by Tasks 7 and 8.
  - Pi runtime switch covered by Tasks 4 and 8.
  - Privacy export/delete covered by Tasks 5, 7, and 8.

- No placeholders:
  - No placeholder markers or deferred implementation instructions.
  - All tasks include exact files, commands, and expected outcomes.

- Type consistency:
  - Runtime contract uses `AgentContext` and `AgentResult`.
  - Repository methods are named consistently across tasks.
  - Admin routes are named consistently across app and acceptance tasks.
