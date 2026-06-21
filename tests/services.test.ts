import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, AgentResult, AgentRuntime } from "../src/agent.js";
import { openDatabase, type Database } from "../src/db.js";
import type { ApprovalStatus, User } from "../src/domain.js";
import { SqliteRepository } from "../src/repository.js";
import {
  ApprovalService,
  ConversationService,
  OutboxService,
  UserDataService
} from "../src/services.js";
import type { WhatsAppSender } from "../src/whatsapp.js";

const dirs: string[] = [];
const databases: Database[] = [];
const defaultNow = new Date("2030-01-01T09:00:00.000Z");
const safeFailureReply = "Ahora mismo no he podido procesar esto. Lo he dejado registrado para revisarlo.";

afterEach(async () => {
  vi.restoreAllMocks();

  for (const db of databases.splice(0)) {
    db.close();
  }

  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ConversationService", () => {
  it("resolves inbound text to an existing user by phone number", async () => {
    const { repo } = await createRepoContext();
    const existing = await repo.findOrCreateUserByPhone("+34600000001");
    const agent = new FixedAgentRuntime(agentResult({ reply: "Hola" }));
    const service = new ConversationService(repo, agent);

    const handled = await service.handleInboundMessage(inbound({ text: "Hola Pepita" }));

    expect(handled.user.id).toBe(existing.id);
    expect(handled.user.phoneNumber).toBe("+34600000001");
    expect(agent.contexts).toMatchObject([
      {
        userId: existing.id,
        phoneNumber: "+34600000001",
        text: "Hola Pepita",
        messageId: "wamid.1"
      }
    ]);
  });

  it("creates memory facts from agent memory effects", async () => {
    const { repo, service } = await createConversationContext(
      agentResult({
        memoryFacts: [{ text: "Prefiere llamadas por la tarde", confidence: 0.9 }]
      })
    );

    const { user } = await service.handleInboundMessage(inbound());
    const memoryFacts = await repo.listMemoryFacts(user.id);

    expect(memoryFacts).toMatchObject([
      {
        userId: user.id,
        text: "Prefiere llamadas por la tarde",
        sourceMessageId: "wamid.1",
        confidence: 0.9
      }
    ]);
  });

  it("creates tasks from agent task effects", async () => {
    const { repo, service } = await createConversationContext(
      agentResult({
        tasks: [{ title: "Llamar al gestor", dueAt: "2030-01-02T09:00:00.000Z" }]
      })
    );

    const { user } = await service.handleInboundMessage(inbound());
    const tasks = await repo.listTasks(user.id);

    expect(tasks).toMatchObject([
      {
        userId: user.id,
        title: "Llamar al gestor",
        dueAt: "2030-01-02T09:00:00.000Z",
        sourceMessageId: "wamid.1",
        status: "open"
      }
    ]);
  });

  it("creates approvals from agent approval effects", async () => {
    const { repo, service } = await createConversationContext(
      agentResult({
        approvals: [
          {
            type: "email_draft",
            title: "Correo al gestor",
            payload: { body: "Hola" }
          }
        ]
      })
    );

    const { user } = await service.handleInboundMessage(inbound());
    const approvals = await repo.listApprovals(user.id);

    expect(approvals).toMatchObject([
      {
        userId: user.id,
        type: "email_draft",
        title: "Correo al gestor",
        payload: { body: "Hola", sourceMessageId: "wamid.1" },
        status: "pending"
      }
    ]);
  });

  it("enqueues one WhatsApp reply", async () => {
    const { repo, service } = await createConversationContext(agentResult({ reply: "Hecho" }));

    const { user } = await service.handleInboundMessage(inbound());
    const outgoingMessages = await repo.listOutgoingMessages(user.id);

    expect(outgoingMessages).toHaveLength(1);
    expect(outgoingMessages).toMatchObject([
      {
        userId: user.id,
        channel: "whatsapp",
        to: "+34600000001",
        body: "Hecho",
        templateName: null,
        scheduledFor: null,
        status: "queued"
      }
    ]);
  });

  it("writes only to the resolved user and does not leak across users", async () => {
    const { repo } = await createRepoContext();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    const service = new ConversationService(
      repo,
      new FixedAgentRuntime(
        agentResult({
          reply: "Hecho",
          memoryFacts: [{ text: "Prefiere email", confidence: 0.8 }],
          tasks: [{ title: "Enviar factura", dueAt: null }],
          approvals: [{ type: "browser_action", title: "Abrir web", payload: { url: "https://example.com" } }]
        })
      )
    );

    await service.handleInboundMessage(inbound({ from: maria.phoneNumber }));

    expect((await repo.listMemoryFacts(maria.id)).map((item) => item.userId)).toEqual([maria.id]);
    expect((await repo.listTasks(maria.id)).map((item) => item.userId)).toEqual([maria.id]);
    expect((await repo.listApprovals(maria.id)).map((item) => item.userId)).toEqual([maria.id]);
    expect((await repo.listOutgoingMessages(maria.id)).map((item) => item.userId)).toEqual([maria.id]);
    expect(await repo.listMemoryFacts(ana.id)).toHaveLength(0);
    expect(await repo.listTasks(ana.id)).toHaveLength(0);
    expect(await repo.listApprovals(ana.id)).toHaveLength(0);
    expect(await repo.listOutgoingMessages(ana.id)).toHaveLength(0);
    expect(await repo.listAuditLogs(ana.id)).toHaveLength(0);
  });

  it("writes audit logs for memory, task, approval, and outgoing reply", async () => {
    const { repo, service } = await createConversationContext(
      agentResult({
        reply: "Hecho",
        memoryFacts: [{ text: "Prefiere email", confidence: 0.8 }],
        tasks: [{ title: "Enviar factura", dueAt: null }],
        approvals: [{ type: "email_draft", title: "Correo", payload: { body: "Hola" } }]
      })
    );

    const { user } = await service.handleInboundMessage(inbound());
    const memoryFact = (await repo.listMemoryFacts(user.id))[0];
    const task = (await repo.listTasks(user.id))[0];
    const approval = (await repo.listApprovals(user.id))[0];
    const outgoingMessage = (await repo.listOutgoingMessages(user.id))[0];
    const auditLogs = await repo.listAuditLogs(user.id);

    expect(auditLogs.map((log) => log.action)).toEqual([
      "memory.created",
      "task.created",
      "approval.created",
      "outgoing_reply.enqueued"
    ]);
    expect(auditLogs).toMatchObject([
      {
        userId: user.id,
        actor: "agent",
        payload: { memoryFactId: memoryFact.id, sourceMessageId: "wamid.1" }
      },
      { userId: user.id, actor: "agent", payload: { taskId: task.id, sourceMessageId: "wamid.1" } },
      { userId: user.id, actor: "agent", payload: { approvalId: approval.id, sourceMessageId: "wamid.1" } },
      {
        userId: user.id,
        actor: "system",
        payload: { outgoingMessageId: outgoingMessage.id, sourceMessageId: "wamid.1" }
      }
    ]);
  });

  it("updates lastSeenAt and serviceWindowUntil through updateUserActivity", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const updateUserActivity = vi.spyOn(repo, "updateUserActivity");
    const service = new ConversationService(repo, new FixedAgentRuntime(agentResult()));
    const serviceWindowUntil = "2030-01-02T09:00:00.000Z";

    const handled = await service.handleInboundMessage(inbound({ now: defaultNow }));

    expect(updateUserActivity).toHaveBeenCalledWith(user.id, defaultNow.toISOString(), serviceWindowUntil);
    expect(handled.user).toMatchObject({
      id: user.id,
      lastSeenAt: defaultNow.toISOString(),
      serviceWindowUntil
    });
    await expect(repo.getUser(user.id)).resolves.toMatchObject({
      lastSeenAt: defaultNow.toISOString(),
      serviceWindowUntil
    });
  });

  it("derives serviceWindowUntil from a delayed WhatsApp epoch timestamp", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const updateUserActivity = vi.spyOn(repo, "updateUserActivity");
    const service = new ConversationService(repo, new FixedAgentRuntime(agentResult()));
    const delayedTimestamp = "1710000000";
    const expectedServiceWindowUntil = "2024-03-10T16:00:00.000Z";

    const handled = await service.handleInboundMessage(inbound({ timestamp: delayedTimestamp, now: defaultNow }));

    expect(updateUserActivity).toHaveBeenCalledWith(
      user.id,
      defaultNow.toISOString(),
      expectedServiceWindowUntil
    );
    expect(handled.user).toMatchObject({
      id: user.id,
      lastSeenAt: defaultNow.toISOString(),
      serviceWindowUntil: expectedServiceWindowUntil
    });
  });

  it("derives serviceWindowUntil from an inbound ISO timestamp", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const updateUserActivity = vi.spyOn(repo, "updateUserActivity");
    const service = new ConversationService(repo, new FixedAgentRuntime(agentResult()));
    const inboundTimestamp = "2024-03-09T16:30:00.000Z";
    const expectedServiceWindowUntil = "2024-03-10T16:30:00.000Z";

    const handled = await service.handleInboundMessage(inbound({ timestamp: inboundTimestamp, now: defaultNow }));

    expect(updateUserActivity).toHaveBeenCalledWith(
      user.id,
      defaultNow.toISOString(),
      expectedServiceWindowUntil
    );
    expect(handled.user).toMatchObject({
      id: user.id,
      lastSeenAt: defaultNow.toISOString(),
      serviceWindowUntil: expectedServiceWindowUntil
    });
  });

  it("falls back to now for invalid inbound timestamps", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const updateUserActivity = vi.spyOn(repo, "updateUserActivity");
    const service = new ConversationService(repo, new FixedAgentRuntime(agentResult()));
    const expectedServiceWindowUntil = "2030-01-02T09:00:00.000Z";

    const handled = await service.handleInboundMessage(inbound({ timestamp: "not-a-date", now: defaultNow }));

    expect(updateUserActivity).toHaveBeenCalledWith(
      user.id,
      defaultNow.toISOString(),
      expectedServiceWindowUntil
    );
    expect(handled.user).toMatchObject({
      id: user.id,
      lastSeenAt: defaultNow.toISOString(),
      serviceWindowUntil: expectedServiceWindowUntil
    });
  });

  it("enqueues a safe failure reply and audits agent errors without throwing raw errors", async () => {
    const { repo } = await createRepoContext();
    const service = new ConversationService(repo, new FixedAgentRuntime(new Error("provider exploded")));

    const handled = await service.handleInboundMessage(inbound());
    const outgoingMessages = await repo.listOutgoingMessages(handled.user.id);
    const auditLogs = await repo.listAuditLogs(handled.user.id);

    expect(handled.result).toMatchObject({ reply: safeFailureReply });
    expect(outgoingMessages).toMatchObject([{ body: safeFailureReply, status: "queued" }]);
    expect(auditLogs).toMatchObject([
      {
        actor: "agent",
        action: "conversation.error",
        payload: { sourceMessageId: "wamid.1", error: "provider exploded" }
      },
      {
        actor: "system",
        action: "outgoing_reply.enqueued",
        payload: { sourceMessageId: "wamid.1" }
      }
    ]);
  });

  it("does not persist partial effects when an agent result is malformed", async () => {
    const { repo, service } = await createConversationContext(
      agentResult({
        memoryFacts: [{ text: "Prefiere email", confidence: 0.8 }],
        tasks: [{ title: "Enviar factura", dueAt: null }],
        approvals: [
          {
            type: "email_draft",
            title: "Correo",
            payload: { body: "Hola", invalid: 1n } as never
          }
        ]
      })
    );

    const handled = await service.handleInboundMessage(inbound());
    const auditLogs = await repo.listAuditLogs(handled.user.id);

    expect(handled.result).toMatchObject({ reply: safeFailureReply });
    expect(await repo.listMemoryFacts(handled.user.id)).toHaveLength(0);
    expect(await repo.listTasks(handled.user.id)).toHaveLength(0);
    expect(await repo.listApprovals(handled.user.id)).toHaveLength(0);
    expect(await repo.listOutgoingMessages(handled.user.id)).toMatchObject([
      { body: safeFailureReply, status: "queued" }
    ]);
    expect(auditLogs.map((log) => log.action)).toEqual(["conversation.error", "outgoing_reply.enqueued"]);
    expect(auditLogs).toMatchObject([
      { actor: "agent", payload: { sourceMessageId: "wamid.1" } },
      { actor: "system", payload: { sourceMessageId: "wamid.1" } }
    ]);
  });

  it("sanitizes provider errors before writing audit logs", async () => {
    const { repo } = await createRepoContext();
    const openAiSecret = ["sk", "proj", "openaiSecret1234567890"].join("-");
    const whatsAppSecret = ["EAA", "G", "whatsappSecret1234567890"].join("");
    const rawError = [
      "provider exploded",
      `Bearer ${openAiSecret}`,
      `WHATSAPP_TOKEN=${whatsAppSecret}`,
      "x".repeat(500)
    ].join(" ");
    const service = new ConversationService(repo, new FixedAgentRuntime(new Error(rawError)));

    const handled = await service.handleInboundMessage(inbound());
    const auditLogs = await repo.listAuditLogs(handled.user.id);
    const auditError = auditLogs.find((log) => log.action === "conversation.error")?.payload.error;

    expect(auditError).toEqual(expect.any(String));
    expect(auditError).not.toContain(openAiSecret);
    expect(auditError).not.toContain(whatsAppSecret);
    expect(String(auditError).length).toBeLessThanOrEqual(300);
  });
});

