import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { env } from "../config/env";
import { decryptText } from "../utils/crypto";
import { sleep } from "../utils/sleep";

const CLIENT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_SEND_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 3_000;

// ═══════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ═══════════════════════════════════════════════════════════

export type ErrorSeverity = "skip" | "wait_retry" | "pause" | "fatal";

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
      return "skip";
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

const parseFloodWaitSeconds = (msg: string) => {
  // Format 1: FLOOD_WAIT_38707
  const m1 = msg.match(/FLOOD_WAIT_(\d+)/i);
  if (m1) return Number(m1[1]);
  // Format 2: "A wait of 38707 seconds is required"
  const m2 = msg.match(/a wait of (\d+) seconds/i);
  if (m2) return Number(m2[1]);
  return null;
};

const parseSlowmodeWaitSeconds = (msg: string) => {
  const m = msg.match(/SLOWMODE_WAIT_(\d+)/i);
  return m ? Number(m[1]) : null;
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
  const msgs = await (client as any).getMessages(fromPeer, { limit: 1 });
  const first = Array.isArray(msgs) ? msgs[0] : (msgs?.[0] ?? msgs?.messages?.[0]);
  const id = first?.id;
  return typeof id === "number" && id > 0 ? id : null;
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
// PERSISTENT SESSION: One client per account, reused across all sends in a run.
// This prevents AUTH_KEY_DUPLICATED which happens when multiple clients
// connect/disconnect rapidly with the same session string.
// ═══════════════════════════════════════════════════════════

export class MtprotoSender {
  private activeClients = new Map<string, TelegramClient>();

  /**
   * Get or create a persistent client for a session.
   * The client stays connected for the duration of the broadcast run.
   */
  async getClient(encryptedSession: string): Promise<TelegramClient> {
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
    }

    const sessionKey = encryptedSession.slice(0, 32);
    const existing = this.activeClients.get(sessionKey);

    if (existing) {
      try {
        if (existing.connected) {
          return existing;
        }
      } catch {
        // Dead client, remove
      }
      this.activeClients.delete(sessionKey);
    }

    const session = decryptText(encryptedSession);
    const client = new TelegramClient(
      new StringSession(session),
      env.TELEGRAM_API_ID,
      env.TELEGRAM_API_HASH,
      {
        connectionRetries: 5,
        autoReconnect: true,
        timeout: CLIENT_CONNECT_TIMEOUT_MS,
        baseLogger: new Logger(LogLevel.NONE)
      }
    );

    await client.connect();
    this.activeClients.set(sessionKey, client);
    return client;
  }

  /**
   * Disconnect a specific session's client (call at end of run).
   */
  async releaseClient(encryptedSession: string) {
    const sessionKey = encryptedSession.slice(0, 32);
    const client = this.activeClients.get(sessionKey);
    if (client) {
      this.activeClients.delete(sessionKey);
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * Disconnect all clients (graceful shutdown).
   */
  async disconnectAll() {
    for (const [key, client] of this.activeClients.entries()) {
      try { await client.disconnect(); } catch { /* ignore */ }
      this.activeClients.delete(key);
    }
  }

  /**
   * Send a message to a group with automatic retry.
   * Uses persistent client — no connect/disconnect per message.
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

      if (result.ok) return { ...result, retriesUsed };

      const severity = classifyError(result.errorCode);
      result.severity = severity;

      if (severity === "skip" || severity === "fatal" || severity === "pause") {
        return { ...result, retriesUsed };
      }

      // FLOOD_WAIT: Auto-wait if short (<=120s), then retry the SAME group
      if (result.errorCode === "FLOOD_WAIT" && result.floodWaitSeconds) {
        if (result.floodWaitSeconds <= 120 && attempt < MAX_SEND_RETRIES) {
          await sleep((result.floodWaitSeconds + 2) * 1000);
          retriesUsed++;
          continue;
        }
        // Too long (>120s) or out of retries — return to caller
        return { ...result, retriesUsed };
      }

      // SLOWMODE_WAIT: Auto-wait
      if (result.errorCode === "SLOWMODE_WAIT" && result.slowmodeWaitSeconds) {
        if (result.slowmodeWaitSeconds <= 300) {
          await sleep((result.slowmodeWaitSeconds + 2) * 1000);
          retriesUsed++;
          continue;
        }
        return { ...result, severity: "skip", retriesUsed };
      }

      // CONNECTION_FAILED: Release client and retry with fresh connection
      if (result.errorCode === "CONNECTION_FAILED") {
        await this.releaseClient(input.encryptedSession);
        if (attempt < MAX_SEND_RETRIES) {
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
          retriesUsed++;
          continue;
        }
        return { ...result, retriesUsed };
      }

      // Other transient errors: retry with backoff
      if (attempt < MAX_SEND_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        retriesUsed++;
        continue;
      }

      return { ...result, retriesUsed };
    }

    return { ok: false, errorCode: "MAX_RETRIES_EXCEEDED", errorMessage: `Gagal setelah ${MAX_SEND_RETRIES} percobaan`, severity: "skip", retriesUsed };
  }

  /**
   * Single send attempt using persistent client.
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
    let client: TelegramClient;

    try {
      client = await this.getClient(input.encryptedSession);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown connection error";

      if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) {
        return { ok: false, errorCode: "SESSION_INVALID", errorMessage: "Sesi Telegram expired/revoked, perlu login ulang", severity: "fatal" };
      }

      if (/AUTH_KEY_DUPLICATED/i.test(message)) {
        // Another connection with this session is still alive (e.g. from previous worker restart).
        // Wait longer to let the old connection die, then retry with fresh client.
        await this.releaseClient(input.encryptedSession);
        await sleep(10_000); // Wait 10s for old connection to timeout
        return { ok: false, errorCode: "CONNECTION_FAILED", errorMessage: "AUTH_KEY_DUPLICATED — waiting for old connection to expire...", severity: "wait_retry" };
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

      if (/PEER_FLOOD/i.test(message)) return { ok: false, errorCode: "PEER_FLOOD", errorMessage: "Akun terkena limit spam (PEER_FLOOD)", severity: "pause" };

      const floodWait = parseFloodWaitSeconds(message);
      if (floodWait) return { ok: false, errorCode: "FLOOD_WAIT", errorMessage: `Rate limit: tunggu ${floodWait}s`, floodWaitSeconds: floodWait, severity: "wait_retry" };

      const slowWait = parseSlowmodeWaitSeconds(message);
      if (slowWait) return { ok: false, errorCode: "SLOWMODE_WAIT", errorMessage: `Slowmode: tunggu ${slowWait}s`, slowmodeWaitSeconds: slowWait, severity: "wait_retry" };

      if (/CHAT_WRITE_FORBIDDEN/i.test(message)) return { ok: false, errorCode: "CHAT_WRITE_FORBIDDEN", errorMessage: "Tidak punya izin kirim di grup ini", severity: "skip" };
      if (/CHANNEL_PRIVATE/i.test(message)) return { ok: false, errorCode: "CHANNEL_PRIVATE", errorMessage: "Grup private, belum bergabung", severity: "skip" };
      if (/USER_BANNED_IN_CHANNEL/i.test(message)) return { ok: false, errorCode: "USER_BANNED", errorMessage: "Dibanned dari grup ini", severity: "skip" };
      if (/CHAT_ADMIN_REQUIRED/i.test(message)) return { ok: false, errorCode: "ADMIN_REQUIRED", errorMessage: "Perlu hak admin", severity: "skip" };
      if (/AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|SESSION_REVOKED/i.test(message)) return { ok: false, errorCode: "SESSION_INVALID", errorMessage: "Sesi expired, perlu login ulang", severity: "fatal" };
      if (/MSG_ID_INVALID/i.test(message)) return { ok: false, errorCode: "FORWARD_MESSAGE_NOT_FOUND", errorMessage: "Pesan forward tidak valid", severity: "skip" };
      if (/INPUT_USER_DEACTIVATED|USER_DEACTIVATED/i.test(message)) return { ok: false, errorCode: "USER_DEACTIVATED", errorMessage: "Grup/user dinonaktifkan", severity: "skip" };
      if (/CHAT_RESTRICTED/i.test(message)) return { ok: false, errorCode: "CHAT_RESTRICTED", errorMessage: "Grup dibatasi Telegram", severity: "skip" };

      if (/AUTH_KEY_DUPLICATED/i.test(message)) {
        await this.releaseClient(input.encryptedSession);
        await sleep(10_000);
        return { ok: false, errorCode: "CONNECTION_FAILED", errorMessage: "AUTH_KEY_DUPLICATED — waiting for old connection to expire...", severity: "wait_retry" };
      }

      if (/TIMEOUT|ECONNREFUSED|ENOTFOUND|NETWORK/i.test(message)) return { ok: false, errorCode: "NETWORK_ERROR", errorMessage: `Masalah jaringan: ${message}`, severity: "wait_retry" };

      return { ok: false, errorCode: "TELEGRAM_SEND_ERROR", errorMessage: message, severity: "wait_retry" };
    }
    // NOTE: Do NOT disconnect here — client is reused for the entire run
  }
}

export const mtprotoSender = new MtprotoSender();
