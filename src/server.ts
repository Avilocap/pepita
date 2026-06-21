import { createAgentRuntime } from "./agent.js";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import { SqliteRepository } from "./repository.js";
import { DryRunWhatsAppSender, WhatsAppCloudSender, type WhatsAppSender } from "./whatsapp.js";

let db: Database | null = null;

try {
  const config = loadConfig();
  db = openDatabase(config.databasePath);
  const repository = new SqliteRepository(db);

  await repository.migrate();

  const app = createApp({
    config,
    repository,
    agentRuntime: createAgentRuntime({ runtime: config.agentRuntime }),
    whatsappSender: createWhatsAppSender(config),
    logger: true
  });

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      db?.close();
      db = null;
    }
  };

  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  const address = await app.listen({ port: config.port, host: config.host });
  app.log.info({ address }, "Pepita HTTP server listening");
} catch (error) {
  try {
    db?.close();
  } finally {
    console.error(error);
    process.exit(1);
  }
}

function createWhatsAppSender(config: AppConfig): WhatsAppSender {
  if (config.whatsappSendMode === "dry-run") return new DryRunWhatsAppSender();

  if (!config.whatsappAccessToken || !config.whatsappPhoneNumberId) {
    throw new Error("Cloud WhatsApp sender requires access token and phone number id");
  }

  return new WhatsAppCloudSender({
    accessToken: config.whatsappAccessToken,
    phoneNumberId: config.whatsappPhoneNumberId
  });
}
