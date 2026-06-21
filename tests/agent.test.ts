import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  LocalAgentRuntime,
  PiAgentRuntime,
  type AgentContext,
  type AgentResult
} from "../src/agent.js";

function createContext(text: string, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: "user_1",
    phoneNumber: "+34600000001",
    text,
    messageId: "wamid.1",
    now: new Date("2030-05-20T17:30:00.000Z"),
    ...overrides
  };
}

function expectEmptyWrites(result: AgentResult) {
  expect(result.memoryFacts).toEqual([]);
  expect(result.tasks).toEqual([]);
  expect(result.approvals).toEqual([]);
}

function nextLocalDayAtNineIso(now: Date): string {
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 1);
  dueAt.setHours(9, 0, 0, 0);
  return dueAt.toISOString();
}

describe("LocalAgentRuntime", () => {
  it("stores a memory fact from recuerda que messages and returns a short reply", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("recuerda que prefiero llamadas por la tarde"));

    expect(result.memoryFacts).toEqual([{ text: "prefiero llamadas por la tarde", confidence: expect.any(Number) }]);
    expect(result.memoryFacts[0]?.confidence).toBeGreaterThan(0);
    expect(result.memoryFacts[0]?.confidence).toBeLessThanOrEqual(1);
    expect(result.tasks).toEqual([]);
    expect(result.approvals).toEqual([]);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.reply.length).toBeLessThanOrEqual(120);
  });

  it("creates a reminder task for manana at next day 09:00 based on context.now", async () => {
    const runtime = new LocalAgentRuntime();
    const context = createContext("recuerdame llamar al gestor manana");

    const result = await runtime.handleMessage(context);

    expect(result.tasks).toEqual([{ title: "llamar al gestor", dueAt: nextLocalDayAtNineIso(context.now) }]);
    expect(result.memoryFacts).toEqual([]);
    expect(result.approvals).toEqual([]);
  });

  it("creates a reminder task when recuérdame and mañana use accents", async () => {
    const runtime = new LocalAgentRuntime();
    const context = createContext("recuérdame llamar al gestor mañana");

    const result = await runtime.handleMessage(context);

    expect(result.tasks).toEqual([{ title: "llamar al gestor", dueAt: nextLocalDayAtNineIso(context.now) }]);
    expect(result.memoryFacts).toEqual([]);
    expect(result.approvals).toEqual([]);
  });

  it("does not create an empty reminder task when only the date is provided", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("recuérdame mañana"));

    expect(result.tasks).toEqual([]);
    expect(result.reply).toContain("que quieres que te recuerde");
    expect(result.memoryFacts).toEqual([]);
    expect(result.approvals).toEqual([]);
  });

  it("creates tomorrow reminders across month and year rollover using local dates", async () => {
    const runtime = new LocalAgentRuntime();
    const context = createContext("recuerdame renovar licencia manana", {
      now: new Date(2030, 11, 31, 18, 0, 0, 0)
    });
    const expectedDueAt = new Date(2031, 0, 1, 9, 0, 0, 0).toISOString();

    const result = await runtime.handleMessage(context);

    expect(result.tasks).toEqual([{ title: "renovar licencia", dueAt: expectedDueAt }]);
    expect(result.memoryFacts).toEqual([]);
    expect(result.approvals).toEqual([]);
  });

  it("creates an email draft approval instead of executing an external action", async () => {
    const runtime = new LocalAgentRuntime();
    const text = "redacta un correo a mi gestor pidiendo los papeles";

    const result = await runtime.handleMessage(createContext(text, { messageId: "wamid.email" }));

    expect(result.approvals).toEqual([
      {
        type: "email_draft",
        title: expect.any(String),
        payload: {
          draftText: expect.any(String),
          sourceText: text,
          messageId: "wamid.email"
        }
      }
    ]);
    expect(result.memoryFacts).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it("does not create an email draft approval for non-command email writing questions", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("cómo se redacta un correo"));

    expect(result.reply).toContain("Puedo ayudarte");
    expectEmptyWrites(result);
  });

  it("creates a browser action approval instead of executing browsing", async () => {
    const runtime = new LocalAgentRuntime();
    const text = "entra en la web de hacienda y mira mis notificaciones";

    const result = await runtime.handleMessage(createContext(text, { messageId: "wamid.browser" }));

    expect(result.approvals).toEqual([
      {
        type: "browser_action",
        title: expect.any(String),
        payload: {
          instruction: text,
          sourceText: text,
          messageId: "wamid.browser"
        }
      }
    ]);
    expect(result.memoryFacts).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it("does not create a browser action approval for web as part of another word", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("abreviatura web"));

    expect(result.reply).toContain("Puedo ayudarte");
    expectEmptyWrites(result);
  });

  it("returns a fallback reply and no writes for ordinary chat", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("hola pepita, como estas"));

    expect(result.reply).toContain("Puedo ayudarte");
    expectEmptyWrites(result);
  });

  it("always returns AgentResult arrays even when empty", async () => {
    const runtime = new LocalAgentRuntime();

    const result = await runtime.handleMessage(createContext("solo queria saludar"));

    expect(Array.isArray(result.memoryFacts)).toBe(true);
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(Array.isArray(result.approvals)).toBe(true);
    expectEmptyWrites(result);
  });
});

