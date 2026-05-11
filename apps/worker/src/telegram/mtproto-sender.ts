import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { env } from "../config/env";
import { decryptText } from "../utils/crypto";
import { sleep } from "../utils/sleep";

const CLIENT_CONNECT_TIMEOUT_MS = 30_000; // 30s timeout for connection
const MAX_SEND_RETRIES = 3; // Max retries for transient errors
const RETRY_BASE_DELAY_MS = 3_000; // Base delay for retry backoff

// ═══════════════════════════════════════════════════════════
// CLIENT CREATION (fresh per request — no pooling)
// ═══════════════════════════════════════════════════════════
// MTProto does NOT support concurrent requests on the same session.
// AUTH_KEY_DUPLICATED occurs when a pooled client is reused while
// a previous request is still in-flight. Solution: create fresh
// client per send, disconnect after done.
// ═══════════════════════════════════════════════════════════

const createClient = async (encryptedSession: string): Promise<TelegramClient> => {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  }

  const session = decryptText(encryptedSession);
  const client = new TelegramClient(
    new StringSession(session),
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
    {
      connectionRetries: 3,
      autoReconnect: false,
      timeout: CLIENT_CONNECT_TIMEOUT_MS,
      baseLogger: new Logger(LogLevel.NONE)
    }
  );

  await client.connect();
  return client;
};

// ═══════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ═══════════════════════════════════════════════════════════

export type ErrorSeverity = "skip" | "wait_retry" | "pause" | "fatal";

/**
 * Classify error severity:
 * - skip: Group-specific issue, move to next group
 * - wait_retry: Transient error, wait and retry
 * - pause: Account-level issue, pause the run
 * - fatal: Session is dead, stop everything
 */
export const classifyError = (errorCode?: string): ErrorSeverity => {
  switch (errorCode) {
    case "CHAT_WRITE_FORBIDDEN":
    case "CHANNEL_PRIVATE":
    case "USER_BANNED":
    case "ADMIN_REQUIRED":
    case "GROUP_IDENTIFIER_MISSING":
    case "FORWARD_MESSAGE_NOT_FOUND":
    case "USER_DEACTIVATED":
    case "CHAT_RESTRICTED":
      return "skip";

    case "FLOOD_WAIT":
    case "SLOWMODE_WAIT":
    case "NETWORK_ERROR":
    case "CONNECTION_FAILED":
    case "TELEGRAM_SEND_ERROR":
      return "wait_retry";

    case "PEER_FLOOD":
      return "pause";

    case "SESSION_INVALID":
      return "fatal";

    default:
      return "wait_retry";
  }
};

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

const parseFloodWaitSeconds = (errorMessage: string) => {
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i);
  return match ? Number(match[1]) : null;
};

const parseSlowmodeWaitSeconds = (errorMessage: string) => {
  const match = errorMessage.match(/SLOWMODE_WAIT_(\d+)/i);
  return match ? Number(match[1]) : null;
};

const normalizeForwardSource = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
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

  const latestMessages = await (client as any).getMessages(fromPeer, { limit: 1 });
  const firstMessage = Array.isArray(latestMessages)
    ? latestMessages[0]
    : (latestMessages?.[0] ?? latestMessages?.messages?.[0]);

  const messageId = firstMessage?.id;
  return typeof messageId === "number" && messageId > 0 ? messageId : null;
};

// ═══════════════════════════════════════════════════════════
// SEND RESULT TYPE
// ═══════════════════════════════════════════════════════════

export type SendResult = {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  floodWaitSeconds?: number;
  slowmodeWaitSeconds?: number;
  severity?: ErrorSeverity;
  retriesUsed?: number;
};

// ═══════════════════════════════════════════════════════════
// CORE SENDER CLASS
// ═══════════════════════════════════════════════════════════

