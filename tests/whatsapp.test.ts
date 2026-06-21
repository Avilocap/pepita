import { describe, expect, it } from "vitest";
import {
  DryRunWhatsAppSender,
  WhatsAppCloudSender,
  parseIncomingWhatsAppMessages,
  verifyWhatsAppWebhook
} from "../src/whatsapp.js";

function incomingPayload(messages: unknown[]) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages
            }
          }
        ]
      }
    ]
  };
}

function createFetchResponse(status: number) {
  return new Response("{}", { status });
}

describe("verifyWhatsAppWebhook", () => {
  it("returns the challenge for a valid webhook verification", () => {
    const result = verifyWhatsAppWebhook(
      {
        "hub.mode": "subscribe",
        "hub.verify_token": "expected-token",
        "hub.challenge": "challenge-123"
      },
      "expected-token"
    );

    expect(result).toBe("challenge-123");
  });

  it("returns false for invalid webhook verification", () => {
    const result = verifyWhatsAppWebhook(
      {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-123"
      },
      "expected-token"
    );

    expect(result).toBe(false);
  });
});

describe("parseIncomingWhatsAppMessages", () => {
  it("parses inbound text messages", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.1",
          from: "34600000001",
          timestamp: "1710000000",
          type: "text",
          text: { body: "Hola Pepita" }
        }
      ])
    );

    expect(messages).toEqual([
      {
        messageId: "wamid.1",
        from: "+34600000001",
        timestamp: "1710000000",
        type: "text",
        text: "Hola Pepita"
      }
    ]);
  });

  it("parses unsupported messages into a safe unsupported message", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.2",
          from: "+34 600 000 002",
          timestamp: "1710000001",
          type: "image",
          image: { id: "media-1" }
        }
      ])
    );

    expect(messages).toEqual([
      {
        messageId: "wamid.2",
        from: "+34600000002",
        timestamp: "1710000001",
        type: "text",
        text: "Unsupported WhatsApp message type: image. Pepita can only handle text messages right now."
      }
    ]);
  });

  it("uses unknown for hostile unsupported message types", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.unsafe",
          from: "34600000002",
          timestamp: "1710000001",
          type: "image\n<script>alert(1)</script>"
        }
      ])
    );

    expect(messages).toEqual([
      {
        messageId: "wamid.unsafe",
        from: "+34600000002",
        timestamp: "1710000001",
        type: "text",
        text: "Unsupported WhatsApp message type: unknown. Pepita can only handle text messages right now."
      }
    ]);
  });

  it("ignores malformed messages without id or from", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          from: "34600000001",
          timestamp: "1710000000",
          type: "text",
          text: { body: "Missing id" }
        },
        {
          id: "wamid.2",
          timestamp: "1710000001",
          type: "text",
          text: { body: "Missing from" }
        },
        {
          id: "wamid.3",
          from: "34600000003",
          timestamp: "1710000002",
          type: "text",
          text: { body: "Valid" }
        }
      ])
    );

    expect(messages).toEqual([
      {
        messageId: "wamid.3",
        from: "+34600000003",
        timestamp: "1710000002",
        type: "text",
        text: "Valid"
      }
    ]);
  });

  it("ignores text messages with missing text body", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.missing-body",
          from: "34600000001",
          timestamp: "1710000000",
          type: "text",
          text: {}
        }
      ])
    );

    expect(messages).toEqual([]);
  });

  it("ignores text messages with blank text body", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.blank-body",
          from: "34600000001",
          timestamp: "1710000000",
          type: "text",
          text: { body: "   \n\t" }
        }
      ])
    );

    expect(messages).toEqual([]);
  });

  it("ignores text messages with non-string text body", () => {
    const messages = parseIncomingWhatsAppMessages(
      incomingPayload([
        {
          id: "wamid.non-string-body",
          from: "34600000001",
          timestamp: "1710000000",
          type: "text",
          text: { body: 123 }
        }
      ])
    );

    expect(messages).toEqual([]);
  });

  it("tolerates missing webhook arrays", () => {
    expect(parseIncomingWhatsAppMessages({})).toEqual([]);
    expect(parseIncomingWhatsAppMessages({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });
});

describe("WhatsAppCloudSender", () => {
  it("uses Graph API v25.0 by default", async () => {
    const fetchCalls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      fetchCalls.push({ input, init });
      return createFetchResponse(200);
    };
    const sender = new WhatsAppCloudSender({
      accessToken: "access-token-123",
      phoneNumberId: "phone-number-123",
      fetch: fakeFetch
    });

    await sender.sendText("34600000001", "Hola Maria");

    expect(fetchCalls[0]?.input).toBe("https://graph.facebook.com/v25.0/phone-number-123/messages");
  });

  it("posts correct JSON and bearer token", async () => {
    const fetchCalls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      fetchCalls.push({ input, init });
      return createFetchResponse(200);
    };
    const sender = new WhatsAppCloudSender({
      accessToken: "access-token-123",
      phoneNumberId: "phone-number-123",
      graphApiVersion: "v99.0",
      baseUrl: "https://graph.test",
      fetch: fakeFetch
    });

    await sender.sendText("34600000001", "Hola Maria");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe("https://graph.test/v99.0/phone-number-123/messages");
    expect(fetchCalls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer access-token-123",
        "Content-Type": "application/json"
      }
    });
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      messaging_product: "whatsapp",
      to: "34600000001",
      type: "text",
      text: { body: "Hola Maria" }
    });
  });

  it("strips a leading plus from the recipient", async () => {
    const bodies: unknown[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return createFetchResponse(200);
    };
    const sender = new WhatsAppCloudSender({
      accessToken: "access-token-123",
      phoneNumberId: "phone-number-123",
      baseUrl: "https://graph.test",
      fetch: fakeFetch
    });

    await sender.sendText("+34600000001", "Hola Maria");

    expect(bodies).toMatchObject([{ to: "34600000001" }]);
  });

  it("throws on non-2xx response and includes HTTP status", async () => {
    const fakeFetch: typeof fetch = async () => createFetchResponse(500);
    const sender = new WhatsAppCloudSender({
      accessToken: "access-token-123",
      phoneNumberId: "phone-number-123",
      baseUrl: "https://graph.test",
      fetch: fakeFetch
    });

    await expect(sender.sendText("34600000001", "Hola Maria")).rejects.toThrow(/HTTP 500/);
  });

  it("throws before fetch for invalid recipients", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCount += 1;
      return createFetchResponse(200);
    };
    const sender = new WhatsAppCloudSender({
      accessToken: "access-token-123",
      phoneNumberId: "phone-number-123",
      baseUrl: "https://graph.test",
      fetch: fakeFetch
    });

    await expect(sender.sendText("+34 600 000 001", "Hola Maria")).rejects.toThrow(/Invalid WhatsApp recipient/);
    await expect(sender.sendText("1234567", "Hola Maria")).rejects.toThrow(/Invalid WhatsApp recipient/);
    await expect(sender.sendText("1234567890123456", "Hola Maria")).rejects.toThrow(/Invalid WhatsApp recipient/);

    expect(fetchCount).toBe(0);
  });
});

describe("DryRunWhatsAppSender", () => {
  it("records sent text messages without network", async () => {
    const sender = new DryRunWhatsAppSender();

    await sender.sendText("+34600000001", "Hola Maria");

    expect(sender.sentTextMessages).toEqual([{ to: "+34600000001", text: "Hola Maria" }]);
  });

  it("validates and normalizes recipients consistently with Cloud sender", async () => {
    const sender = new DryRunWhatsAppSender();

    await sender.sendText("34600000001", "Hola Maria");
    await expect(sender.sendText("1234567", "Hola Maria")).rejects.toThrow(/Invalid WhatsApp recipient/);

    expect(sender.sentTextMessages).toEqual([{ to: "+34600000001", text: "Hola Maria" }]);
  });
});