describe("UserDataService", () => {
  it("exports one user's data only", async () => {
    const { repo } = await createRepoContext();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    await seedAllUserData(repo, maria, "maria");
    await seedAllUserData(repo, ana, "ana");
    const service = new UserDataService(repo);

    const exported = await service.exportUserData(maria.id);

    expect(exported.user?.id).toBe(maria.id);
    expect(exported.memoryFacts).toMatchObject([{ userId: maria.id, text: "maria memory" }]);
    expect(exported.tasks).toMatchObject([{ userId: maria.id, title: "maria task" }]);
    expect(exported.approvals).toMatchObject([{ userId: maria.id, title: "maria approval" }]);
    expect(exported.outgoingMessages).toMatchObject([{ userId: maria.id, body: "maria outgoing" }]);
    expect(exported.auditLogs).toMatchObject([{ userId: maria.id, action: "maria.created" }]);
  });

  it("deletes one user's data and leaves another user's data intact", async () => {
    const { repo } = await createRepoContext();
    const maria = await repo.findOrCreateUserByPhone("+34600000001");
    const ana = await repo.findOrCreateUserByPhone("+34600000002");
    await seedAllUserData(repo, maria, "maria");
    await seedAllUserData(repo, ana, "ana");
    const service = new UserDataService(repo);

    await service.deleteUserData(maria.id);
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
});

describe("OutboxService", () => {
  it("sends due queued messages through WhatsAppSender", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Due now",
      templateName: null,
      scheduledFor: defaultNow.toISOString()
    });
    await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Future",
      templateName: null,
      scheduledFor: "2030-01-01T09:05:00.000Z"
    });
    const sender = new RecordingSender();
    const service = new OutboxService(repo, sender);

    await service.flushQueued(defaultNow);

    expect(sender.attempts).toEqual([{ to: user.phoneNumber, text: "Due now" }]);
  });

  it("marks sent messages with sentAt", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const message = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Due now",
      templateName: null,
      scheduledFor: null
    });
    const service = new OutboxService(repo, new RecordingSender());

    await service.flushQueued(defaultNow);
    const sent = (await repo.listOutgoingMessages(user.id)).find((item) => item.id === message.id);

    expect(sent).toMatchObject({
      status: "sent",
      sentAt: defaultNow.toISOString(),
      error: null
    });
  });

  it("marks failed messages with error and keeps flushing remaining messages", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const failing = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Fail me",
      templateName: null,
      scheduledFor: null
    });
    const succeeding = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Send me",
      templateName: null,
      scheduledFor: null
    });
    const sender = new RecordingSender(new Map([["Fail me", new Error("network down")]]));
    const service = new OutboxService(repo, sender);

    await service.flushQueued(defaultNow);
    const messages = await repo.listOutgoingMessages(user.id);

    expect(sender.attempts).toEqual([
      { to: user.phoneNumber, text: "Fail me" },
      { to: user.phoneNumber, text: "Send me" }
    ]);
    expect(messages.find((item) => item.id === failing.id)).toMatchObject({
      status: "failed",
      sentAt: null,
      error: "network down"
    });
    expect(messages.find((item) => item.id === succeeding.id)).toMatchObject({
      status: "sent",
      sentAt: defaultNow.toISOString(),
      error: null
    });
  });

  it("does not mark a message failed when sending succeeds but marking sent fails", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const message = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Due now",
      templateName: null,
      scheduledFor: null
    });
    const updateOutgoingMessage = vi
      .spyOn(repo, "updateOutgoingMessage")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const sender = new RecordingSender();
    const service = new OutboxService(repo, sender);

    await expect(service.flushQueued(defaultNow)).rejects.toThrow("database unavailable");
    const stored = (await repo.listOutgoingMessages(user.id)).find((item) => item.id === message.id);

    expect(sender.attempts).toEqual([{ to: user.phoneNumber, text: "Due now" }]);
    expect(updateOutgoingMessage).toHaveBeenCalledTimes(1);
    expect(updateOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: message.id, status: "sent", sentAt: defaultNow.toISOString(), error: null })
    );
    expect(stored).toMatchObject({ status: "queued", sentAt: null, error: null });
  });

  it("sanitizes sender errors before writing outgoing error fields", async () => {
    const { repo } = await createRepoContext();
    const user = await repo.findOrCreateUserByPhone("+34600000001");
    const message = await repo.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body: "Fail me",
      templateName: null,
      scheduledFor: null
    });
    const openAiSecret = ["sk", "proj", "openaiSecret1234567890"].join("-");
    const whatsAppSecret = ["EAA", "G", "whatsappSecret1234567890"].join("");
    const sender = new RecordingSender(
      new Map([
        [
          "Fail me",
          new Error(`network down Bearer ${openAiSecret} whatsapp_token=${whatsAppSecret} ${"x".repeat(500)}`)
        ]
      ])
    );
    const service = new OutboxService(repo, sender);

    await service.flushQueued(defaultNow);
    const failed = (await repo.listOutgoingMessages(user.id)).find((item) => item.id === message.id);

    expect(failed?.error).toEqual(expect.any(String));
    expect(failed?.error).not.toContain(openAiSecret);
    expect(failed?.error).not.toContain(whatsAppSecret);
    expect(failed?.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("ApprovalService", () => {
  it.each<ApprovalStatus>(["approved", "rejected"])(
    "resolves an approval as %s by userId and id and audits the resolution",
    async (status) => {
      const { repo } = await createRepoContext();
      const user = await repo.findOrCreateUserByPhone("+34600000001");
      const approval = await repo.addApproval({
        userId: user.id,
        type: "email_draft",
        title: "Correo al gestor",
        payload: { body: "Hola" }
      });
      const service = new ApprovalService(repo);

      const resolved = await service.resolve(user.id, approval.id, status);
      const auditLogs = await repo.listAuditLogs(user.id);

      expect(resolved).toMatchObject({
        id: approval.id,
        userId: user.id,
        status
      });
      expect(auditLogs).toMatchObject([
        {
          userId: user.id,
          actor: "user",
          action: "approval.resolved",
          payload: { approvalId: approval.id, status }
        }
      ]);
    }
  );
});

async function createRepoContext() {
  const dir = await mkdtemp(join(tmpdir(), "pepita-services-"));
  dirs.push(dir);

  const db = openDatabase(join(dir, "pepita.sqlite"));
  databases.push(db);

  const repo = new SqliteRepository(db);
  await repo.migrate();

  return { repo };
}

async function createConversationContext(result: AgentResult) {
  const { repo } = await createRepoContext();
  const agent = new FixedAgentRuntime(result);
  const service = new ConversationService(repo, agent);

  return { repo, agent, service };
}

function inbound(overrides: Partial<Parameters<ConversationService["handleInboundMessage"]>[0]> = {}) {
  return {
    from: "+34600000001",
    messageId: "wamid.1",
    text: "Recuerda que prefiere email",
    timestamp: "1893488400",
    now: defaultNow,
    ...overrides
  };
}

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    reply: "Vale",
    memoryFacts: [],
    tasks: [],
    approvals: [],
    ...overrides
  };
}

