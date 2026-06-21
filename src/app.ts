import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import type { AgentRuntime } from "./agent.js";
import type { AppConfig } from "./config.js";
import type { ApprovalStatus, OutgoingMessage } from "./domain.js";
import type { SqliteRepository } from "./repository.js";
import { ReminderScheduler } from "./scheduler.js";
import { ApprovalService, ConversationService, sanitizeError, UserDataService } from "./services.js";
import {
  parseIncomingWhatsAppMessages,
  verifyWhatsAppWebhook,
  type WhatsAppSender
} from "./whatsapp.js";

export type CreateAppDependencies = {
  config: AppConfig;
  repository: SqliteRepository;
  agentRuntime: AgentRuntime;
  whatsappSender: WhatsAppSender;
  logger?: FastifyServerOptions["logger"];
  devLog?: DevLog;
};

export type DevLog = (event: string, fields?: Record<string, unknown>) => void;

export function createApp(deps: CreateAppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true });
  const devLog = deps.devLog ?? noopDevLog;
  const conversationService = new ConversationService(deps.repository, deps.agentRuntime, devLog);
  const approvalService = new ApprovalService(deps.repository);
  const userDataService = new UserDataService(deps.repository);
  const scheduler = new ReminderScheduler(deps.repository);

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as RawBodyRequest).rawBody = rawBody;

    if (
      deps.config.whatsappAppSecret !== null &&
      request.method === "POST" &&
      request.url.split("?")[0] === "/webhooks/whatsapp" &&
      !isValidWhatsAppSignature(rawBody, request.headers["x-hub-signature-256"], deps.config.whatsappAppSecret)
    ) {
      done(httpError(401, "Invalid signature"));
      return;
    }

    try {
      done(null, rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin/") || deps.config.adminToken === null) return;

    if (!isAuthorizedBearerToken(request.headers.authorization, deps.config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/webhooks/whatsapp", async (request, reply) => {
    const challenge = verifyWhatsAppWebhook(request.query as Record<string, unknown>, deps.config.whatsappVerifyToken);

    if (challenge === false) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    return reply.type("text/plain").send(challenge);
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (
      deps.config.whatsappAppSecret !== null &&
      !isValidWhatsAppSignature(
        (request as RawBodyRequest).rawBody,
        request.headers["x-hub-signature-256"],
        deps.config.whatsappAppSecret
      )
    ) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    const messages = parseIncomingWhatsAppMessages(request.body);
    let processed = 0;
    let skipped = 0;

    if (messages.length === 0) {
      devLog("wa.empty");
    }

    for (const message of messages) {
      devLog("wa.in", {
        from: message.from,
        messageId: message.messageId,
        text: message.text
      });

      const claimed = await deps.repository.claimInboundMessage(message.messageId);
      if (!claimed) {
        skipped += 1;
        devLog("wa.skip", { reason: "duplicate", from: message.from, messageId: message.messageId });
        continue;
      }

      const handled = await conversationService.handleInboundMessage({
        from: message.from,
        messageId: message.messageId,
        text: message.text,
        timestamp: message.timestamp
      });
      devLog("agent.out", {
        from: handled.user.phoneNumber,
        userId: handled.user.id,
        messageId: message.messageId,
        reply: handled.result.reply,
        memoryFacts: handled.result.memoryFacts,
        tasks: handled.result.tasks,
        approvals: handled.result.approvals
      });
      processed += 1;
    }

    if (processed > 0) {
      const flushResult = await flushQueuedOutgoingMessages(deps.repository, deps.whatsappSender, new Date(), devLog);
      devLog("wa.flush", { processed, skipped, ...flushResult });
    }

    return { received: true, messages: messages.length, processed, skipped };
  });

  app.post("/admin/simulate-message", async (request, reply) => {
    const parsed = parseSimulatePayload(request.body);
    if (!parsed.ok) return badRequest(reply, parsed.error);

    const handled = await conversationService.handleInboundMessage(parsed.value);

    return {
      received: true,
      userId: handled.user.id,
      reply: handled.result.reply
    };
  });

  app.get("/admin/users", async () => {
    return { users: await deps.repository.listUsers() };
  });

  app.get("/admin/users/:id/export", async (request, reply) => {
    const userId = pathParam(request.params, "id");
    const exported = await userDataService.exportUserData(userId);

    if (exported.user === null) return notFound(reply, "User not found");

    return toAdminUserData(exported);
  });

  app.delete("/admin/users/:id", async (request, reply) => {
    const userId = pathParam(request.params, "id");
    const exported = await userDataService.exportUserData(userId);

    if (exported.user === null) return notFound(reply, "User not found");

    await userDataService.deleteUserData(userId);
    return { deleted: true };
  });

  app.get("/admin/users/:id", async (request, reply) => {
    const userId = pathParam(request.params, "id");
    const exported = await userDataService.exportUserData(userId);

    if (exported.user === null) return notFound(reply, "User not found");

    return toAdminUserData(exported);
  });

  app.post("/admin/scheduler/run", async (request, reply) => {
    const parsed = parseNowPayload(request.body);
    if (!parsed.ok) return badRequest(reply, parsed.error);

    return scheduler.runDueReminders(parsed.value);
  });

  app.post("/admin/outbox/flush", async (request, reply) => {
    const parsed = parseNowPayload(request.body);
    if (!parsed.ok) return badRequest(reply, parsed.error);

    return flushQueuedOutgoingMessages(deps.repository, deps.whatsappSender, parsed.value, devLog);
  });

  app.post("/admin/approvals/:id/resolve", async (request, reply) => {
    const approvalId = pathParam(request.params, "id");
    const parsed = parseApprovalResolvePayload(request.body);
    if (!parsed.ok) return badRequest(reply, parsed.error);

    try {
      const approval = await approvalService.resolve(parsed.value.userId, approvalId, parsed.value.status);
      return { approval };
    } catch (error) {
      if (isNotFoundError(error)) return notFound(reply, "Approval not found");
      throw error;
    }
  });

  return app;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

type RawBodyRequest = {
  rawBody?: Buffer;
};

type SimulateMessageInput = {
  from: string;
  messageId: string;
  text: string;
  timestamp: string;
  now?: Date;
};

function parseSimulatePayload(payload: unknown): ParseResult<SimulateMessageInput> {
  const body = asRecord(payload);
  if (!body) return parseError("Expected JSON object");

  const from = nonEmptyString(body.from);
  const text = nonEmptyString(body.text);
  if (!from) return parseError("from is required");
  if (!text) return parseError("text is required");

  const messageId = nonEmptyString(body.messageId) ?? `local.${Date.now()}`;
  const timestamp = nonEmptyString(body.timestamp) ?? new Date().toISOString();
  const parsedNow = parseOptionalDate(body.now);
  if (!parsedNow.ok) return parsedNow;

  return {
    ok: true,
    value: {
      from,
      messageId,
      text,
      timestamp,
      now: parsedNow.value
    }
  };
}

function parseNowPayload(payload: unknown): ParseResult<Date> {
  const body = payload === undefined ? {} : asRecord(payload);
  if (!body) return parseError("Expected JSON object");

  const parsedNow = parseOptionalDate(body.now);
  if (!parsedNow.ok) return parsedNow;

  return { ok: true, value: parsedNow.value ?? new Date() };
}

function parseApprovalResolvePayload(payload: unknown): ParseResult<{ userId: string; status: ApprovalStatus }> {
  const body = asRecord(payload);
  if (!body) return parseError("Expected JSON object");

  const userId = nonEmptyString(body.userId);
  if (!userId) return parseError("userId is required");

  if (body.status !== "approved" && body.status !== "rejected") {
    return parseError("status must be approved or rejected");
  }

  return { ok: true, value: { userId, status: body.status } };
}

function parseOptionalDate(value: unknown): ParseResult<Date | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim().length === 0) return parseError("now must be an ISO date string");

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return parseError("now must be a valid date");

  return { ok: true, value: date };
}

