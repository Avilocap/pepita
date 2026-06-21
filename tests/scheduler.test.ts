import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../src/db.js";
import type { AuditLog, NewAuditLog, NewOutgoingMessage, OutgoingMessage, Task, User } from "../src/domain.js";
import { SqliteRepository } from "../src/repository.js";
import { ReminderScheduler } from "../src/scheduler.js";

const dirs: string[] = [];
const databases: Database[] = [];
const now = new Date("2030-01-01T09:00:00.000Z");

afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
  }

  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ReminderScheduler", () => {
  it("enqueues one outgoing message for a due open task without remindedAt", async () => {
    const { repo, user, task } = await createDueTaskContext();
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);
    const outgoingMessages = await repo.listOutgoingMessages(user.id);

    expect(result).toEqual({ enqueued: 1 });
    expect(outgoingMessages).toMatchObject([
      {
        userId: user.id,
        to: user.phoneNumber,
        body: `Recordatorio: ${task.title}`,
        templateName: null,
        scheduledFor: null,
        status: "queued"
      }
    ]);
  });

  it("does not enqueue a duplicate reminder on a second run", async () => {
    const { repo, user } = await createDueTaskContext();
    const scheduler = new ReminderScheduler(repo);

    await expect(scheduler.runDueReminders(now)).resolves.toEqual({ enqueued: 1 });
    await expect(scheduler.runDueReminders(now)).resolves.toEqual({ enqueued: 0 });

    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
  });

  it("does not enqueue when a due task was already claimed before scheduler runs", async () => {
    const { repo, user, task } = await createDueTaskContext();
    await repo.updateTask({ ...task, remindedAt: now.toISOString() });
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 0 });
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(0);
  });

  it("does not enqueue when a due task is claimed between scan and enqueue", async () => {
    const repository = new AlreadyClaimedRepository();
    const scheduler = new ReminderScheduler(repository);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 0 });
    expect(repository.claimAttempts).toBe(1);
  });

  it("does not enqueue messages for future tasks", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: "2030-01-01T09:01:00.000Z",
      serviceWindowUntil: "2030-01-01T10:00:00.000Z"
    });
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 0 });
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(0);
  });

  it("does not enqueue messages for invalid dueAt values", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: "2029-not-a-date",
      serviceWindowUntil: "2030-01-01T10:00:00.000Z"
    });
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 0 });
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(0);
  });

  it("enqueues messages for offset dueAt values that are due by timestamp", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: "2030-01-01T10:00:00+01:00",
      serviceWindowUntil: "2030-01-01T10:00:00.000Z"
    });
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 1 });
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(1);
  });

  it("does not enqueue messages for done tasks", async () => {
    const { repo, user, task } = await createDueTaskContext();
    await repo.updateTask({ ...task, status: "done" });
    const scheduler = new ReminderScheduler(repo);

    const result = await scheduler.runDueReminders(now);

    expect(result).toEqual({ enqueued: 0 });
    expect(await repo.listOutgoingMessages(user.id)).toHaveLength(0);
  });

  it("uses the template name when outside serviceWindowUntil", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: now.toISOString(),
      serviceWindowUntil: "2030-01-01T08:59:59.000Z"
    });
    const scheduler = new ReminderScheduler(repo, "custom_reminder");

    await scheduler.runDueReminders(now);

    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([{ templateName: "custom_reminder" }]);
  });

  it("uses the default template name when outside serviceWindowUntil", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: now.toISOString(),
      serviceWindowUntil: "2030-01-01T08:59:59.000Z"
    });
    const scheduler = new ReminderScheduler(repo);

    await scheduler.runDueReminders(now);

    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([{ templateName: "pepita_reminder" }]);
  });

  it("uses the template name when serviceWindowUntil is null", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: now.toISOString(),
      serviceWindowUntil: null
    });
    const scheduler = new ReminderScheduler(repo);

    await scheduler.runDueReminders(now);

    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([{ templateName: "pepita_reminder" }]);
  });

  it("uses the template name when serviceWindowUntil is invalid", async () => {
    const { repo, user } = await createTaskContext({
      dueAt: now.toISOString(),
      serviceWindowUntil: "not-a-date"
    });
    const scheduler = new ReminderScheduler(repo);

    await scheduler.runDueReminders(now);

    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([{ templateName: "pepita_reminder" }]);
  });

  it("uses a free-form message when inside serviceWindowUntil", async () => {
    const { repo, user, task } = await createTaskContext({
      dueAt: now.toISOString(),
      serviceWindowUntil: "2030-01-01T09:00:01.000Z"
    });
    const scheduler = new ReminderScheduler(repo, { reminderTemplateName: "custom_reminder" });

    await scheduler.runDueReminders(now);

    expect(await repo.listOutgoingMessages(user.id)).toMatchObject([
      { body: `Recordatorio: ${task.title}`, templateName: null }
    ]);
  });

  it("audits reminder.enqueued with reminder delivery details", async () => {
    const { repo, user, task } = await createDueTaskContext();
    const scheduler = new ReminderScheduler(repo);

    await scheduler.runDueReminders(now);
    const outgoingMessage = (await repo.listOutgoingMessages(user.id))[0];

    expect(await repo.listAuditLogs(user.id)).toMatchObject([
      {
        actor: "system",
        action: "reminder.enqueued",
        payload: {
          taskId: task.id,
          outgoingMessageId: outgoingMessage.id,
          dueAt: task.dueAt,
          remindedAt: now.toISOString(),
          templateName: null,
          usedTemplate: false,
          serviceWindowUntil: "2030-01-01T10:00:00.000Z"
        }
      }
    ]);
  });

  it("sets task remindedAt to now after enqueue", async () => {
    const { repo, user, task } = await createDueTaskContext();
    const scheduler = new ReminderScheduler(repo);

    await scheduler.runDueReminders(now);

    expect(await repo.listTasks(user.id)).toMatchObject([{ id: task.id, remindedAt: now.toISOString() }]);
  });
});

