import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../src/db.js";
import type { User } from "../src/domain.js";
import { SqliteRepository } from "../src/repository.js";

const dirs: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
  }

  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepoContext() {
  const dir = await mkdtemp(join(tmpdir(), "pepita-repo-"));
  dirs.push(dir);

  const db = openDatabase(join(dir, "pepita.sqlite"));
  databases.push(db);

  const repo = new SqliteRepository(db);
  await repo.migrate();

  return { db, repo };
}

async function createRepo() {
  return (await createRepoContext()).repo;
}

async function seedAllUserData(repo: SqliteRepository, user: User, label: string) {
  const memoryFact = await repo.addMemoryFact({
    userId: user.id,
    text: `${label} memory`,
    sourceMessageId: `${label}-memory-message`,
    confidence: 0.9
  });
  const task = await repo.addTask({
    userId: user.id,
    title: `${label} task`,
    dueAt: "2030-01-01T09:00:00.000Z",
    sourceMessageId: `${label}-task-message`
  });
  const approval = await repo.addApproval({
    userId: user.id,
    type: "email_draft",
    title: `${label} approval`,
    payload: { label }
  });
  const outgoingMessage = await repo.enqueueOutgoingMessage({
    userId: user.id,
    to: user.phoneNumber,
    body: `${label} outgoing`,
    templateName: null,
    scheduledFor: null
  });
  const auditLog = await repo.addAuditLog({
    userId: user.id,
    actor: "agent",
    action: `${label}.created`,
    payload: { label }
  });

  return { memoryFact, task, approval, outgoingMessage, auditLog };
}

