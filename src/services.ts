import type { AgentResult, AgentRuntime } from "./agent.js";
import type {
  Approval,
  ApprovalStatus,
  AuditLog,
  JsonObject,
  MemoryFact,
  NewAuditLog,
  NewOutgoingMessage,
  OutgoingMessage,
  Task,
  User
} from "./domain.js";
import type { WhatsAppSender } from "./whatsapp.js";

export type InboundMessageInput = {
  from: string;
  messageId: string;
  text: string;
  timestamp: string;
  now?: Date;
};

type UserDataExport = {
  user: User | null;
  memoryFacts: MemoryFact[];
  tasks: Task[];
  approvals: Approval[];
  outgoingMessages: OutgoingMessage[];
  auditLogs: AuditLog[];
};

type ConversationRepository = {
  findOrCreateUserByPhone(phoneNumber: string): Promise<User>;
  updateUserActivity(userId: string, lastSeenAt: string, serviceWindowUntil: string): Promise<User>;
  persistConversationTurn(input: PersistConversationTurnInput): Promise<void>;
  enqueueOutgoingMessage(input: NewOutgoingMessage): Promise<OutgoingMessage>;
  addAuditLog(input: NewAuditLog): Promise<AuditLog>;
};

type PersistConversationTurnInput = {
  userId: string;
  to: string;
  sourceMessageId: string;
  reply: string;
  memoryFacts: Array<{ text: string; confidence: number }>;
  tasks: Array<{ title: string; dueAt: string | null }>;
  approvals: Array<{ type: Approval["type"]; title: string; payload: JsonObject }>;
};

type ApprovalRepository = {
  resolveApproval(userId: string, id: string, status: ApprovalStatus): Promise<Approval>;
  addAuditLog(input: NewAuditLog): Promise<AuditLog>;
};

type OutboxRepository = {
  listQueuedOutgoingMessages(now: string): Promise<OutgoingMessage[]>;
  updateOutgoingMessage(message: OutgoingMessage): Promise<OutgoingMessage>;
};

type UserDataRepository = {
  exportUserData(userId: string): Promise<UserDataExport>;
  deleteUserData(userId: string): Promise<void>;
};

const safeFailureReply = "Ahora mismo no he podido procesar esto. Lo he dejado registrado para revisarlo.";

export type DevLog = (event: string, fields?: Record<string, unknown>) => void;

export class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly agent: AgentRuntime,
    private readonly devLog: DevLog = noopDevLog
  ) {}

  async handleInboundMessage(input: InboundMessageInput): Promise<{ user: User; result: AgentResult }> {
    const now = input.now ?? new Date();
    const lastSeenAt = now.toISOString();
    const inboundAt = parseInboundTimestamp(input.timestamp) ?? now;
    const serviceWindowUntil = plusHours(inboundAt, 24).toISOString();
    const resolvedUser = await this.repository.findOrCreateUserByPhone(input.from);
    const user = await this.repository.updateUserActivity(resolvedUser.id, lastSeenAt, serviceWindowUntil);

    try {
      const result = await this.agent.handleMessage({
        userId: user.id,
        phoneNumber: user.phoneNumber,
        text: input.text,
        messageId: input.messageId,
        now
      });

      assertValidAgentResult(result);
      await this.repository.persistConversationTurn({
        userId: user.id,
        to: user.phoneNumber,
        sourceMessageId: input.messageId,
        reply: result.reply,
        memoryFacts: result.memoryFacts,
        tasks: result.tasks,
        approvals: result.approvals
      });

      return { user, result };
    } catch (error) {
      this.devLog("agent.error", {
        from: user.phoneNumber,
        userId: user.id,
        messageId: input.messageId,
        error: rawErrorMessage(error)
      });

      await this.repository.addAuditLog({
        userId: user.id,
        actor: "agent",
        action: "conversation.error",
        payload: {
          sourceMessageId: input.messageId,
          error: sanitizeError(error)
        }
      });

      const result: AgentResult = {
        reply: safeFailureReply,
        memoryFacts: [],
        tasks: [],
        approvals: []
      };
      await this.enqueueReply(user, input.messageId, result.reply);

      return { user, result };
    }
  }

  private async enqueueReply(user: User, sourceMessageId: string, body: string): Promise<void> {
    const outgoingMessage = await this.repository.enqueueOutgoingMessage({
      userId: user.id,
      to: user.phoneNumber,
      body,
      templateName: null,
      scheduledFor: null
    });
    await this.audit("system", "outgoing_reply.enqueued", user.id, {
      outgoingMessageId: outgoingMessage.id,
      sourceMessageId
    });
  }

  private async audit(
    actor: NewAuditLog["actor"],
    action: string,
    userId: string,
    payload: JsonObject
  ): Promise<void> {
    await this.repository.addAuditLog({ userId, actor, action, payload });
  }
}