async function createDueTaskContext() {
  return createTaskContext({
    dueAt: now.toISOString(),
    serviceWindowUntil: "2030-01-01T10:00:00.000Z"
  });
}

async function createTaskContext(input: { dueAt: string; serviceWindowUntil: string | null }): Promise<{
  repo: SqliteRepository;
  user: User;
  task: Task;
}> {
  const { repo } = await createRepoContext();
  const user = await repo.findOrCreateUserByPhone("+34600000001");
  if (input.serviceWindowUntil !== null) {
    await repo.updateUserActivity(user.id, now.toISOString(), input.serviceWindowUntil);
  }
  const task = await repo.addTask({
    userId: user.id,
    title: "Llamar al gestor",
    dueAt: input.dueAt,
    sourceMessageId: "wamid.1"
  });

  return { repo, user: (await repo.getUser(user.id)) ?? user, task };
}

class AlreadyClaimedRepository {
  claimAttempts = 0;

  private readonly user: User = {
    id: "user_1",
    phoneNumber: "+34600000001",
    displayName: null,
    locale: "es-ES",
    timezone: "Europe/Madrid",
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    serviceWindowUntil: "2030-01-01T10:00:00.000Z"
  };

  private readonly task: Task = {
    id: "task_1",
    userId: this.user.id,
    title: "Llamar al gestor",
    status: "open",
    dueAt: now.toISOString(),
    remindedAt: null,
    sourceMessageId: "wamid.1",
    createdAt: now.toISOString()
  };

  async listUsers(): Promise<User[]> {
    return [this.user];
  }

  async listTasks(userId: string): Promise<Task[]> {
    return userId === this.user.id ? [this.task] : [];
  }

  async claimAndEnqueueReminder(): Promise<null> {
    this.claimAttempts += 1;
    return null;
  }

  async updateTask(): Promise<Task> {
    throw new Error("scheduler should claim reminders atomically");
  }

  async enqueueOutgoingMessage(_input: NewOutgoingMessage): Promise<OutgoingMessage> {
    throw new Error("scheduler should not enqueue before claim");
  }

  async addAuditLog(_input: NewAuditLog): Promise<AuditLog> {
    throw new Error("scheduler should not audit outside claim");
  }
}

async function createRepoContext() {
  const dir = await mkdtemp(join(tmpdir(), "pepita-scheduler-"));
  dirs.push(dir);

  const db = openDatabase(join(dir, "pepita.sqlite"));
  databases.push(db);

  const repo = new SqliteRepository(db);
  await repo.migrate();

  return { repo };
}
