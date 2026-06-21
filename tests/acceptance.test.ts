import { createHmac } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase, type Database } from "../src/db.js";
import type { User } from "../src/domain.js";
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

describe("Pepita MVP acceptance", () => {
  it("starts locally without external credentials and reports health", async () => {
    const { app, config } = await createAcceptanceContext();

    expect(config).toMatchObject({
      adminToken: null,
      whatsappAccessToken: null,
      whatsappPhoneNumberId: null,
      whatsappAppSecret: null,
      whatsappSendMode: "dry-run",
      agentRuntime: "local"
    });

    const address = await app.listen({ port: 0, host: config.host });
    const response = await fetch(`${address}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("verifies the WhatsApp webhook challenge", async () => {
    const { app } = await createAcceptanceContext();

    const valid = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123"
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-123"
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.body).toBe("challenge-123");
    expect(invalid.statusCode).toBe(403);
  });

  it("resolves WhatsApp users by phone number and keeps two users isolated", async () => {
    const { app, repo } = await createAcceptanceContext();

    await simulate(app, {
      from: "+34600000001",
      messageId: "local.maria.memory",
      text: "recuerda que prefiero llamadas por la tarde"
    });
    await simulate(app, {
      from: "+34600000001",
      messageId: "local.maria.task",
      text: "recuerdame llamar al gestor manana"
    });
    await simulate(app, {
      from: "+34600000002",
      messageId: "local.ana.task",
      text: "recuerdame enviar factura manana"
    });

    const users = await repo.listUsers();
    const maria = findUser(users, "+34600000001");
    const ana = findUser(users, "+34600000002");

    expect(users).toHaveLength(2);
    expect(await repo.listMemoryFacts(maria.id)).toMatchObject([
      { userId: maria.id, text: "prefiero llamadas por la tarde" }
    ]);
    expect(await repo.listTasks(maria.id)).toMatchObject([
      { userId: maria.id, title: "llamar al gestor", status: "open" }
    ]);
    expect(await repo.listMemoryFacts(ana.id)).toHaveLength(0);
    expect(await repo.listTasks(ana.id)).toMatchObject([
      { userId: ana.id, title: "enviar factura", status: "open" }
    ]);
  });

  it("creates a reminder from natural language and enqueues it only once when due", async () => {
    const { app, repo } = await createAcceptanceContext();

    await simulate(app, {
      from: "+34600000001",
      messageId: "local.reminder",
      text: "recuerdame llamar al gestor manana"
    });

    const user = findUser(await repo.listUsers(), "+34600000001");
    const [task] = await repo.listTasks(user.id);
    expect(task).toMatchObject({
      userId: user.id,
      title: "llamar al gestor",
      status: "open",
      sourceMessageId: "local.reminder"
    });
    expect(task.dueAt).toEqual(expect.any(String));

    const firstRun = await app.inject({
      method: "POST",
      url: "/admin/scheduler/run",
      payload: { now: task.dueAt }
    });
    const secondRun = await app.inject({
      method: "POST",
      url: "/admin/scheduler/run",
      payload: { now: task.dueAt }
    });

    const reminders = (await repo.listOutgoingMessages(user.id)).filter((message) =>
      message.body.startsWith("Recordatorio:")
    );
    expect(firstRun.statusCode).toBe(200);
    expect(firstRun.json()).toEqual({ enqueued: 1 });
    expect(secondRun.statusCode).toBe(200);
    expect(secondRun.json()).toEqual({ enqueued: 0 });
    expect(reminders).toMatchObject([
      {
        userId: user.id,
        to: "+34600000001",
        body: "Recordatorio: llamar al gestor",
        status: "queued"
      }
    ]);
  });

  it("stores memory and creates draft approvals without sending external messages", async () => {
    const sender = new DryRunWhatsAppSender();
    const { app, repo } = await createAcceptanceContext({ sender });

    await simulate(app, {
      from: "+34600000001",
      messageId: "local.memory",
      text: "recuerda que prefiero llamadas por la tarde"
    });
    await simulate(app, {
      from: "+34600000001",
      messageId: "local.email",
      text: "redacta un correo a mi gestor pidiendo los papeles"
    });

    const user = findUser(await repo.listUsers(), "+34600000001");
    const memory = await repo.listMemoryFacts(user.id);
    const approvals = await repo.listApprovals(user.id);
    const admin = await app.inject({ method: "GET", url: `/admin/users/${user.id}` });

    expect(memory).toMatchObject([{ text: "prefiero llamadas por la tarde", sourceMessageId: "local.memory" }]);
    expect(approvals).toMatchObject([
      {
        userId: user.id,
        type: "email_draft",
        title: "Borrador de correo",
        status: "pending"
      }
    ]);
    expect(sender.sentTextMessages).toHaveLength(0);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().approvals).toMatchObject([{ id: approvals[0].id, status: "pending" }]);
  });

  it("can switch to Pi mode by config and fails safely when Pi auth is not configured", async () => {
    const { app, repo, config } = await createAcceptanceContext({
      env: {
        PEPITA_AGENT_RUNTIME: "pi",
        PEPITA_PI_AUTH_PATH: "/tmp/pepita-missing-pi-auth.json"
      }
    });

    const response = await simulate(app, {
      from: "+34600000001",
      messageId: "local.pi",
      text: "recuerdame llamar al gestor manana"
    });

    const user = findUser(await repo.listUsers(), "+34600000001");
    expect(config.agentRuntime).toBe("pi");
    expect(config.piProvider).toBe("openai-codex");
    expect(config.piModel).toBe("gpt-5.4-mini");
    expect(config.piAuthPath).toBe("/tmp/pepita-missing-pi-auth.json");
    expect(response.reply).toBe("Ahora mismo no he podido procesar esto. Lo he dejado registrado para revisarlo.");
    expect(await repo.listTasks(user.id)).toHaveLength(0);
    expect(await repo.listApprovals(user.id)).toHaveLength(0);
  });

  it("enforces admin bearer auth when configured", async () => {
    const { app, repo } = await createAcceptanceContext({
      config: { adminToken: "admin-token" }
    });
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

  it("requires valid WhatsApp signatures and ignores duplicate message ids", async () => {
    const { app, repo } = await createAcceptanceContext({
      config: { whatsappAppSecret: "app-secret" }
    });
    const payload = JSON.stringify(
      whatsappPayload({
        id: "wamid.acceptance",
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
    const accepted = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, "app-secret")
      },
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, "app-secret")
      },
      payload
    });

    const user = findUser(await repo.listUsers(), "+34600000001");
    expect(missingSignature.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ received: true, messages: 1, processed: 1, skipped: 0 });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ received: true, messages: 1, processed: 0, skipped: 1 });
    expect(await repo.listMemoryFacts(user.id)).toHaveLength(1);
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
  });

  it("documents local setup, operations, safety, and production requirements", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    for (const requiredText of [
      "Pepita MVP",
      "Node >=25.7.0",
      "npm test",
      "npm run dev",
      "curl",
      "WhatsApp webhook",
      "ADMIN_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_SEND_MODE=cloud",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "non-default WHATSAPP_VERIFY_TOKEN",
      "Safety model",
      "Known non-goals"
    ]) {
      expect(readme).toContain(requiredText);
    }
  });
});

async function createAcceptanceContext(
  options: {
    env?: Record<string, string | undefined>;
    config?: Partial<AppConfig>;
    sender?: WhatsAppSender;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "pepita-acceptance-"));
  dirs.push(dir);

  const config = {
    ...loadConfig({
      PEPITA_DATABASE_PATH: join(dir, "pepita.sqlite"),
      WHATSAPP_VERIFY_TOKEN: "verify-token",
      ...options.env
    }),
    ...options.config
  };
  const db = openDatabase(config.databasePath);
  databases.push(db);

  const repo = new SqliteRepository(db);
  await repo.migrate();

  const sender = options.sender ?? new DryRunWhatsAppSender();
  const app = createApp({
    config,
    repository: repo,
    agentRuntime: createAgentRuntime({
      runtime: config.agentRuntime,
      piProvider: config.piProvider,
      piModel: config.piModel,
      piAuthPath: config.piAuthPath ?? undefined
    }),
    whatsappSender: sender
  });
  apps.push(app);

  return { app, repo, sender, config };
}

async function simulate(
  app: FastifyInstance,
  input: { from: string; messageId: string; text: string }
): Promise<{ userId: string; reply: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/simulate-message",
    payload: {
      from: input.from,
      messageId: input.messageId,
      text: input.text,
      timestamp: defaultNow,
      now: defaultNow
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json();
}

function findUser(users: User[], phoneNumber: string): User {
  const user = users.find((candidate) => candidate.phoneNumber === phoneNumber);
  expect(user).toBeDefined();
  return user as User;
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

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}