export class ApprovalService {
  constructor(private readonly repository: ApprovalRepository) {}

  async resolve(userId: string, approvalId: string, status: ApprovalStatus): Promise<Approval> {
    const approval = await this.repository.resolveApproval(userId, approvalId, status);
    await this.repository.addAuditLog({
      userId,
      actor: "user",
      action: "approval.resolved",
      payload: { approvalId, status }
    });

    return approval;
  }
}

export class OutboxService {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly sender: WhatsAppSender
  ) {}

  async flushQueued(now: Date): Promise<void> {
    const sentAt = now.toISOString();
    const messages = await this.repository.listQueuedOutgoingMessages(sentAt);

    for (const message of messages) {
      try {
        await this.sender.sendText(message.to, message.body);
      } catch (error) {
        await this.repository.updateOutgoingMessage({
          ...message,
          status: "failed",
          sentAt: null,
          error: sanitizeError(error)
        });
        continue;
      }

      await this.repository.updateOutgoingMessage({
        ...message,
        status: "sent",
        sentAt,
        error: null
      });
    }
  }
}

export class UserDataService {
  constructor(private readonly repository: UserDataRepository) {}

  async exportUserData(userId: string): Promise<UserDataExport> {
    return this.repository.exportUserData(userId);
  }

  async deleteUserData(userId: string): Promise<void> {
    await this.repository.deleteUserData(userId);
  }
}

function plusHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function parseInboundTimestamp(timestamp: string): Date | null {
  const trimmed = timestamp.trim();
  const parsed = /^\d+$/.test(trimmed) ? new Date(Number(trimmed) * 1000) : new Date(trimmed);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:openai|whatsapp)[A-Za-z0-9_-]*\s*[:=]\s*[^,\s;]+/gi, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      return `${match.split(separator)[0]}${separator}[REDACTED]`;
    })
    .replace(/\bEAA[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");

  return redacted.length > 300 ? `${redacted.slice(0, 297)}...` : redacted;
}

function assertValidAgentResult(value: unknown): asserts value is AgentResult {
  if (!isPlainObject(value)) throw new Error("Invalid agent result: expected object");
  if (typeof value.reply !== "string") throw new Error("Invalid agent result: reply must be a string");

  assertArray(value.memoryFacts, "memoryFacts");
  assertArray(value.tasks, "tasks");
  assertArray(value.approvals, "approvals");

  value.memoryFacts.forEach((memoryFact, index) => {
    if (!isPlainObject(memoryFact)) throw new Error(`Invalid agent result: memoryFacts[${index}] must be an object`);
    if (typeof memoryFact.text !== "string") {
      throw new Error(`Invalid agent result: memoryFacts[${index}].text must be a string`);
    }
    if (typeof memoryFact.confidence !== "number" || !Number.isFinite(memoryFact.confidence)) {
      throw new Error(`Invalid agent result: memoryFacts[${index}].confidence must be a finite number`);
    }
  });

  value.tasks.forEach((task, index) => {
    if (!isPlainObject(task)) throw new Error(`Invalid agent result: tasks[${index}] must be an object`);
    if (typeof task.title !== "string") {
      throw new Error(`Invalid agent result: tasks[${index}].title must be a string`);
    }
    if (task.dueAt !== null && typeof task.dueAt !== "string") {
      throw new Error(`Invalid agent result: tasks[${index}].dueAt must be a string or null`);
    }
  });

  value.approvals.forEach((approval, index) => {
    if (!isPlainObject(approval)) throw new Error(`Invalid agent result: approvals[${index}] must be an object`);
    if (approval.type !== "email_draft" && approval.type !== "browser_action") {
      throw new Error(`Invalid agent result: approvals[${index}].type is unsupported`);
    }
    if (typeof approval.title !== "string") {
      throw new Error(`Invalid agent result: approvals[${index}].title must be a string`);
    }
    assertJsonObject(approval.payload, `approvals[${index}].payload`);
  });
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid agent result: ${path} must be an array`);
}

function assertJsonObject(value: unknown, path: string): asserts value is JsonObject {
  if (!isPlainObject(value)) throw new Error(`Invalid agent result: ${path} must be an object`);

  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, `${path}.${key}`);
  }
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;

  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${path}[${index}]`));
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }

  throw new Error(`Invalid agent result: ${path} is not JSON serializable`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function noopDevLog(): void {}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
