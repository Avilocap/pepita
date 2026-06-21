import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentRuntime, type AgentRuntime } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import type { Approval, User } from "../src/domain.js";
import { SqliteRepository } from "../src/repository.js";
import { DryRunWhatsAppSender, type WhatsAppSender } from "../src/whatsapp.js";

const dirs: string[] = [];
const databases: Database[] = [];
const apps: FastifyInstance[] = [];
const defaultNow = "2030-01-01T09:00:00.000Z";

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));

  for (const db of databases.splice(0)) {
    db.close();
  }

  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("loads defaults from an empty environment", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      databasePath: ".data/pepita.sqlite",
      agentRuntime: "local",
      adminToken: null,
      whatsappVerifyToken: "change-me",
      whatsappAccessToken: null,
      whatsappPhoneNumberId: null,
      whatsappAppSecret: null,
      whatsappSendMode: "dry-run"
    });
  });

  it("loads configured values from environment variables", () => {
    expect(
      loadConfig({
        HOST: "localhost",
        PORT: "4010",
        ADMIN_TOKEN: "admin-token",
        PEPITA_DATABASE_PATH: "/tmp/pepita.sqlite",
        PEPITA_AGENT_RUNTIME: "pi",
        WHATSAPP_VERIFY_TOKEN: "verify-token",
        WHATSAPP_ACCESS_TOKEN: "access-token",
        WHATSAPP_PHONE_NUMBER_ID: "phone-number-id",
        WHATSAPP_APP_SECRET: "app-secret",
        WHATSAPP_SEND_MODE: "cloud"
      })
    ).toEqual({
      host: "localhost",
      port: 4010,
      databasePath: "/tmp/pepita.sqlite",
      agentRuntime: "pi",
      adminToken: "admin-token",
      whatsappVerifyToken: "verify-token",
      whatsappAccessToken: "access-token",
      whatsappPhoneNumberId: "phone-number-id",
      whatsappAppSecret: "app-secret",
      whatsappSendMode: "cloud"
    });
  });

  it("throws for invalid ports and agent runtimes", () => {
    for (const port of ["0", "65536", "-1", "abc"]) {
      expect(() => loadConfig({ PORT: port })).toThrow("Invalid PORT");
    }

    expect(() => loadConfig({ PEPITA_AGENT_RUNTIME: "remote" })).toThrow("Invalid PEPITA_AGENT_RUNTIME");
  });

  it("requires cloud WhatsApp credentials only when cloud send mode is configured", () => {
    expect(loadConfig({ WHATSAPP_SEND_MODE: "dry-run" })).toMatchObject({
      whatsappSendMode: "dry-run",
      whatsappAccessToken: null,
      whatsappPhoneNumberId: null
    });
    expect(() => loadConfig({ WHATSAPP_SEND_MODE: "cloud", WHATSAPP_ACCESS_TOKEN: "access-token" })).toThrow(
      "WHATSAPP_PHONE_NUMBER_ID"
    );
    expect(() => loadConfig({ WHATSAPP_SEND_MODE: "cloud", WHATSAPP_PHONE_NUMBER_ID: "phone-number-id" })).toThrow(
      "WHATSAPP_ACCESS_TOKEN"
    );
  });

  it("requires admin and non-default WhatsApp verification tokens in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", ADMIN_TOKEN: "admin-token" })).toThrow(
      "WHATSAPP_VERIFY_TOKEN"
    );
    expect(() =>
      loadConfig({ NODE_ENV: "production", WHATSAPP_VERIFY_TOKEN: "verify-token" })
    ).toThrow("ADMIN_TOKEN");
  });

  it("requires a WhatsApp app secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ADMIN_TOKEN: "admin-token",
        WHATSAPP_VERIFY_TOKEN: "verify-token",
        WHATSAPP_SEND_MODE: "cloud",
        WHATSAPP_ACCESS_TOKEN: "access-token",
        WHATSAPP_PHONE_NUMBER_ID: "phone-number-id"
      })
    ).toThrow("WHATSAPP_APP_SECRET");
  });

  it("requires an explicit WhatsApp send mode in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ADMIN_TOKEN: "admin-token",
        WHATSAPP_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
        WHATSAPP_ACCESS_TOKEN: "access-token",
        WHATSAPP_PHONE_NUMBER_ID: "phone-number-id"
      })
    ).toThrow("WHATSAPP_SEND_MODE");
  });

  it("loads production cloud WhatsApp config when all required credentials are present", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        ADMIN_TOKEN: "admin-token",
        WHATSAPP_VERIFY_TOKEN: "verify-token",
        WHATSAPP_APP_SECRET: "app-secret",
        WHATSAPP_SEND_MODE: "cloud",
        WHATSAPP_ACCESS_TOKEN: "access-token",
        WHATSAPP_PHONE_NUMBER_ID: "phone-number-id"
      })
    ).toMatchObject({
      adminToken: "admin-token",
      whatsappVerifyToken: "verify-token",
      whatsappAppSecret: "app-secret",
      whatsappSendMode: "cloud",
      whatsappAccessToken: "access-token",
      whatsappPhoneNumberId: "phone-number-id"
    });
  });

  it("requires an admin token when binding beyond localhost", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow("ADMIN_TOKEN");
    expect(loadConfig({ HOST: "0.0.0.0", ADMIN_TOKEN: "admin-token" })).toMatchObject({
      host: "0.0.0.0",
      adminToken: "admin-token"
    });
  });
});

