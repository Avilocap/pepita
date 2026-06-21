export type IncomingWhatsAppMessage = {
  messageId: string;
  from: string;
  timestamp: string;
  type: "text";
  text: string;
};

export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<void>;
}

type QueryLike = Record<string, unknown> | URLSearchParams;
type FetchLike = typeof fetch;

type WhatsAppCloudSenderOptions = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion?: string;
  baseUrl?: string;
  fetch?: FetchLike;
};

export function verifyWhatsAppWebhook(query: QueryLike, expectedVerifyToken: string): string | false {
  const mode = queryValue(query, "hub.mode");
  const verifyToken = queryValue(query, "hub.verify_token");
  const challenge = queryValue(query, "hub.challenge");

  if (mode === "subscribe" && verifyToken === expectedVerifyToken && challenge !== undefined && challenge !== null) {
    return String(challenge);
  }

  return false;
}

export function parseIncomingWhatsAppMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const messages: IncomingWhatsAppMessage[] = [];
  const root = asRecord(payload);

  for (const entry of asArray(root?.entry)) {
    const entryRecord = asRecord(entry);

    for (const change of asArray(entryRecord?.changes)) {
      const changeRecord = asRecord(change);
      const valueRecord = asRecord(changeRecord?.value);

      for (const rawMessage of asArray(valueRecord?.messages)) {
        const message = parseSingleMessage(rawMessage);

        if (message) {
          messages.push(message);
        }
      }
    }
  }

  return messages;
}

export class WhatsAppCloudSender implements WhatsAppSender {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: WhatsAppCloudSenderOptions) {
    this.accessToken = options.accessToken;
    this.phoneNumberId = options.phoneNumberId;
    this.apiVersion = options.graphApiVersion ?? "v25.0";
    this.baseUrl = (options.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async sendText(to: string, text: string): Promise<void> {
    const recipient = normalizeOutboundRecipient(to);
    const response = await this.fetchImpl(`${this.baseUrl}/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.apiValue,
        type: "text",
        text: { body: text }
      })
    });

    if (!response.ok) {
      throw new Error(`WhatsApp Cloud API request failed with HTTP ${response.status}`);
    }
  }
}

export class DryRunWhatsAppSender implements WhatsAppSender {
  readonly sentTextMessages: Array<{ to: string; text: string }> = [];

  async sendText(to: string, text: string): Promise<void> {
    const recipient = normalizeOutboundRecipient(to);
    this.sentTextMessages.push({ to: recipient.canonicalValue, text });
  }
}

function parseSingleMessage(rawMessage: unknown): IncomingWhatsAppMessage | null {
  const message = asRecord(rawMessage);

  if (!message) {
    return null;
  }

  const id = message?.id;
  const from = message?.from;

  if (typeof id !== "string" || id.length === 0 || typeof from !== "string" || from.length === 0) {
    return null;
  }

  const normalizedFrom = normalizeIncomingPhoneNumber(from);
  if (!normalizedFrom) {
    return null;
  }

  const messageType = typeof message.type === "string" && message.type.length > 0 ? message.type : "unknown";
  const timestamp = stringifyTimestamp(message.timestamp);

  if (messageType === "text") {
    const text = asRecord(message.text);
    const body = text?.body;

    if (typeof body !== "string" || body.trim().length === 0) {
      return null;
    }

    return {
      messageId: id,
      from: normalizedFrom,
      timestamp,
      type: "text",
      text: body
    };
  }

  const safeMessageType = safeUnsupportedMessageType(messageType);

  return {
    messageId: id,
    from: normalizedFrom,
    timestamp,
    type: "text",
    text: `Unsupported WhatsApp message type: ${safeMessageType}. Pepita can only handle text messages right now.`
  };
}

function queryValue(query: QueryLike, key: string): unknown {
  if (query instanceof URLSearchParams) {
    return query.get(key);
  }

  return query[key];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeIncomingPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? `+${digits}` : "";
}

function normalizeOutboundRecipient(value: string): { apiValue: string; canonicalValue: string } {
  if (!/^\+?\d{8,15}$/.test(value)) {
    throw new Error("Invalid WhatsApp recipient: expected 8-15 digits with optional leading +");
  }

  const digits = value.startsWith("+") ? value.slice(1) : value;

  return {
    apiValue: digits,
    canonicalValue: `+${digits}`
  };
}

function stringifyTimestamp(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function safeUnsupportedMessageType(value: string): string {
  const normalized = value.toLowerCase();
  const allowedLabels = new Set(["audio", "image", "video", "document", "button", "interactive", "unknown"]);

  return allowedLabels.has(normalized) ? normalized : "unknown";
}
