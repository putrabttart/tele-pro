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
const CLIENT_CONNECT_TIMEOUT_MS = 30_000;

export class TelegramApiError extends Error {
  originalMessage?: string;

  constructor(message: string, originalMessage?: string) {
    super(message);
    this.name = "TelegramApiError";
    this.originalMessage = originalMessage;
  }
}

export const classifyTelegramErrorMessage = (message: string) => {
  if (/AUTH_KEY_DUPLICATED/i.test(message)) {
    return "Akun Telegram ini sedang dipakai koneksi lain, biasanya broadcast aktif atau proses sebelumnya belum selesai. Hentikan broadcast/tunggu beberapa detik lalu coba lagi.";
  }

  if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) {
    return "Sesi Telegram sudah tidak valid. Disconnect akun lalu login ulang.";
  }

  if (/PHONE_CODE_INVALID/i.test(message)) {
    return "Kode OTP salah. Periksa lagi kode dari Telegram.";
  }

  if (/PHONE_CODE_EXPIRED/i.test(message)) {
    return "Kode OTP sudah expired. Request OTP ulang.";
  }

  if (/FLOOD_WAIT/i.test(message) || /a wait of \d+ seconds/i.test(message)) {
    const waitMatch = message.match(/FLOOD_WAIT_(\d+)/i) ?? message.match(/a wait of (\d+) seconds/i);
    const waitSuffix = waitMatch?.[1] ? ` Tunggu sekitar ${waitMatch[1]} detik sebelum mencoba lagi.` : " Coba lagi nanti.";
    return `Telegram membatasi request akun ini.${waitSuffix}`;
  }

  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(message)) {
    return "Username group tidak ditemukan atau tidak valid. Periksa kembali username/link Telegram.";
  }

  if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/i.test(message)) {
    return "Link invite group sudah expired atau tidak valid. Minta link invite baru dari admin group.";
  }

  if (/TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|NETWORK|socket hang up/i.test(message)) {
    return "Koneksi server ke Telegram bermasalah/timeout. Coba lagi setelah koneksi stabil.";
  }

  return null;
};

export const toTelegramApiError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const friendlyMessage = classifyTelegramErrorMessage(message);

  if (friendlyMessage) {
    return new TelegramApiError(friendlyMessage, message);
  }

  return error;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TelegramApiError(message, "TIMEOUT")), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const createClient = (sessionString = "") => {
  return new TelegramClient(
    new StringSession(sessionString),
    env.TELEGRAM_API_ID!,
    env.TELEGRAM_API_HASH!,
    {
      connectionRetries: 3,
      autoReconnect: false,
      timeout: CLIENT_CONNECT_TIMEOUT_MS,
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
      await withTimeout(
        client.connect(),
        CLIENT_CONNECT_TIMEOUT_MS,
        "Koneksi ke Telegram timeout. Periksa koneksi server dan coba lagi."
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/AUTH_KEY_DUPLICATED/i.test(message) && attempt < maxRetries) {
        // Wait for the other connection to release
        await sleep(5000 * (attempt + 1));
        continue;
      }
      throw toTelegramApiError(error);
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