describe("SqliteRepository", () => {
  it("resolves the same phone number to the same user", async () => {
    const repo = await createRepo();

    const first = await repo.findOrCreateUserByPhone("+34600000001");
    const second = await repo.findOrCreateUserByPhone("+34600000001");

    expect(second.id).toBe(first.id);
    expect(second.phoneNumber).toBe("+34600000001");
  });

  it("handles a unique phone conflict by re-reading the existing user", async () => {
    const { db } = await createRepoContext();
    const phoneNumber = "+34600000009";
    const createdAt = "2030-01-01T09:00:00.000Z";
    const originalPrepare = db.prepare.bind(db);
    let insertedDuringCreate = false;
    const raceDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO users") && !insertedDuringCreate) {
              insertedDuringCreate = true;
              originalPrepare(
                `INSERT INTO users (
                  id, phone_number, display_name, locale, timezone,
                  created_at, last_seen_at, service_window_until
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                "user_existing",
                phoneNumber,
                "Existing",
                "es-ES",
                "Europe/Madrid",
                createdAt,
                createdAt,
                null
              );
            }

            return originalPrepare(sql);
          };
        }

        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as Database;
    const repo = new SqliteRepository(raceDb);

    const user = await repo.findOrCreateUserByPhone(phoneNumber);

    expect(user).toMatchObject({
      id: "user_existing",
      phoneNumber,
      displayName: "Existing"
    });
  });

  it("updates one user's activity timestamps and returns the updated user", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    const lastSeenAt = "2030-01-02T10:30:00.000Z";
    const serviceWindowUntil = "2030-01-03T10:30:00.000Z";

    const updated = await repo.updateUserActivity(maria.id, lastSeenAt, serviceWindowUntil);

    expect(updated).toMatchObject({
      id: maria.id,
      phoneNumber: maria.phoneNumber,
      lastSeenAt,
      serviceWindowUntil
    });
    expect(await repo.getUser(maria.id)).toMatchObject({
      id: maria.id,
      lastSeenAt,
      serviceWindowUntil
    });
    expect(await repo.getUser(ana.id)).toMatchObject({
      id: ana.id,
      lastSeenAt: ana.lastSeenAt,
      serviceWindowUntil: ana.serviceWindowUntil
    });
  });

  it("throws when updating activity for an unknown user id", async () => {
    const repo = await createRepo();

    await expect(
      repo.updateUserActivity(
        "user_missing",
        "2030-01-02T10:30:00.000Z",
        "2030-01-03T10:30:00.000Z"
      )
    ).rejects.toThrow("User not found: user_missing");
  });

  it("sets schema version and rejects invalid enum-like statuses", async () => {
    const { db, repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };

    expect(version.user_version).toBe(2);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (
            id, user_id, title, status, due_at, reminded_at, source_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("task_invalid", user.id, "Invalid", "bogus", null, null, null, "2030-01-01T09:00:00.000Z")
    ).toThrow(/CHECK constraint failed/);
  });

  it("claims inbound WhatsApp message ids once for idempotent webhook processing", async () => {
    const repo = await createRepo();

    await expect(repo.claimInboundMessage("wamid.1")).resolves.toBe(true);
    await expect(repo.claimInboundMessage("wamid.1")).resolves.toBe(false);
    await expect(repo.claimInboundMessage("wamid.2")).resolves.toBe(true);
  });

  it("keeps memory and tasks isolated per user", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");

    await repo.addMemoryFact({
      userId: maria.id,
      text: "Prefiere llamadas por la tarde",
      sourceMessageId: "m1",
      confidence: 0.9
    });
    await repo.addTask({
      userId: ana.id,
      title: "Enviar factura",
      dueAt: null,
      sourceMessageId: "m2"
    });

    expect(await repo.listMemoryFacts(maria.id)).toHaveLength(1);
    expect(await repo.listTasks(maria.id)).toHaveLength(0);
    expect(await repo.listMemoryFacts(ana.id)).toHaveLength(0);
    expect(await repo.listTasks(ana.id)).toHaveLength(1);
  });

  it("persists users, tasks, approvals, outbox, and audit logs", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    const task = await repo.addTask({
      userId: user.id,
      title: "Llamar al gestor",
      dueAt: "2030-01-01T09:00:00.000Z",
      sourceMessageId: "m1"
    });
    const approval = await repo.addApproval({
      userId: user.id,
      type: "email_draft",
      title: "Correo al gestor",
      payload: { body: "Hola" }
    });
    const outgoing = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Recordatorio",
      templateName: null,
      scheduledFor: null
    });
    await repo.addAuditLog({
      userId: user.id,
      actor: "agent",
      action: "task.created",
      payload: { taskId: task.id }
    });

    expect(await repo.listUsers()).toMatchObject([{ id: user.id, phoneNumber: "+34600000001" }]);
    expect(await repo.listTasks(user.id)).toMatchObject([{ id: task.id, status: "open" }]);
    expect(await repo.listApprovals(user.id)).toMatchObject([
      { id: approval.id, status: "pending", payload: { body: "Hola" } }
    ]);
    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([
      { id: outgoing.id, channel: "whatsapp", status: "queued" }
    ]);
    expect(await repo.listAuditLogs(user.id)).toMatchObject([
      { actor: "agent", action: "task.created", payload: { taskId: task.id } }
    ]);
  });

  it("persists a full conversation turn with audit payload ids", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    await repo.persistConversationTurn({
      userId: user.id,
      to: user.phoneNumber,
      sourceMessageId: "wamid.1",
      reply: "Hecho",
      memoryFacts: [{ text: "Prefiere email", confidence: 0.8 }],
      tasks: [{ title: "Enviar factura", dueAt: null }],
      approvals: [{ type: "email_draft", title: "Correo", payload: { body: "Hola" } }]
    });
    const memoryFact = (await repo.listMemoryFacts(user.id))[0];
    const task = (await repo.listTasks(user.id))[0];
    const approval = (await repo.listApprovals(user.id))[0];
    const outgoingMessage = (await repo.listOutgoingMessages(user.id))[0];
    const auditLogs = await repo.listAuditLogs(user.id);

    expect(memoryFact).toMatchObject({
      userId: user.id,
      text: "Prefiere email",
      sourceMessageId: "wamid.1",
      confidence: 0.8
    });
    expect(task).toMatchObject({
      userId: user.id,
      title: "Enviar factura",
      dueAt: null,
      sourceMessageId: "wamid.1"
    });
    expect(approval).toMatchObject({
      userId: user.id,
      type: "email_draft",
      title: "Correo",
      payload: { body: "Hola", sourceMessageId: "wamid.1" }
    });
    expect(outgoingMessage).toMatchObject({
      userId: user.id,
      to: user.phoneNumber,
      body: "Hecho",
      status: "queued"
    });
    expect(auditLogs).toMatchObject([
      {
        actor: "agent",
        action: "memory.created",
        payload: { memoryFactId: memoryFact.id, sourceMessageId: "wamid.1" }
      },
      {
        actor: "agent",
        action: "task.created",
        payload: { taskId: task.id, sourceMessageId: "wamid.1" }
      },
      {
        actor: "agent",
        action: "approval.created",
        payload: { approvalId: approval.id, sourceMessageId: "wamid.1" }
      },
      {
        actor: "system",
        action: "outgoing_reply.enqueued",
        payload: { outgoingMessageId: outgoingMessage.id, sourceMessageId: "wamid.1" }
      }
    ]);
  });

  it("rolls back the full conversation turn when one persisted effect fails", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    await expect(
      repo.persistConversationTurn({
        userId: user.id,
        to: user.phoneNumber,
        sourceMessageId: "wamid.1",
        reply: "Hecho",
        memoryFacts: [{ text: "Prefiere email", confidence: 0.8 }],
        tasks: [{ title: "Enviar factura", dueAt: null }],
        approvals: [{ type: "email_draft", title: "Correo", payload: { body: "Hola", invalid: 1n } as never }]
      })
    ).rejects.toThrow("Invalid JSON payload");

    expect(await repo.listMemoryFacts(user.id)).toHaveLength(0);
    expect(await repo.listTasks(user.id)).toHaveLength(0);
    expect(await repo.listApprovals(user.id)).toHaveLength(0);
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(0);
    expect(await repo.listAuditLogs(user.id)).toHaveLength(0);
  });

  it("exports only one user's data", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");

    await seedAllUserData(repo, maria, "maria");
    await seedAllUserData(repo, ana, "ana");

    const exported = await repo.exportUserData(maria.id);

    expect(exported.user?.id).toBe(maria.id);
    expect(exported.memoryFacts).toMatchObject([{ text: "maria memory" }]);
    expect(exported.tasks).toMatchObject([{ title: "maria task" }]);
    expect(exported.approvals).toMatchObject([{ title: "maria approval", payload: { label: "maria" } }]);
    expect(exported.outgoingMessages).toMatchObject([{ body: "maria outgoing" }]);
    expect(exported.auditLogs).toMatchObject([{ action: "maria.created", payload: { label: "maria" } }]);
  });

  it("deletes one user's data and leaves another user's data intact", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");

    await seedAllUserData(repo, maria, "maria");
    await seedAllUserData(repo, ana, "ana");

    await repo.deleteUserData(maria.id);
    const deleted = await repo.exportUserData(maria.id);
    const surviving = await repo.exportUserData(ana.id);

    expect(deleted.user).toBeNull();
    expect(deleted.memoryFacts).toHaveLength(0);
    expect(deleted.tasks).toHaveLength(0);
    expect(deleted.approvals).toHaveLength(0);
    expect(deleted.outgoingMessages).toHaveLength(0);
    expect(deleted.auditLogs).toHaveLength(0);
    expect(surviving.user).toMatchObject({ id: ana.id });
    expect(surviving.memoryFacts).toMatchObject([{ text: "ana memory" }]);
    expect(surviving.tasks).toMatchObject([{ title: "ana task" }]);
    expect(surviving.approvals).toMatchObject([{ title: "ana approval" }]);
    expect(surviving.outgoingMessages).toMatchObject([{ body: "ana outgoing" }]);
    expect(surviving.auditLogs).toMatchObject([{ action: "ana.created" }]);
  });

  it("lists queued outgoing messages due now and excludes future or sent messages", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    const dueNow = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Due now",
      templateName: null,
      scheduledFor: "2030-01-01T09:00:00.000Z"
    });
    const unscheduled = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Unscheduled",
      templateName: null,
      scheduledFor: null
    });
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Future",
      templateName: null,
      scheduledFor: "2030-01-01T09:05:00.000Z"
    });
    const sent = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Sent",
      templateName: null,
      scheduledFor: "2030-01-01T09:00:00.000Z"
    });
    await repo.updateOutgoingMessage({
      ...sent,
      status: "sent",
      sentAt: "2030-01-01T09:00:30.000Z",
      error: null
    });

    const queued = await repo.listQueuedOutgoingMessages("2030-01-01T09:00:00.000Z");

    expect(queued.map((message) => message.id)).toEqual([dueNow.id, unscheduled.id]);
  });

  it("uses insertion order as the queued outgoing tie-breaker", async () => {
    const { db, repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const createdAt = "2030-01-01T09:00:00.000Z";

    db.prepare(
      `INSERT INTO outgoing_messages (
        id, user_id, channel, "to", body, template_name,
        status, scheduled_for, sent_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("out_z", user.id, "whatsapp", user.phoneNumber, "First", null, "queued", null, null, null, createdAt);
    db.prepare(
      `INSERT INTO outgoing_messages (
        id, user_id, channel, "to", body, template_name,
        status, scheduled_for, sent_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("out_a", user.id, "whatsapp", user.phoneNumber, "Second", null, "queued", null, null, null, createdAt);

    const queued = await repo.listQueuedOutgoingMessages(createdAt);

    expect(queued.map((message) => message.body)).toEqual(["First", "Second"]);
  });

  it("uses insertion order as the audit log tie-breaker", async () => {
    const { db, repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const createdAt = "2030-01-01T09:00:00.000Z";

    db.prepare(
      "INSERT INTO audit_logs (id, user_id, actor, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("audit_z", user.id, "agent", "first.created", "{}", createdAt);
    db.prepare(
      "INSERT INTO audit_logs (id, user_id, actor, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("audit_a", user.id, "agent", "second.created", "{}", createdAt);

    const auditLogs = await repo.listAuditLogs(user.id);

    expect(auditLogs.map((log) => log.action)).toEqual(["first.created", "second.created"]);
  });

  it("resolves an approval by changing status and resolvedAt", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const approval = await repo.addApproval({
      userId: user.id,
      type: "email_draft",
      title: "Correo al gestor",
      payload: { body: "Hola" }
    });

    const resolved = await repo.resolveApproval(user.id, approval.id, "approved");

    expect(resolved).toMatchObject({
      id: approval.id,
      status: "approved",
      payload: { body: "Hola" }
    });
    expect(resolved.resolvedAt).toEqual(expect.any(String));
    expect((await repo.listApprovals(user.id))[0]).toMatchObject({
      id: approval.id,
      status: "approved",
      resolvedAt: resolved.resolvedAt
    });
  });

  it("does not allow one user to resolve another user's approval", async () => {
    const repo = await createRepo();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    const approval = await repo.addApproval({
      userId: maria.id,
      type: "email_draft",
      title: "Correo al gestor",
      payload: { body: "Hola" }
    });

    await expect(repo.resolveApproval(ana.id, approval.id, "approved")).rejects.toThrow(
      `Approval not found: ${approval.id}`
    );

    expect((await repo.listApprovals(maria.id))[0]).toMatchObject({
      id: approval.id,
      status: "pending",
      resolvedAt: null
    });
  });

  it("throws when updating a stale task id", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const task = await repo.addTask({
      userId: user.id,
      title: "Llamar al gestor",
      dueAt: null,
      sourceMessageId: "m1"
    });

    await expect(repo.updateTask({ ...task, id: "task_stale" })).rejects.toThrow("Task not found: task_stale");
  });

  it("atomically claims a reminder once and does not enqueue on a second claim", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const task = await repo.addTask({
      userId: user.id,
      title: "Llamar al gestor",
      dueAt: "2030-01-01T09:00:00.000Z",
      sourceMessageId: "m1"
    });
    const remindedAt = "2030-01-01T09:00:00.000Z";

    const firstClaim = await repo.claimAndEnqueueReminder({
      taskId: task.id,
      userId: user.id,
      to: user.phoneNumber,
      body: "Recordatorio: Llamar al gestor",
      dueAt: task.dueAt,
      remindedAt,
      templateName: "pepita_reminder",
      usedTemplate: true,
      serviceWindowUntil: null
    });
    const secondClaim = await repo.claimAndEnqueueReminder({
      taskId: task.id,
      userId: user.id,
      to: user.phoneNumber,
      body: "Recordatorio duplicado",
      dueAt: task.dueAt,
      remindedAt,
      templateName: "pepita_reminder",
      usedTemplate: true,
      serviceWindowUntil: null
    });

    expect(firstClaim).toMatchObject({
      task: { id: task.id, remindedAt },
      outgoingMessage: { body: "Recordatorio: Llamar al gestor", templateName: "pepita_reminder" },
      auditLog: {
        action: "reminder.enqueued",
        payload: {
          taskId: task.id,
          dueAt: task.dueAt,
          remindedAt,
          templateName: "pepita_reminder",
          usedTemplate: true,
          serviceWindowUntil: null
        }
      }
    });
    expect(secondClaim).toBeNull();
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
    expect(await repo.listAuditLogs(user.id)).toHaveLength(1);
  });

  it("does not reject concurrent reminder claims on the same repository", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const task = await repo.addTask({
      userId: user.id,
      title: "Llamar al gestor",
      dueAt: "2030-01-01T09:00:00.000Z",
      sourceMessageId: "m1"
    });
    const remindedAt = "2030-01-01T09:00:00.000Z";

    const results = await Promise.allSettled([
      repo.claimAndEnqueueReminder({
        taskId: task.id,
        userId: user.id,
        to: user.phoneNumber,
        body: "Recordatorio: Llamar al gestor",
        dueAt: task.dueAt,
        remindedAt,
        templateName: "pepita_reminder",
        usedTemplate: true,
        serviceWindowUntil: null
      }),
      repo.claimAndEnqueueReminder({
        taskId: task.id,
        userId: user.id,
        to: user.phoneNumber,
        body: "Recordatorio duplicado",
        dueAt: task.dueAt,
        remindedAt,
        templateName: "pepita_reminder",
        usedTemplate: true,
        serviceWindowUntil: null
      })
    ]);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    const claims = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
    expect(await repo.listAuditLogs(user.id)).toHaveLength(1);
  });

  it("throws when updating a stale outgoing message id", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const message = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Recordatorio",
      templateName: null,
      scheduledFor: null
    });

    await expect(repo.updateOutgoingMessage({ ...message, id: "out_stale" })).rejects.toThrow(
      "Outgoing message not found: out_stale"
    );
  });

  it("rejects invalid approval JSON payloads with a clear error", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    await expect(
      repo.addApproval({
        userId: user.id,
        type: "email_draft",
        title: "Correo al gestor",
        payload: { count: 1n } as never
      })
    ).rejects.toThrow("Invalid JSON payload");
  });

  it("rejects invalid audit JSON payloads with a clear error", async () => {
    const repo = await createRepo();
    const user = await repo.findOrCreateUserByPhone("+34600000001");

    await expect(
      repo.addAuditLog({
        userId: user.id,
        actor: "agent",
        action: "invalid.payload",
        payload: { count: 1n } as never
      })
    ).rejects.toThrow("Invalid JSON payload");
  });
});
