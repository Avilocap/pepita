import type { JsonObject } from "./domain.js";

export type AgentContext = {
  userId: string;
  phoneNumber: string;
  text: string;
  messageId: string;
  now: Date;
};

export type AgentResult = {
  reply: string;
  memoryFacts: Array<{ text: string; confidence: number }>;
  tasks: Array<{ title: string; dueAt: string | null }>;
  approvals: Array<{
    type: "email_draft" | "browser_action";
    title: string;
    payload: JsonObject;
  }>;
};

export interface AgentRuntime {
  handleMessage(context: AgentContext): Promise<AgentResult>;
}

export class LocalAgentRuntime implements AgentRuntime {
  async handleMessage(context: AgentContext): Promise<AgentResult> {
    const sourceText = context.text.trim();
    const normalizedText = sourceText.toLowerCase();
    const result = createEmptyResult();

    const memoryText = extractAfterPhrase(sourceText, normalizedText, "recuerda que");
    if (memoryText !== null) {
      result.memoryFacts.push({ text: memoryText, confidence: 0.9 });
    }

    if (isReminderRequest(normalizedText)) {
      const title = extractTaskTitle(normalizedText);
      if (title.length > 0) {
        result.tasks.push({
          title,
          dueAt: hasTomorrow(normalizedText) ? nextDayAtNineIso(context.now) : null
        });
      } else {
        result.reply = "Dime que quieres que te recuerde.";
      }
    }

    if (isEmailDraftRequest(normalizedText)) {
      result.approvals.push({
        type: "email_draft",
        title: "Borrador de correo",
        payload: {
          draftText: createDraftText(sourceText),
          sourceText,
          messageId: context.messageId
        }
      });
    }

    if (isBrowserActionRequest(normalizedText)) {
      result.approvals.push({
        type: "browser_action",
        title: "Accion web pendiente",
        payload: {
          instruction: sourceText,
          sourceText,
          messageId: context.messageId
        }
      });
    }

    if (result.reply.length === 0) {
      result.reply = createReply(result);
    }
    return result;
  }
}

export class PiAgentRuntime implements AgentRuntime {
  async handleMessage(_context: AgentContext): Promise<AgentResult> {
    return {
      reply: "Pi runtime configurado, pero este MVP aun requiere conectar herramientas reales. Uso modo seguro.",
      memoryFacts: [],
      tasks: [],
      approvals: []
    };
  }
}

export function createAgentRuntime({ runtime }: { runtime: "local" | "pi" }): AgentRuntime {
  return runtime === "pi" ? new PiAgentRuntime() : new LocalAgentRuntime();
}

function createEmptyResult(): AgentResult {
  return {
    reply: "",
    memoryFacts: [],
    tasks: [],
    approvals: []
  };
}

function extractAfterPhrase(sourceText: string, normalizedText: string, phrase: string): string | null {
  const index = normalizedText.indexOf(phrase);
  if (index === -1) return null;

  const value = sourceText.slice(index + phrase.length).trim();
  return value.length > 0 ? value : null;
}

function isReminderRequest(normalizedText: string): boolean {
  return normalizedText.includes("recuerdame") || normalizedText.includes("recuérdame");
}

function extractTaskTitle(normalizedText: string): string {
  return normalizedText
    .replace(/\brecu[eé]rdame\b/g, "")
    .replace(/\b(por la ma[nñ]ana|por la tarde|por la noche|ma[nñ]ana|hoy)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTomorrow(normalizedText: string): boolean {
  return /\bma[nñ]ana\b/.test(normalizedText);
}

function isEmailDraftRequest(normalizedText: string): boolean {
  return /^(?:(?:pepita|por favor),?\s+)?(?:redacta|prepara) un correo\b/.test(normalizedText);
}

function nextDayAtNineIso(now: Date): string {
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 1);
  dueAt.setHours(9, 0, 0, 0);
  return dueAt.toISOString();
}

function isBrowserActionRequest(normalizedText: string): boolean {
  const hasActionVerb = /^(?:entra en|abre|mira)\b/.test(normalizedText);
  const hasWebTarget = /\bweb\b/.test(normalizedText) || /\b[a-z0-9-]+\.[a-z]{2,}\b/.test(normalizedText);

  return hasActionVerb && hasWebTarget;
}

function createDraftText(sourceText: string): string {
  return `Borrador pendiente de revisar: ${sourceText}`;
}

function createReply(result: AgentResult): string {
  if (result.memoryFacts.length > 0) return "Lo guardo para recordarlo.";
  if (result.tasks.length > 0) return "He creado el recordatorio.";
  if (result.approvals.some((approval) => approval.type === "email_draft")) {
    return "He preparado un borrador para que lo apruebes.";
  }
  if (result.approvals.some((approval) => approval.type === "browser_action")) {
    return "Necesito tu aprobacion antes de abrir la web.";
  }

  return "Puedo ayudarte a recordar datos, crear tareas o preparar borradores.";
}