export class MtprotoSender {
  /**
   * Send a message to a group with automatic retry for transient errors.
   * 
   * - Fresh client per request (no pooling — prevents AUTH_KEY_DUPLICATED)
   * - Auto-retry with exponential backoff for NETWORK_ERROR, CONNECTION_FAILED
   * - Auto-wait for FLOOD_WAIT (up to 120s) then retry
   * - Auto-wait for SLOWMODE_WAIT then retry
   * - Error severity classification for smarter upstream handling
   */
  async sendToGroup(input: {
    encryptedSession: string;
    groupIdentifier: string;
    sendMode: "NEW_MESSAGE" | "FORWARD";
    text: string;
    mediaUrl?: string | null;
    forwardSourceChatId?: string | null;
    forwardMessageId?: number | null;
  }): Promise<SendResult> {
    let retriesUsed = 0;

    for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
      const result = await this._attemptSend(input);

      if (result.ok) {
        return { ...result, retriesUsed };
      }

      const severity = classifyError(result.errorCode);
      result.severity = severity;

      // SKIP errors: Don't retry
      if (severity === "skip") return { ...result, retriesUsed };

      // FATAL errors: Don't retry
      if (severity === "fatal") return { ...result, retriesUsed };

      // PAUSE errors: Don't retry
      if (severity === "pause") return { ...result, retriesUsed };

      // ── WAIT & RETRY ──

      // FLOOD_WAIT: Auto-wait if <= 120 seconds
      if (result.errorCode === "FLOOD_WAIT" && result.floodWaitSeconds) {
        if (result.floodWaitSeconds <= 120) {
          await sleep((result.floodWaitSeconds + 5) * 1000);
          retriesUsed++;
          continue;
        }
        return { ...result, retriesUsed };
      }

      // SLOWMODE_WAIT: Auto-wait then retry
      if (result.errorCode === "SLOWMODE_WAIT" && result.slowmodeWaitSeconds) {
        if (result.slowmodeWaitSeconds <= 300) {
          await sleep((result.slowmodeWaitSeconds + 2) * 1000);
          retriesUsed++;
          continue;
        }
        return { ...result, severity: "skip", retriesUsed };
      }

      // NETWORK_ERROR / CONNECTION_FAILED: Retry with backoff
      if (result.errorCode === "NETWORK_ERROR" || result.errorCode === "CONNECTION_FAILED") {
        if (attempt < MAX_SEND_RETRIES) {
          const backoffMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(backoffMs);
          retriesUsed++;
          continue;
        }
        return { ...result, retriesUsed };
      }

      // Generic error: Retry once with backoff
      if (attempt < MAX_SEND_RETRIES) {
        const backoffMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(backoffMs);
        retriesUsed++;
        continue;
      }

      return { ...result, retriesUsed };
    }

