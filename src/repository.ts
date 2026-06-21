import type {
  Approval,
  ApprovalStatus,
  AuditLog,
  JsonObject,
  JsonValue,
  MemoryFact,
  NewApproval,
  NewAuditLog,
  NewMemoryFact,
  NewOutgoingMessage,
  NewTask,
  OutgoingMessage,
  Task,
  User
} from "./domain.js";
import { createId, nowIso } from "./domain.js";
import type { Database } from "./db.js";
import type { SQLInputValue } from "node:sqlite";

type UserRow = {
  id: string;
  phone_number: string;
  display_name: string | null;
  locale: string | null;
  timezone: string | null;
  created_at: string;
  last_seen_at: string | null;
  service_window_until: string | null;
};

type MemoryFactRow = {
  id: string;
  user_id: string;
  text: string;
  source_message_id: string | null;
  confidence: number;
  created_at: string;
};

type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  status: Task["status"];
  due_at: string | null;
  reminded_at: string | null;
  source_message_id: string | null;
  created_at: string;
};

type ApprovalRow = {
  id: string;
  user_id: string;
  type: Approval["type"];
  title: string;
  payload: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
};

type OutgoingMessageRow = {
  id: string;
  user_id: string;
  channel: string;
  to_value: string;
  body: string;
  template_name: string | null;
  status: OutgoingMessage["status"];
  scheduled_for: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
};

type AuditLogRow = {
  id: string;
  user_id: string;
  actor: string;
  action: string;
  payload: string;
  created_at: string;
};

export type PersistConversationTurnInput = {
  userId: string;
  to: string;
  sourceMessageId: string;
  reply: string;
  memoryFacts: Array<{ text: string; confidence: number }>;
  tasks: Array<{ title: string; dueAt: string | null }>;
  approvals: Array<{ type: Approval["type"]; title: string; payload: JsonObject }>;
};

export type ClaimAndEnqueueReminderInput = {
  taskId: string;
  userId: string;
  to: string;
  body: string;
  dueAt: string | null;
  remindedAt: string;
  templateName: string | null;
  usedTemplate: boolean;
  serviceWindowUntil: string | null;
};

export type ClaimAndEnqueueReminderResult = {
  task: Task;
  outgoingMessage: OutgoingMessage;
  auditLog: AuditLog;
};

export class SqliteRepository {
  constructor(private readonly db: Database) {}

