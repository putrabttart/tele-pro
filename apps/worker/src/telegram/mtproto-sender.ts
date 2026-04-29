import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { env } from "../config/env";
import { decryptText } from "../utils/crypto";

const CLIENT_CONNECT_TIMEOUT_MS = 30_000; // 30s timeout for connection
const SEND_TIMEOUT_MS = 60_000; // 60s timeout for send operation

const createClient = async (encryptedSession: string) => {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  }

  const session = decryptText(encryptedSession);
  const client = new TelegramClient(new StringSession(session), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
    connectionRetries: 3,
    autoReconnect: true,
    timeout: CLIENT_CONNECT_TIMEOUT_MS,
    baseLogger: new Logger(LogLevel.NONE)
  });

  await client.connect();
  return client;
};

const parseFloodWaitSeconds = (errorMessage: string) => {
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i);
  if (!match) {
    return null;
  }

  return Number(match[1]);
};

const normalizeForwardSource = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
};

const resolveForwardMessageId = async (
  client: TelegramClient,
  fromPeer: string,
  preferredMessageId?: number | null
) => {
  if (preferredMessageId && Number.isInteger(preferredMessageId) && preferredMessageId > 0) {
    return preferredMessageId;
  }

  const latestMessages = await (client as any).getMessages(fromPeer, {
    limit: 1
  });

  const firstMessage = Array.isArray(latestMessages)
    ? latestMessages[0]
    : (latestMessages?.[0] ?? latestMessages?.messages?.[0]);

  const messageId = firstMessage?.id;
  return typeof messageId === "number" && messageId > 0 ? messageId : null;
};

export type SendResult = {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  floodWaitSeconds?: number;
};

export class MtprotoSender {
  async sendToGroup(input: {
    encryptedSession: string;
    groupIdentifier: string;
    sendMode: "NEW_MESSAGE" | "FORWARD";
    text: string;
    mediaUrl?: string | null;
    forwardSourceChatId?: string | null;
    forwardMessageId?: number | null;
  }): Promise<SendResult> {
    let client: TelegramClient | null = null;

    try {
      client = await createClient(input.encryptedSession);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown connection error";
      return {
        ok: false,
        errorCode: "CONNECTION_FAILED",
        errorMessage: `Gagal konek ke Telegram: ${message}`
      };
    }

    try {
      if (input.sendMode === "FORWARD" && input.forwardSourceChatId) {
        const fromPeer = normalizeForwardSource(input.forwardSourceChatId);
        const forwardMessageId = await resolveForwardMessageId(client, fromPeer, input.forwardMessageId);

        if (!forwardMessageId) {
          return {
            ok: false,
            errorCode: "FORWARD_MESSAGE_NOT_FOUND",
            errorMessage: "Pesan tidak ditemukan di source forward"
          };
        }

        await (client as any).forwardMessages(input.groupIdentifier, {
          messages: [forwardMessageId],
          fromPeer
        });
      } else {
        await client.sendMessage(input.groupIdentifier, {
          message: input.text,
          ...(input.mediaUrl ? { file: input.mediaUrl } : {})
        });
      }

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Telegram error";

      // ── Categorize Telegram errors ──

      if (/PEER_FLOOD/i.test(message)) {
        return {
          ok: false,
          errorCode: "PEER_FLOOD",
          errorMessage: "Akun terkena limit spam Telegram (PEER_FLOOD)"
        };
      }

      const floodWait = parseFloodWaitSeconds(message);
      if (floodWait) {
        return {
          ok: false,
          errorCode: "FLOOD_WAIT",
          errorMessage: `Rate limit Telegram: tunggu ${floodWait} detik`,
          floodWaitSeconds: floodWait
        };
      }

      if (/CHAT_WRITE_FORBIDDEN/i.test(message)) {
        return {
          ok: false,
          errorCode: "CHAT_WRITE_FORBIDDEN",
          errorMessage: "Akun tidak punya izin menulis di grup ini"
        };
      }

      if (/CHANNEL_PRIVATE/i.test(message)) {
        return {
          ok: false,
          errorCode: "CHANNEL_PRIVATE",
          errorMessage: "Grup/channel bersifat private, akun belum bergabung"
        };
      }

      if (/USER_BANNED_IN_CHANNEL/i.test(message)) {
        return {
          ok: false,
          errorCode: "USER_BANNED",
          errorMessage: "Akun dibanned dari grup ini"
        };
      }

      if (/CHAT_ADMIN_REQUIRED/i.test(message)) {
        return {
          ok: false,
          errorCode: "ADMIN_REQUIRED",
          errorMessage: "Perlu hak admin untuk mengirim di grup ini"
        };
      }

      if (/SLOWMODE_WAIT_(\d+)/i.test(message)) {
        const match = message.match(/SLOWMODE_WAIT_(\d+)/i);
        return {
          ok: false,
          errorCode: "SLOWMODE_WAIT",
          errorMessage: `Grup dalam mode slow: tunggu ${match?.[1] ?? "?"} detik`
        };
      }

      if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) {
        return {
          ok: false,
          errorCode: "SESSION_INVALID",
          errorMessage: "Sesi Telegram sudah expired/revoked, perlu login ulang"
        };
      }

      if (/TIMEOUT|ECONNREFUSED|ENOTFOUND|NETWORK/i.test(message)) {
        return {
          ok: false,
          errorCode: "NETWORK_ERROR",
          errorMessage: `Masalah jaringan: ${message}`
        };
      }

      return {
        ok: false,
        errorCode: "TELEGRAM_SEND_ERROR",
        errorMessage: message
      };
    } finally {
      try {
        if (client) await client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

export const mtprotoSender = new MtprotoSender();