function toAdminUserData(data: {
  user: unknown;
  memoryFacts: unknown[];
  tasks: unknown[];
  approvals: unknown[];
  outgoingMessages: unknown[];
  auditLogs: unknown[];
}) {
  return {
    user: data.user,
    memory: data.memoryFacts,
    tasks: data.tasks,
    approvals: data.approvals,
    outbox: data.outgoingMessages,
    auditLogs: data.auditLogs
  };
}

function pathParam(params: unknown, key: string): string {
  const value = asRecord(params)?.[key];
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseError(error: string): ParseResult<never> {
  return { ok: false, error };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error });
}

function notFound(reply: FastifyReply, error: string) {
  return reply.code(404).send({ error });
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("not found");
}

async function flushQueuedOutgoingMessages(
  repository: SqliteRepository,
  sender: WhatsAppSender,
  now: Date,
  devLog: DevLog = noopDevLog
): Promise<{ sent: number; failed: number }> {
  const sentAt = now.toISOString();
  const messages = await repository.listQueuedOutgoingMessages(sentAt);
  let sent = 0;
  let failed = 0;

  for (const message of messages) {
    const updated = await sendOutgoingMessage(repository, sender, message, sentAt, devLog);
    if (updated.status === "sent") sent += 1;
    if (updated.status === "failed") failed += 1;
  }

  return { sent, failed };
}

async function sendOutgoingMessage(
  repository: SqliteRepository,
  sender: WhatsAppSender,
  message: OutgoingMessage,
  sentAt: string,
  devLog: DevLog
): Promise<OutgoingMessage> {
  try {
    await sender.sendText(message.to, message.body);
  } catch (error) {
    devLog("wa.send_failed", {
      outgoingMessageId: message.id,
      to: message.to,
      body: message.body,
      error: rawErrorMessage(error)
    });
    return repository.updateOutgoingMessage({
      ...message,
      status: "failed",
      sentAt: null,
      error: sanitizeError(error)
    });
  }

  const updated = await repository.updateOutgoingMessage({
    ...message,
    status: "sent",
    sentAt,
    error: null
  });
  devLog("wa.sent", {
    outgoingMessageId: updated.id,
    to: updated.to,
    body: updated.body
  });

  return updated;
}

function isAuthorizedBearerToken(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;

  return timingSafeStringEqual(header.slice(prefix.length), expectedToken);
}

function isValidWhatsAppSignature(
  rawBody: Buffer | undefined,
  header: string | string[] | undefined,
  appSecret: string
): boolean {
  const signature = Array.isArray(header) ? header[0] : header;
  if (!rawBody || !signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return timingSafeStringEqual(signature, expected);
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function noopDevLog(): void {}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
