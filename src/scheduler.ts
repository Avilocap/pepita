import type { AuditLog, OutgoingMessage, Task, User } from "./domain.js";

type ClaimAndEnqueueReminderInput = {
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

type ClaimAndEnqueueReminderResult = {
  task: Task;
  outgoingMessage: OutgoingMessage;
  auditLog: AuditLog;
};

type ReminderRepository = {
  listUsers(): Promise<User[]>;
  listTasks(userId: string): Promise<Task[]>;
  claimAndEnqueueReminder(input: ClaimAndEnqueueReminderInput): Promise<ClaimAndEnqueueReminderResult | null>;
};

type ReminderSchedulerOptions = {
  reminderTemplateName?: string;
};

export class ReminderScheduler {
  private readonly reminderTemplateName: string;

  constructor(
    private readonly repository: ReminderRepository,
    reminderTemplateName: string | ReminderSchedulerOptions = "pepita_reminder"
  ) {
    this.reminderTemplateName =
      typeof reminderTemplateName === "string"
        ? reminderTemplateName
        : (reminderTemplateName.reminderTemplateName ?? "pepita_reminder");
  }

  async runDueReminders(now: Date): Promise<{ enqueued: number }> {
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    let enqueued = 0;

    for (const user of await this.repository.listUsers()) {
      for (const task of await this.repository.listTasks(user.id)) {
        const dueAt = this.getDueAt(task, nowMs);
        if (dueAt === null) continue;

        const usedTemplate = !this.isInsideServiceWindow(user, nowMs);
        const claimed = await this.repository.claimAndEnqueueReminder({
          taskId: task.id,
          userId: user.id,
          to: user.phoneNumber,
          body: `Recordatorio: ${task.title}`,
          dueAt,
          remindedAt: nowIso,
          templateName: usedTemplate ? this.reminderTemplateName : null,
          usedTemplate,
          serviceWindowUntil: user.serviceWindowUntil
        });
        if (claimed === null) continue;

        enqueued += 1;
      }
    }

    return { enqueued };
  }

  private getDueAt(task: Task, nowMs: number): string | null {
    if (task.status !== "open" || task.dueAt === null || task.remindedAt !== null) return null;

    const dueAtMs = parseDateTime(task.dueAt);
    return dueAtMs !== null && dueAtMs <= nowMs ? task.dueAt : null;
  }

  private isInsideServiceWindow(user: User, nowMs: number): boolean {
    const serviceWindowUntilMs = parseDateTime(user.serviceWindowUntil);
    return serviceWindowUntilMs !== null && nowMs <= serviceWindowUntilMs;
  }
}

function parseDateTime(value: string | null): number | null {
  if (value === null) return null;

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}