  async migrate(): Promise<void> {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        display_name TEXT,
        locale TEXT,
        timezone TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        service_window_until TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique
        ON users (phone_number);

      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        source_message_id TEXT,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'done')),
        due_at TEXT,
        reminded_at TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('email_draft', 'browser_action')),
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS outgoing_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
        "to" TEXT NOT NULL,
        body TEXT NOT NULL,
        template_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
        scheduled_for TEXT,
        sent_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      PRAGMA user_version = 2;
    `);
  }

  async findOrCreateUserByPhone(phoneNumber: string): Promise<User> {
    const existing = this.getUserByPhone(phoneNumber);
    if (existing) return existing;

    const createdAt = nowIso();
    const user: User = {
      id: createId("user"),
      phoneNumber,
      displayName: null,
      locale: "es-ES",
      timezone: "Europe/Madrid",
      createdAt,
      lastSeenAt: createdAt,
      serviceWindowUntil: null
    };

    this.db
      .prepare(
        `INSERT INTO users (
          id, phone_number, display_name, locale, timezone,
          created_at, last_seen_at, service_window_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO NOTHING`
      )
      .run(
        user.id,
        user.phoneNumber,
        user.displayName,
        user.locale,
        user.timezone,
        user.createdAt,
        user.lastSeenAt,
        user.serviceWindowUntil
      );

    const saved = this.getUserByPhone(phoneNumber);
    if (!saved) throw new Error(`User not found after create: ${phoneNumber}`);

    return saved;
  }

  async claimInboundMessage(messageId: string): Promise<boolean> {
    const trimmedMessageId = messageId.trim();
    if (trimmedMessageId.length === 0) throw new Error("Inbound message id is required");

    const result = this.db
      .prepare("INSERT OR IGNORE INTO inbound_messages (message_id, created_at) VALUES (?, ?)")
      .run(trimmedMessageId, nowIso());

    return Number(result.changes) === 1;
  }

  async getUser(userId: string): Promise<User | null> {
    return this.getUserById(userId);
  }

  async updateUserActivity(userId: string, lastSeenAt: string, serviceWindowUntil: string): Promise<User> {
    const result = this.db
      .prepare("UPDATE users SET last_seen_at = ?, service_window_until = ? WHERE id = ?")
      .run(lastSeenAt, serviceWindowUntil, userId);

    if (Number(result.changes) !== 1) throw new Error(`User not found: ${userId}`);

    const updated = this.getUserById(userId);
    if (!updated) throw new Error(`User not found: ${userId}`);

    return updated;
  }

  async listUsers(): Promise<User[]> {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[];
    return rows.map(mapUser);
  }

  async addMemoryFact(input: NewMemoryFact): Promise<MemoryFact> {
    const memoryFact: MemoryFact = {
      id: createId("mem"),
      userId: input.userId,
      text: input.text,
      sourceMessageId: input.sourceMessageId,
      confidence: input.confidence,
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `INSERT INTO memory_facts (
          id, user_id, text, source_message_id, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        memoryFact.id,
        memoryFact.userId,
        memoryFact.text,
        memoryFact.sourceMessageId,
        memoryFact.confidence,
        memoryFact.createdAt
      );

    return memoryFact;
  }

  async listMemoryFacts(userId: string): Promise<MemoryFact[]> {
    const rows = this.db
      .prepare("SELECT * FROM memory_facts WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as MemoryFactRow[];
    return rows.map(mapMemoryFact);
  }

  async addTask(input: NewTask): Promise<Task> {
    const task: Task = {
      id: createId("task"),
      userId: input.userId,
      title: input.title,
      status: "open",
      dueAt: input.dueAt,
      remindedAt: null,
      sourceMessageId: input.sourceMessageId,
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, user_id, title, status, due_at, reminded_at, source_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.userId,
        task.title,
        task.status,
        task.dueAt,
        task.remindedAt,
        task.sourceMessageId,
        task.createdAt
      );

    return task;
  }

  async listTasks(userId: string): Promise<Task[]> {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as TaskRow[];
    return rows.map(mapTask);
  }

  async updateTask(task: Task): Promise<Task> {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET title = ?, status = ?, due_at = ?, reminded_at = ?, source_message_id = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        task.title,
        task.status,
        task.dueAt,
        task.remindedAt,
        task.sourceMessageId,
        task.id,
        task.userId
      );

    if (Number(result.changes) !== 1) throw new Error(`Task not found: ${task.id}`);

    return task;
  }

  async claimAndEnqueueReminder(input: ClaimAndEnqueueReminderInput): Promise<ClaimAndEnqueueReminderResult | null> {
    this.db.exec("BEGIN");

    try {
      const result = this.db
        .prepare(
          `UPDATE tasks
           SET reminded_at = ?
           WHERE id = ? AND user_id = ? AND status = 'open' AND due_at = ? AND reminded_at IS NULL`
        )
        .run(input.remindedAt, input.taskId, input.userId, input.dueAt);

      if (Number(result.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }

      const row = this.db
        .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
        .get(input.taskId, input.userId) as TaskRow | undefined;
      if (!row) throw new Error(`Task not found: ${input.taskId}`);

      const task = mapTask(row);
      const outgoingMessage: OutgoingMessage = {
        id: createId("out"),
        userId: input.userId,
        channel: "whatsapp",
        to: input.to,
        body: input.body,
        templateName: input.templateName,
        status: "queued",
        scheduledFor: null,
        sentAt: null,
        error: null,
        createdAt: nowIso()
      };
      this.db
        .prepare(
          `INSERT INTO outgoing_messages (
            id, user_id, channel, "to", body, template_name,
            status, scheduled_for, sent_at, error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          outgoingMessage.id,
          outgoingMessage.userId,
          outgoingMessage.channel,
          outgoingMessage.to,
          outgoingMessage.body,
          outgoingMessage.templateName,
          outgoingMessage.status,
          outgoingMessage.scheduledFor,
          outgoingMessage.sentAt,
          outgoingMessage.error,
          outgoingMessage.createdAt
        );

      const auditLog: AuditLog = {
        id: createId("audit"),
        userId: input.userId,
        actor: "system",
        action: "reminder.enqueued",
        payload: {
          taskId: input.taskId,
          outgoingMessageId: outgoingMessage.id,
          dueAt: input.dueAt,
          remindedAt: input.remindedAt,
          templateName: input.templateName,
          usedTemplate: input.usedTemplate,
          serviceWindowUntil: input.serviceWindowUntil
        },
        createdAt: nowIso()
      };
      this.db
        .prepare(
          `INSERT INTO audit_logs (
            id, user_id, actor, action, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          auditLog.id,
          auditLog.userId,
          auditLog.actor,
          auditLog.action,
          safeJsonStringify(auditLog.payload, "audit log payload"),
          auditLog.createdAt
        );

      this.db.exec("COMMIT");
      return { task, outgoingMessage, auditLog };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async addApproval(input: NewApproval): Promise<Approval> {
    const approval: Approval = {
      id: createId("approval"),
      userId: input.userId,
      type: input.type,
      title: input.title,
      payload: input.payload,
      status: "pending",
      createdAt: nowIso(),
      resolvedAt: null
    };

    this.db
      .prepare(
        `INSERT INTO approvals (
          id, user_id, type, title, payload, status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        approval.id,
        approval.userId,
        approval.type,
        approval.title,
        safeJsonStringify(approval.payload, "approval payload"),
        approval.status,
        approval.createdAt,
        approval.resolvedAt
      );

    return approval;
  }

  async listApprovals(userId: string): Promise<Approval[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  async resolveApproval(userId: string, id: string, status: ApprovalStatus): Promise<Approval> {
    const resolvedAt = nowIso();
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ?")
      .run(status, resolvedAt, id, userId);

    if (Number(result.changes) !== 1) throw new Error(`Approval not found: ${id}`);

    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ? AND user_id = ?")
      .get(id, userId) as ApprovalRow | undefined;
    if (!row) throw new Error(`Approval not found: ${id}`);

    return mapApproval(row);
  }

  async enqueueOutgoingMessage(input: NewOutgoingMessage): Promise<OutgoingMessage> {
    const outgoingMessage: OutgoingMessage = {
      id: createId("out"),
      userId: input.userId,
      channel: input.channel ?? "whatsapp",
      to: input.to,
      body: input.body,
      templateName: input.templateName,
      status: "queued",
      scheduledFor: input.scheduledFor,
      sentAt: null,
      error: null,
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `INSERT INTO outgoing_messages (
          id, user_id, channel, "to", body, template_name,
          status, scheduled_for, sent_at, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        outgoingMessage.id,
        outgoingMessage.userId,
        outgoingMessage.channel,
        outgoingMessage.to,
        outgoingMessage.body,
        outgoingMessage.templateName,
        outgoingMessage.status,
        outgoingMessage.scheduledFor,
        outgoingMessage.sentAt,
        outgoingMessage.error,
        outgoingMessage.createdAt
      );

    return outgoingMessage;
  }

  async listOutgoingMessages(userId: string): Promise<OutgoingMessage[]> {
    const rows = this.selectOutgoingMessages("WHERE user_id = ? ORDER BY created_at, rowid", [userId]);
    return rows.map(mapOutgoingMessage);
  }

  async listQueuedOutgoingMessages(now: string): Promise<OutgoingMessage[]> {
    const rows = this.selectOutgoingMessages(
      `WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= ?)
       ORDER BY scheduled_for IS NULL, scheduled_for, created_at, rowid`,
      [now]
    );
    return rows.map(mapOutgoingMessage);
  }

  async updateOutgoingMessage(message: OutgoingMessage): Promise<OutgoingMessage> {
    const result = this.db
      .prepare(
        `UPDATE outgoing_messages
         SET channel = ?, "to" = ?, body = ?, template_name = ?, status = ?,
             scheduled_for = ?, sent_at = ?, error = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        message.channel,
        message.to,
        message.body,
        message.templateName,
        message.status,
        message.scheduledFor,
        message.sentAt,
        message.error,
        message.id,
        message.userId
      );

    if (Number(result.changes) !== 1) throw new Error(`Outgoing message not found: ${message.id}`);

    return message;
  }

  async addAuditLog(input: NewAuditLog): Promise<AuditLog> {
    const auditLog: AuditLog = {
      id: createId("audit"),
      userId: input.userId,
      actor: input.actor,
      action: input.action,
      payload: input.payload,
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, user_id, actor, action, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        auditLog.id,
        auditLog.userId,
        auditLog.actor,
        auditLog.action,
        safeJsonStringify(auditLog.payload, "audit log payload"),
        auditLog.createdAt
      );

    return auditLog;
  }

  async persistConversationTurn(input: PersistConversationTurnInput): Promise<void> {
    this.db.exec("BEGIN");

    try {
      for (const memoryFact of input.memoryFacts) {
        const created = await this.addMemoryFact({
          userId: input.userId,
          text: memoryFact.text,
          sourceMessageId: input.sourceMessageId,
          confidence: memoryFact.confidence
        });
        await this.addAuditLog({
          userId: input.userId,
          actor: "agent",
          action: "memory.created",
          payload: { memoryFactId: created.id, sourceMessageId: input.sourceMessageId }
        });
      }

      for (const task of input.tasks) {
        const created = await this.addTask({
          userId: input.userId,
          title: task.title,
          dueAt: task.dueAt,
          sourceMessageId: input.sourceMessageId
        });
        await this.addAuditLog({
          userId: input.userId,
          actor: "agent",
          action: "task.created",
          payload: { taskId: created.id, sourceMessageId: input.sourceMessageId }
        });
      }

      for (const approval of input.approvals) {
        const created = await this.addApproval({
          userId: input.userId,
          type: approval.type,
          title: approval.title,
          payload: {
            ...approval.payload,
            sourceMessageId: input.sourceMessageId
          }
        });
        await this.addAuditLog({
          userId: input.userId,
          actor: "agent",
          action: "approval.created",
          payload: { approvalId: created.id, sourceMessageId: input.sourceMessageId }
        });
      }

      const outgoingMessage = await this.enqueueOutgoingMessage({
        userId: input.userId,
        to: input.to,
        body: input.reply,
        templateName: null,
        scheduledFor: null
      });
      await this.addAuditLog({
        userId: input.userId,
        actor: "system",
        action: "outgoing_reply.enqueued",
        payload: { outgoingMessageId: outgoingMessage.id, sourceMessageId: input.sourceMessageId }
      });

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async listAuditLogs(userId: string): Promise<AuditLog[]> {
    const rows = this.db
      .prepare("SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at, rowid")
      .all(userId) as AuditLogRow[];
    return rows.map(mapAuditLog);
  }

  async exportUserData(userId: string): Promise<{
    user: User | null;
    memoryFacts: MemoryFact[];
    tasks: Task[];
    approvals: Approval[];
    outgoingMessages: OutgoingMessage[];
    auditLogs: AuditLog[];
  }> {
    return {
      user: await this.getUser(userId),
      memoryFacts: await this.listMemoryFacts(userId),
      tasks: await this.listTasks(userId),
      approvals: await this.listApprovals(userId),
      outgoingMessages: await this.listOutgoingMessages(userId),
      auditLogs: await this.listAuditLogs(userId)
    };
  }

  async deleteUserData(userId: string): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM audit_logs WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM outgoing_messages WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM approvals WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM tasks WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM memory_facts WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getUserById(userId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  private getUserByPhone(phoneNumber: string): User | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE phone_number = ?")
      .get(phoneNumber) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  private selectOutgoingMessages(whereClause: string, params: SQLInputValue[]): OutgoingMessageRow[] {
    return this.db
      .prepare(
        `SELECT
          id,
          user_id,
          channel,
          "to" AS to_value,
          body,
          template_name,
          status,
          scheduled_for,
          sent_at,
          error,
          created_at
        FROM outgoing_messages
        ${whereClause}`
      )
      .all(...params) as OutgoingMessageRow[];
  }
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    locale: row.locale,
    timezone: row.timezone,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    serviceWindowUntil: row.service_window_until
  };
}

function mapMemoryFact(row: MemoryFactRow): MemoryFact {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    sourceMessageId: row.source_message_id,
    confidence: row.confidence,
    createdAt: row.created_at
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    dueAt: row.due_at,
    remindedAt: row.reminded_at,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at
  };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    payload: safeJsonParse(row.payload, "approval payload"),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function mapOutgoingMessage(row: OutgoingMessageRow): OutgoingMessage {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    to: row.to_value,
    body: row.body,
    templateName: row.template_name,
    status: row.status,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    error: row.error,
    createdAt: row.created_at
  };
}

function mapAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    userId: row.user_id,
    actor: row.actor,
    action: row.action,
    payload: safeJsonParse(row.payload, "audit log payload"),
    createdAt: row.created_at
  };
}

export function safeJsonStringify(value: JsonObject, context = "JSON payload"): string {
  assertJsonObject(value, context);

  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`Invalid JSON payload for ${context}`, { cause: error });
  }
}

export function safeJsonParse(value: string, context = "JSON payload"): JsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON payload for ${context}`, { cause: error });
  }

  assertJsonObject(parsed, context);
  return parsed;
}

function assertJsonObject(value: unknown, context: string): asserts value is JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid JSON payload for ${context}: expected object`);
  }

  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, `${context}.${key}`);
  }
}

function assertJsonValue(value: unknown, context: string): asserts value is JsonValue {
  if (value === null) return;

  if (typeof value === "string" || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid JSON payload for ${context}: number must be finite`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonValue(child, `${context}[${index}]`));
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${context}.${key}`);
    }
    return;
  }

  throw new Error(`Invalid JSON payload for ${context}: unsupported value`);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
