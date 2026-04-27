import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { env } from "../config/env";
import { decryptText } from "../utils/crypto";

const createClient = async (encryptedSession: string) => {
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  }

  const session = decryptText(encryptedSession);
  const client = new TelegramClient(new StringSession(session), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
    connectionRetries: 2,
    autoReconnect: false,
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
    const client = await createClient(input.encryptedSession);

    try {
      if (input.sendMode === "FORWARD" && input.forwardSourceChatId) {
        const fromPeer = normalizeForwardSource(input.forwardSourceChatId);
        const forwardMessageId = await resolveForwardMessageId(client, fromPeer, input.forwardMessageId);

        if (!forwardMessageId) {
          return {
            ok: false,
            errorCode: "FORWARD_MESSAGE_NOT_FOUND",
            errorMessage: "No message found in forward source"
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

      if (/PEER_FLOOD/i.test(message)) {
        return {
          ok: false,
          errorCode: "PEER_FLOOD",
          errorMessage: message
        };
      }

      const floodWait = parseFloodWaitSeconds(message);
      if (floodWait) {
        return {
          ok: false,
          errorCode: "FLOOD_WAIT",
          errorMessage: message,
          floodWaitSeconds: floodWait
        };
      }

      return {
        ok: false,
        errorCode: "TELEGRAM_SEND_ERROR",
        errorMessage: message
      };
    } finally {
      await client.disconnect();
    }
  }
}

export const mtprotoSender = new MtprotoSender();