async function seedAllUserData(repo: SqliteRepository, user: User, label: string) {
  await repo.addMemoryFact({
    userId: user.id,
    text: `${label} memory`,
    sourceMessageId: `${label}-memory-message`,
    confidence: 0.9
  });
  await repo.addTask({
    userId: user.id,
    title: `${label} task`,
    dueAt: "2030-01-01T09:00:00.000Z",
    sourceMessageId: `${label}-task-message`
  });
  await repo.addApproval({
    userId: user.id,
    type: "email_draft",
    title: `${label} approval`,
    payload: { label }
  });
  await repo.enqueueOutgoingMessage({
    userId: user.id,
    to: user.phoneNumber,
    body: `${label} outgoing`,
    templateName: null,
    scheduledFor: null
  });
  await repo.addAuditLog({
    userId: user.id,
    actor: "agent",
    action: `${label}.created`,
    payload: { label }
  });
}

class FixedAgentRuntime implements AgentRuntime {
  readonly contexts: AgentContext[] = [];

  constructor(private readonly result: AgentResult | Error) {}

  async handleMessage(context: AgentContext): Promise<AgentResult> {
    this.contexts.push(context);

    if (this.result instanceof Error) {
      throw this.result;
    }

    return this.result;
  }
}

class RecordingSender implements WhatsAppSender {
  readonly attempts: Array<{ to: string; text: string }> = [];

  constructor(private readonly failuresByText = new Map<string, Error>()) {}

  async sendText(to: string, text: string): Promise<void> {
    this.attempts.push({ to, text });
    const failure = this.failuresByText.get(text);

    if (failure) {
      throw failure;
    }
  }
}
