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

const createClient = (sessionString = "") => {
  return new TelegramClient(
    new StringSession(sessionString),
    env.TELEGRAM_API_ID!,
    env.TELEGRAM_API_HASH!,
    {
      connectionRetries: 2,
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

export class MtprotoClient {
  async requestOtp(phone: string, label: string) {
    ensureTelegramConfig();

    const client = createClient();

    try {
      await client.connect();

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
      await client.disconnect();
    }
  }

  async verifyOtp(phone: string, code: string): Promise<{ session: string; label: string }> {
    const pending = pendingLogins.get(phone);
    if (!pending) {
      throw new Error("No OTP request found. Call request-otp first.");
    }

    const client = createClient(pending.tempSession);

    try {
      await client.connect();
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
      await client.disconnect();
    }
  }

  async connectFromSession(sessionString: string) {
    ensureTelegramConfig();

    const client = createClient(sessionString);

    await client.connect();
    return client;
  }
}

export const mtprotoClient = new MtprotoClient();
