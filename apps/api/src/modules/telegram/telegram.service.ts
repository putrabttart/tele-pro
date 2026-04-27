import { TelegramConnectionStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { decryptText, encryptText } from "../../utils/crypto";
import { logActivity } from "../../utils/logger";
import { mtprotoClient } from "../../telegram/mtproto-client";

class TelegramService {
  async listAccounts() {
    return prisma.telegramAccount.findMany({
      orderBy: { createdAt: "desc" }
    });
  }

  async requestOtp(phone: string, label: string) {
    const result = await mtprotoClient.requestOtp(phone, label);

    await prisma.telegramAccount.upsert({
      where: { phone },
      create: {
        phone,
        label,
        status: TelegramConnectionStatus.PENDING
      },
      update: {
        label,
        status: TelegramConnectionStatus.PENDING
      }
    });

    await logActivity("telegram", "OTP requested", "INFO", { phone, label });
    return result;
  }

  async verifyOtp(phone: string, code: string) {
    const result = await mtprotoClient.verifyOtp(phone, code);

    const encryptedSession = encryptText(result.session);

    const account = await prisma.telegramAccount.update({
      where: { phone },
      data: {
        encryptedSession,
        status: TelegramConnectionStatus.CONNECTED,
        lastLoginAt: new Date(),
        label: result.label
      }
    });

    await logActivity("telegram", "Account connected", "INFO", {
      accountId: account.id,
      phone: account.phone
    });

    return account;
  }

  async disconnect(accountId: string) {
    const account = await prisma.telegramAccount.update({
      where: { id: accountId },
      data: {
        encryptedSession: null,
        status: TelegramConnectionStatus.DISCONNECTED
      }
    });

    await logActivity("telegram", "Account disconnected", "WARN", {
      accountId: account.id
    });

    return account;
  }

  async testSession(accountId: string) {
    const account = await prisma.telegramAccount.findUnique({ where: { id: accountId } });
    if (!account?.encryptedSession) {
      return { connected: false, message: "No session available" };
    }

    const decrypted = decryptText(account.encryptedSession);
    const client = await mtprotoClient.connectFromSession(decrypted);
    await client.disconnect();

    return { connected: true, message: "Session valid" };
  }
}

export const telegramService = new TelegramService();