describe("HTTP app", () => {
  it("GET /health returns ok", async () => {
    const { app } = await createAppContext();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("GET /webhooks/whatsapp returns challenge for a valid verify token", async () => {
    const { app } = await createAppContext();

    const response = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-123");
  });

  it("GET /webhooks/whatsapp returns 403 for an invalid verify token", async () => {
    const { app } = await createAppContext();

    const response = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-123"
    });

    expect(response.statusCode).toBe(403);
  });

  it("POST /webhooks/whatsapp parses inbound text and persists user state", async () => {
    const { app, repo } = await createAppContext();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: whatsappPayload({
        id: "wamid.memory",
        from: "34600000001",
        text: "recuerda que prefiero llamadas por la tarde"
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, messages: 1, processed: 1, skipped: 0 });

    const users = await repo.listUsers();
    expect(users).toMatchObject([{ phoneNumber: "+34600000001" }]);
    expect(await repo.listMemoryFacts(users[0].id)).toMatchObject([
      {
        userId: users[0].id,
        text: "prefiero llamadas por la tarde",
        sourceMessageId: "wamid.memory"
      }
    ]);
  });

  it("POST /webhooks/whatsapp accepts a valid X-Hub-Signature-256 when an app secret is configured", async () => {
    const { app, repo } = await createAppContext({
      config: { whatsappAppSecret: "app-secret" }
    });
    const payload = JSON.stringify(
      whatsappPayload({
        id: "wamid.signed",
        from: "34600000001",
        text: "recuerda que prefiero email"
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, "app-secret")
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, messages: 1, processed: 1, skipped: 0 });
    const user = (await repo.listUsers())[0];
    expect(await repo.listMemoryFacts(user.id)).toHaveLength(1);
  });

  it("POST /webhooks/whatsapp rejects missing or invalid signatures when an app secret is configured", async () => {
    const { app, repo } = await createAppContext({
      config: { whatsappAppSecret: "app-secret" }
    });
    const payload = JSON.stringify(
      whatsappPayload({
        id: "wamid.unsigned",
        from: "34600000001",
        text: "recuerda que prefiero email"
      })
    );

    const missingSignature = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload
    });
    const invalidSignature = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=00"
      },
      payload
    });

    expect(missingSignature.statusCode).toBe(401);
    expect(invalidSignature.statusCode).toBe(401);
    expect(await repo.listUsers()).toHaveLength(0);
  });

  it("POST /webhooks/whatsapp rejects an unsigned body before JSON parsing when an app secret is configured", async () => {
    const { app } = await createAppContext({
      config: { whatsappAppSecret: "app-secret" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: "{not-json"
    });

    expect(response.statusCode).toBe(401);
  });

  it("POST /webhooks/whatsapp skips duplicate WhatsApp message ids", async () => {
    const { app, repo } = await createAppContext();
    const payload = whatsappPayload({
      id: "wamid.duplicate",
      from: "34600000001",
      text: "recuerda que prefiero llamadas por la tarde"
    });

    const first = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload });
    const second = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, messages: 1, processed: 1, skipped: 0 });
    expect(second.json()).toEqual({ received: true, messages: 1, processed: 0, skipped: 1 });

    const user = (await repo.listUsers())[0];
    expect(await repo.listMemoryFacts(user.id)).toHaveLength(1);
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
  });

  it("allows authorized admin requests and rejects missing or wrong Bearer tokens when configured", async () => {
    const { app, repo } = await createAppContext({ config: { adminToken: "admin-token" } });
    await repo.findOrCreateUserByPhone("+34600000001");

    const authorized = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: "Bearer admin-token" }
    });
    const missing = await app.inject({ method: "GET", url: "/admin/users" });
    const wrong = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { authorization: "Bearer wrong-token" }
    });

    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().users).toHaveLength(1);
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("POST /admin/simulate-message handles local inbound messages without a WhatsApp payload", async () => {
    const { app, repo } = await createAppContext();

    const response = await app.inject({
      method: "POST",
      url: "/admin/simulate-message",
      payload: {
        from: "+34600000002",
        text: "recuerdame llamar al gestor manana",
        messageId: "local.1",
        timestamp: defaultNow,
        now: defaultNow
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true, userId: expect.any(String), reply: expect.any(String) });

    const user = (await repo.listUsers())[0];
    expect(user.phoneNumber).toBe("+34600000002");
    expect(await repo.listTasks(user.id)).toMatchObject([
      {
        userId: user.id,
        title: "llamar al gestor",
        sourceMessageId: "local.1",
        status: "open"
      }
    ]);
  });

  it("GET /admin/users lists users", async () => {
    const { app, repo } = await createAppContext();
    await repo.findOrCreateUserByPhone("+34600000001");
    await repo.findOrCreateUserByPhone("+34600000002");

    const response = await app.inject({ method: "GET", url: "/admin/users" });

    expect(response.statusCode).toBe(200);
    expect(response.json().users.map((user: User) => user.phoneNumber).sort()).toEqual([
      "+34600000001",
      "+34600000002"
    ]);
  });

  it("GET /admin/users/:id returns user data, memory, tasks, approvals, outbox, and audit logs", async () => {
    const { app, repo } = await createAppContext();
    const seeded = await seedFullUser(repo, "+34600000001");

    const response = await app.inject({ method: "GET", url: `/admin/users/${seeded.user.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: seeded.user.id, phoneNumber: "+34600000001" },
      memory: [{ id: seeded.memoryId, text: "Prefiere email" }],
      tasks: [{ id: seeded.taskId, title: "Llamar al gestor" }],
      approvals: [{ id: seeded.approvalId, title: "Correo al gestor" }],
      outbox: [{ id: seeded.outboxId, body: "Respuesta pendiente" }],
      auditLogs: [{ id: seeded.auditLogId, action: "test.seeded" }]
    });
  });

  it("POST /admin/scheduler/run triggers reminders", async () => {
    const { app, repo } = await createAppContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    await repo.addTask({
      userId: user.id,
      title: "Llamar al gestor",
      dueAt: defaultNow,
      sourceMessageId: "local.1"
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/scheduler/run",
      payload: { now: defaultNow }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enqueued: 1 });
    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([
      { userId: user.id, body: "Recordatorio: Llamar al gestor", status: "queued" }
    ]);
  });

  it("POST /admin/outbox/flush sends queued messages through the injected dry-run sender", async () => {
    const sender = new DryRunWhatsAppSender();
    const { app, repo } = await createAppContext({ sender });
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Hola Maria",
      templateName: null,
      scheduledFor: null
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/outbox/flush",
      payload: { now: defaultNow }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: 1, failed: 0 });
    expect(sender.sentTextMessages).toEqual([{ to: "+34600000001", text: "Hola Maria" }]);
    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([{ status: "sent", sentAt: defaultNow }]);
  });

  it("POST /admin/outbox/flush returns sent and failed counts when the sender fails", async () => {
    const sender = new SelectiveFailWhatsAppSender("Mensaje fallido");
    const { app, repo } = await createAppContext({ sender });
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Mensaje correcto",
      templateName: null,
      scheduledFor: null
    });
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Mensaje fallido",
      templateName: null,
      scheduledFor: null
    });

    const response = await app.inject({
      method: "POST",
      url: "/admin/outbox/flush",
      payload: { now: defaultNow }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: 1, failed: 1 });
    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([
      { body: "Mensaje correcto", status: "sent", sentAt: defaultNow, error: null },
      { body: "Mensaje fallido", status: "failed", sentAt: null, error: "send failed" }
    ]);
  });

  it("POST /admin/approvals/:id/resolve approves or rejects pending approvals", async () => {
    const { app, repo } = await createAppContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const approved = await createApproval(repo, user, "Correo aprobado");
    const rejected = await createApproval(repo, user, "Correo rechazado");

    const approveResponse = await app.inject({
      method: "POST",
      url: `/admin/approvals/${approved.id}/resolve`,
      payload: { userId: user.id, status: "approved" }
    });
    const rejectResponse = await app.inject({
      method: "POST",
      url: `/admin/approvals/${rejected.id}/resolve`,
      payload: { userId: user.id, status: "rejected" }
    });

    expect(approveResponse.statusCode).toBe(200);
    expect(rejectResponse.statusCode).toBe(200);
    expect(approveResponse.json()).toMatchObject({ approval: { id: approved.id, status: "approved" } });
    expect(rejectResponse.json()).toMatchObject({ approval: { id: rejected.id, status: "rejected" } });
  });

  it("GET /admin/users/:id/export returns only that user's data", async () => {
    const { app, repo } = await createAppContext();
    const maria = await seedFullUser(repo, "+34600000001");
    const ana = await seedFullUser(repo, "+34600000002");

    const response = await app.inject({ method: "GET", url: `/admin/users/${maria.user.id}/export` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: maria.user.id },
      memory: [{ userId: maria.user.id }],
      tasks: [{ userId: maria.user.id }],
      approvals: [{ userId: maria.user.id }],
      outbox: [{ userId: maria.user.id }],
      auditLogs: [{ userId: maria.user.id }]
    });
    expect(JSON.stringify(response.json())).not.toContain(ana.user.id);
  });

  it("DELETE /admin/users/:id deletes only that user's data", async () => {
    const { app, repo } = await createAppContext();
    const maria = await seedFullUser(repo, "+34600000001");
    const ana = await seedFullUser(repo, "+34600000002");

    const response = await app.inject({ method: "DELETE", url: `/admin/users/${maria.user.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true });
    expect(await repo.getUser(maria.user.id)).toBeNull();
    expect(await repo.getUser(ana.user.id)).toMatchObject({ id: ana.user.id });
    expect(await repo.listMemoryFacts(ana.user.id)).toHaveLength(1);
    expect(await repo.listTasks(ana.user.id)).toHaveLength(1);
    expect(await repo.listApprovals(ana.user.id)).toHaveLength(1);
    expect(await repo.listOutgoingMessages(ana.user.id)).toHaveLength(1);
    expect(await repo.listAuditLogs(ana.user.id)).toHaveLength(1);
  });

  it("invalid admin payloads return 400 instead of 500", async () => {
    const { app } = await createAppContext();

    const invalidSimulate = await app.inject({
      method: "POST",
      url: "/admin/simulate-message",
      payload: { text: "hola" }
    });
    const invalidScheduler = await app.inject({
      method: "POST",
      url: "/admin/scheduler/run",
      payload: { now: "not-a-date" }
    });
    const invalidApproval = await app.inject({
      method: "POST",
      url: "/admin/approvals/approval_missing/resolve",
      payload: { userId: "user_missing", status: "maybe" }
    });

    expect(invalidSimulate.statusCode).toBe(400);
    expect(invalidScheduler.statusCode).toBe(400);
    expect(invalidApproval.statusCode).toBe(400);
  });

  it("unknown user endpoints return 404 where appropriate", async () => {
    const { app } = await createAppContext();

    const details = await app.inject({ method: "GET", url: "/admin/users/user_missing" });
    const exported = await app.inject({ method: "GET", url: "/admin/users/user_missing/export" });
    const deleted = await app.inject({ method: "DELETE", url: "/admin/users/user_missing" });

    expect(details.statusCode).toBe(404);
    expect(exported.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(404);
  });
});

async function createAppContext(
  options: {
    agentRuntime?: AgentRuntime;
    config?: Partial<AppConfig>;
    sender?: WhatsAppSender;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "pepita-app-"));
  dirs.push(dir);

  const db = openDatabase(join(dir, "pepita.sqlite"));
  databases.push(db);

  const repo = new SqliteRepository(db);
  await repo.migrate();

  const sender = options.sender ?? new DryRunWhatsAppSender();
  const app = createApp({
    config: testConfig(options.config),
    repository: repo,
    agentRuntime: options.agentRuntime ?? new LocalAgentRuntime(),
    whatsappSender: sender
  });
  apps.push(app);

  return { app, repo, sender };
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    agentRuntime: "local",
    adminToken: null,
    whatsappVerifyToken: "verify-token",
    whatsappAccessToken: null,
    whatsappPhoneNumberId: null,
    whatsappAppSecret: null,
    whatsappSendMode: "dry-run",
    ...overrides
  };
}

