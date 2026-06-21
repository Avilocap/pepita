export type AppConfig = {
  host: string;
  port: number;
  databasePath: string;
  agentRuntime: "local" | "pi";
  adminToken: string | null;
  whatsappVerifyToken: string;
  whatsappAccessToken: string | null;
  whatsappPhoneNumberId: string | null;
  whatsappAppSecret: string | null;
  whatsappSendMode: "dry-run" | "cloud";
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): AppConfig {
  const host = valueOrDefault(env.HOST, "127.0.0.1");
  const adminToken = optionalValue(env.ADMIN_TOKEN);
  const whatsappVerifyToken = valueOrDefault(env.WHATSAPP_VERIFY_TOKEN, "change-me");
  const whatsappAccessToken = optionalValue(env.WHATSAPP_ACCESS_TOKEN);
  const whatsappPhoneNumberId = optionalValue(env.WHATSAPP_PHONE_NUMBER_ID);
  const whatsappAppSecret = optionalValue(env.WHATSAPP_APP_SECRET);
  const whatsappSendMode = parseWhatsAppSendMode(env.WHATSAPP_SEND_MODE);

  if (env.NODE_ENV === "production" && whatsappVerifyToken === "change-me") {
    throw new Error("WHATSAPP_VERIFY_TOKEN must be set in production");
  }

  if ((env.NODE_ENV === "production" || !isLocalHost(host)) && adminToken === null) {
    throw new Error("ADMIN_TOKEN must be set in production or when binding beyond localhost");
  }

  if (env.NODE_ENV === "production" && whatsappAppSecret === null) {
    throw new Error("WHATSAPP_APP_SECRET must be set in production");
  }

  if (env.NODE_ENV === "production" && optionalValue(env.WHATSAPP_SEND_MODE) === null) {
    throw new Error("WHATSAPP_SEND_MODE must be set explicitly in production");
  }

  if (whatsappSendMode === "cloud") {
    if (whatsappAccessToken === null) throw new Error("WHATSAPP_ACCESS_TOKEN is required when WHATSAPP_SEND_MODE=cloud");
    if (whatsappPhoneNumberId === null) {
      throw new Error("WHATSAPP_PHONE_NUMBER_ID is required when WHATSAPP_SEND_MODE=cloud");
    }
  }

  return {
    host,
    port: parsePort(env.PORT),
    databasePath: valueOrDefault(env.PEPITA_DATABASE_PATH, ".data/pepita.sqlite"),
    agentRuntime: parseAgentRuntime(env.PEPITA_AGENT_RUNTIME),
    adminToken,
    whatsappVerifyToken,
    whatsappAccessToken,
    whatsappPhoneNumberId,
    whatsappAppSecret,
    whatsappSendMode
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 3000;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Invalid PORT: expected an integer from 1 to 65535");
  }

  return parsed;
}

function parseAgentRuntime(value: string | undefined): AppConfig["agentRuntime"] {
  if (value === undefined || value.trim().length === 0) return "local";
  if (value === "local" || value === "pi") return value;

  throw new Error("Invalid PEPITA_AGENT_RUNTIME: expected local or pi");
}

function parseWhatsAppSendMode(value: string | undefined): AppConfig["whatsappSendMode"] {
  if (value === undefined || value.trim().length === 0) return "dry-run";
  if (value === "dry-run" || value === "cloud") return value;

  throw new Error("Invalid WHATSAPP_SEND_MODE: expected dry-run or cloud");
}

function valueOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function optionalValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}
