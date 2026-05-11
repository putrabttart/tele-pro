import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { env } from "../config/env";

type PendingLogin = {
  phoneCodeHash: string;
  label: string;
  tempSession: string;
};

const pendingLogins = new Map<string, PendingLogin>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createClient = (sessionString = "") => {
  return new TelegramClient(
    new StringSession(sessionString),
    env.TELEGRAM_API_ID!,
    env.TELEGRAM_API_HASH!,
    {
      connectionRetries: 3,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE)
    }
  );
};

const ensureTelegramConfig = () => {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  }
};

/**
 * Connect with retry on AUTH_KEY_DUPLICATED.
 * This error occurs when another process (worker) has an active connection
 * with the same session. We wait and retry since the other connection
 * may release soon.
 */
const connectWithRetry = async (client: TelegramClient, maxRetries = 3): Promise<void> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await client.connect();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/AUTH_KEY_DUPLICATED/i.test(message) && attempt < maxRetries) {
        // Wait for the other connection to release
        await sleep(5000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
};

export class MtprotoClient {
  async requestOtp(phone: string, label: string) {
    ensureTelegramConfig();

    const client = createClient();

    try {
      await connectWithRetry(client);

      const sent = await (client as any).sendCode(
        {
          apiId: env.TELEGRAM_API_ID,
          apiHash: env.TELEGRAM_API_HASH
        },
        phone
      );

      const phoneCodeHash = sent.phoneCodeHash as string;
      const rawTempSession = client.session.save();
      const tempSession = typeof rawTempSession === "string" ? rawTempSession : "";

      pendingLogins.set(phone, {
        phoneCodeHash,
        label,
        tempSession
      });

      return {
        phone,
        label,
        status: "OTP_SENT"
      };
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  async verifyOtp(phone: string, code: string): Promise<{ session: string; label: string }> {
    const pending = pendingLogins.get(phone);
    if (!pending) {
      throw new Error("No OTP request found. Call request-otp first.");
    }

    const client = createClient(pending.tempSession);

    try {
      await connectWithRetry(client);
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code
        })
      );

      const rawSession = client.session.save();
      const session = typeof rawSession === "string" ? rawSession : "";
      pendingLogins.delete(phone);

      return {
        session,
        label: pending.label
      };
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  async connectFromSession(sessionString: string) {
    ensureTelegramConfig();

    const client = createClient(sessionString);
    await connectWithRetry(client);
    return client;
  }
}

export const mtprotoClient = new MtprotoClient();