function whatsappPayload(input: { id: string; from: string; text: string }) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: input.id,
                  from: input.from,
                  timestamp: "1893459600",
                  type: "text",
                  text: { body: input.text }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

async function seedFullUser(repo: SqliteRepository, phoneNumber: string) {
  const user = await repo.findOrCreateUserByPhone(phoneNumber);
  const memory = await repo.addMemoryFact({
    userId: user.id,
    text: "Prefiere email",
    sourceMessageId: "seed.1",
    confidence: 0.9
  });
  const task = await repo.addTask({
    userId: user.id,
    title: "Llamar al gestor",
    dueAt: defaultNow,
    sourceMessageId: "seed.1"
  });
  const approval = await createApproval(repo, user, "Correo al gestor");
  const outbox = await repo.enqueueOutgoingMessage({
    userId: user.id,
    to: user.phoneNumber,
    body: "Respuesta pendiente",
    templateName: null,
    scheduledFor: null
  });
  const auditLog = await repo.addAuditLog({
    userId: user.id,
    actor: "test",
    action: "test.seeded",
    payload: { ok: true }
  });

  return {
    user,
    memoryId: memory.id,
    taskId: task.id,
    approvalId: approval.id,
    outboxId: outbox.id,
    auditLogId: auditLog.id
  };
}

async function createApproval(repo: SqliteRepository, user: User, title: string): Promise<Approval> {
  return repo.addApproval({
    userId: user.id,
    type: "email_draft",
    title,
    payload: { body: "Hola" }
  });
}

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

class SelectiveFailWhatsAppSender implements WhatsAppSender {
  readonly sentTextMessages: Array<{ to: string; text: string }> = [];

  constructor(private readonly failingText: string) {}

  async sendText(to: string, text: string): Promise<void> {
    if (text === this.failingText) throw new Error("send failed");

    this.sentTextMessages.push({ to, text });
  }
}
