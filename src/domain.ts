import { randomUUID } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = {
  [key: string]: JsonValue;
};

export type User = {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  locale: string | null;
  timezone: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  serviceWindowUntil: string | null;
};

export type MemoryFact = {
  id: string;
  userId: string;
  text: string;
  sourceMessageId: string | null;
  confidence: number;
  createdAt: string;
};

export type TaskStatus = "open" | "done";

export type Task = {
  id: string;
  userId: string;
  title: string;
  status: TaskStatus;
  dueAt: string | null;
  remindedAt: string | null;
  sourceMessageId: string | null;
  createdAt: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalType = "email_draft" | "browser_action";

export type Approval = {
  id: string;
  userId: string;
  type: ApprovalType;
  title: string;
  payload: JsonObject;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export type OutgoingMessageStatus = "queued" | "sent" | "failed";

export type OutgoingMessage = {
  id: string;
  userId: string;
  channel: string;
  to: string;
  body: string;
  templateName: string | null;
  status: OutgoingMessageStatus;
  scheduledFor: string | null;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
};

export type AuditLog = {
  id: string;
  userId: string;
  actor: string;
  action: string;
  payload: JsonObject;
  createdAt: string;
};

export type NewMemoryFact = {
  userId: string;
  text: string;
  sourceMessageId: string | null;
  confidence: number;
};

export type NewTask = {
  userId: string;
  title: string;
  dueAt: string | null;
  sourceMessageId: string | null;
};

export type NewApproval = {
  userId: string;
  type: ApprovalType;
  title: string;
  payload: JsonObject;
};

export type NewOutgoingMessage = {
  userId: string;
  channel?: string;
  to: string;
  body: string;
  templateName: string | null;
  scheduledFor: string | null;
};

export type NewAuditLog = {
  userId: string;
  actor: string;
  action: string;
  payload: JsonObject;
};

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