describe("createAgentRuntime", () => {
  it("returns LocalAgentRuntime for local runtime", () => {
    expect(createAgentRuntime({ runtime: "local" })).toBeInstanceOf(LocalAgentRuntime);
  });

  it("returns PiAgentRuntime for pi runtime without external API calls during construction", () => {
    expect(
      createAgentRuntime({
        runtime: "pi",
        piProvider: "openai-codex",
        piModel: "gpt-5.4-mini"
      })
    ).toBeInstanceOf(PiAgentRuntime);
  });
});

describe("PiAgentRuntime", () => {
  it("returns the effects accumulated by Pepita tools during a Pi turn", async () => {
    const runtime = new PiAgentRuntime({
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      runSession: async ({ tools, prompt, systemPrompt }) => {
        expect(prompt).toContain("recuerdame llamar al gestor manana");
        expect(systemPrompt).toContain("pepita_finish");

        const remember = tools.find((tool) => tool.name === "pepita_remember_fact");
        const task = tools.find((tool) => tool.name === "pepita_create_task");
        const approval = tools.find((tool) => tool.name === "pepita_request_approval");
        const finish = tools.find((tool) => tool.name === "pepita_finish");
        expect(remember).toBeDefined();
        expect(task).toBeDefined();
        expect(approval).toBeDefined();
        expect(finish).toBeDefined();

        await remember?.execute(
          "tool-memory",
          { text: "Prefiere llamadas por la tarde", confidence: 0.8 },
          undefined,
          undefined,
          {} as never
        );
        await task?.execute(
          "tool-task",
          { title: "Llamar al gestor", dueAt: "2030-05-21T09:00:00.000Z" },
          undefined,
          undefined,
          {} as never
        );
        await approval?.execute(
          "tool-approval",
          {
            type: "email_draft",
            title: "Correo al gestor",
            payload: { draftText: "Hola", sourceText: "recuerdame llamar al gestor manana" }
          },
          undefined,
          undefined,
          {} as never
        );
        await finish?.execute(
          "tool-finish",
          { reply: "He guardado la preferencia, el recordatorio y el borrador." },
          undefined,
          undefined,
          {} as never
        );

        return { finalText: "" };
      }
    });

    const result = await runtime.handleMessage(createContext("recuerdame llamar al gestor manana"));

    expect(result).toEqual({
      reply: "He guardado la preferencia, el recordatorio y el borrador.",
      memoryFacts: [{ text: "Prefiere llamadas por la tarde", confidence: 0.8 }],
      tasks: [{ title: "Llamar al gestor", dueAt: "2030-05-21T09:00:00.000Z" }],
      approvals: [
        {
          type: "email_draft",
          title: "Correo al gestor",
          payload: { draftText: "Hola", sourceText: "recuerdame llamar al gestor manana" }
        }
      ]
    });
  });

  it("fills tomorrow at 09:00 when Pi queues an obvious manana task without dueAt", async () => {
    const context = createContext("recuerdame llamar al gestor manana", {
      now: new Date("2030-05-20T17:30:00.000Z")
    });
    const runtime = new PiAgentRuntime({
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      runSession: async ({ tools }) => {
        const task = tools.find((tool) => tool.name === "pepita_create_task");
        const finish = tools.find((tool) => tool.name === "pepita_finish");

        await task?.execute(
          "tool-task",
          { title: "Llamar al gestor manana" },
          undefined,
          undefined,
          {} as never
        );
        await finish?.execute("tool-finish", { reply: "Te lo recuerdo manana." }, undefined, undefined, {} as never);

        return { finalText: "" };
      }
    });

    const result = await runtime.handleMessage(context);

    expect(result.tasks).toEqual([{ title: "Llamar al gestor manana", dueAt: nextLocalDayAtNineIso(context.now) }]);
  });
});