    return {
      ok: false,
      errorCode: "MAX_RETRIES_EXCEEDED",
      errorMessage: `Gagal setelah ${MAX_SEND_RETRIES} percobaan`,
      severity: "skip",
      retriesUsed
    };
  }

  /**
   * Single send attempt — creates fresh client, sends, disconnects.
   */
  private async _attemptSend(input: {
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

      if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) {
        return { ok: false, errorCode: "SESSION_INVALID", errorMessage: "Sesi Telegram sudah expired/revoked, perlu login ulang", severity: "fatal" };
      }

      if (/AUTH_KEY_DUPLICATED/i.test(message)) {
        // This means another connection is using the same session simultaneously.
        // Treat as transient — retry will create a new connection after the other one finishes.
        return { ok: false, errorCode: "CONNECTION_FAILED", errorMessage: "Session sedang digunakan koneksi lain, retry...", severity: "wait_retry" };
      }

      return { ok: false, errorCode: "CONNECTION_FAILED", errorMessage: `Gagal konek ke Telegram: ${message}`, severity: "wait_retry" };
    }

    try {
      if (input.sendMode === "FORWARD" && input.forwardSourceChatId) {
        const fromPeer = normalizeForwardSource(input.forwardSourceChatId);
        const forwardMessageId = await resolveForwardMessageId(client, fromPeer, input.forwardMessageId);

        if (!forwardMessageId) {
          return { ok: false, errorCode: "FORWARD_MESSAGE_NOT_FOUND", errorMessage: "Pesan tidak ditemukan di source forward", severity: "skip" };
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

      if (/PEER_FLOOD/i.test(message)) {
        return { ok: false, errorCode: "PEER_FLOOD", errorMessage: "Akun terkena limit spam Telegram (PEER_FLOOD)", severity: "pause" };
      }

      const floodWait = parseFloodWaitSeconds(message);
      if (floodWait) {
        return { ok: false, errorCode: "FLOOD_WAIT", errorMessage: `Rate limit Telegram: tunggu ${floodWait} detik`, floodWaitSeconds: floodWait, severity: "wait_retry" };
      }

      const slowmodeWait = parseSlowmodeWaitSeconds(message);
      if (slowmodeWait) {
        return { ok: false, errorCode: "SLOWMODE_WAIT", errorMessage: `Grup dalam mode slow: tunggu ${slowmodeWait} detik`, slowmodeWaitSeconds: slowmodeWait, severity: "wait_retry" };
      }

      if (/CHAT_WRITE_FORBIDDEN/i.test(message)) {
        return { ok: false, errorCode: "CHAT_WRITE_FORBIDDEN", errorMessage: "Akun tidak punya izin menulis di grup ini", severity: "skip" };
      }

      if (/CHANNEL_PRIVATE/i.test(message)) {
        return { ok: false, errorCode: "CHANNEL_PRIVATE", errorMessage: "Grup/channel bersifat private, akun belum bergabung", severity: "skip" };
      }

      if (/USER_BANNED_IN_CHANNEL/i.test(message)) {
        return { ok: false, errorCode: "USER_BANNED", errorMessage: "Akun dibanned dari grup ini", severity: "skip" };
      }

      if (/CHAT_ADMIN_REQUIRED/i.test(message)) {
        return { ok: false, errorCode: "ADMIN_REQUIRED", errorMessage: "Perlu hak admin untuk mengirim di grup ini", severity: "skip" };
      }

      if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) {
        return { ok: false, errorCode: "SESSION_INVALID", errorMessage: "Sesi Telegram sudah expired/revoked, perlu login ulang", severity: "fatal" };
      }

      if (/AUTH_KEY_DUPLICATED/i.test(message)) {
        return { ok: false, errorCode: "CONNECTION_FAILED", errorMessage: "Session conflict (AUTH_KEY_DUPLICATED), retry...", severity: "wait_retry" };
      }

      if (/TIMEOUT|ECONNREFUSED|ENOTFOUND|NETWORK/i.test(message)) {
        return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: `Masalah jaringan: ${message}`, severity: "wait_retry" };
      }

      if (/MSG_ID_INVALID/i.test(message)) {
        return { ok: false, errorCode: "FORWARD_MESSAGE_NOT_FOUND", errorMessage: "Pesan forward sudah dihapus atau tidak valid", severity: "skip" };
      }

      if (/INPUT_USER_DEACTIVATED|USER_DEACTIVATED/i.test(message)) {
        return { ok: false, errorCode: "USER_DEACTIVATED", errorMessage: "Grup/user sudah dinonaktifkan", severity: "skip" };
      }

      if (/CHAT_RESTRICTED/i.test(message)) {
        return { ok: false, errorCode: "CHAT_RESTRICTED", errorMessage: "Grup dibatasi oleh Telegram", severity: "skip" };
      }

      return { ok: false, errorCode: "TELEGRAM_SEND_ERROR", errorMessage: message, severity: "wait_retry" };
    } finally {
      // Always disconnect — no pooling
      try {
        if (client) await client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }

  /**
   * Disconnect all clients (for graceful shutdown — no-op now since no pooling)
   */
  async disconnectAll() {
    // No-op: no pool to clean up
  }
}

export const mtprotoSender = new MtprotoSender();
