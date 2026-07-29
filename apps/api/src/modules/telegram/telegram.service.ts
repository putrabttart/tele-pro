import { TelegramConnectionStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { decryptText, encryptText } from "../../utils/crypto";
import { logActivity } from "../../utils/logger";
import { ApiError } from "../../utils/api-error";
import { TelegramApiError, mtprotoClient, toTelegramApiError } from "../../telegram/mtproto-client";

const throwTelegramApiError = (error: unknown): never => {
  if (error instanceof ApiError) {
    throw error;
  }

  const normalizedError = toTelegramApiError(error);
  if (normalizedError instanceof TelegramApiError) {
    throw new ApiError(409, normalizedError.message, normalizedError.originalMessage);
  }

  throw normalizedError;
};

class TelegramService {
  async listAccounts() {
    return prisma.telegramAccount.findMany({
      orderBy: { createdAt: "desc" }
    });
  }

  async requestOtp(phone: string, label: string) {
    const result = await mtprotoClient.requestOtp(phone, label).catch((error): never => {
      const msg = error instanceof Error ? error.message : "";
      if (/AUTH_KEY_DUPLICATED/i.test(msg)) {
        throw new ApiError(409, "Akun ini sedang digunakan oleh broadcast yang aktif. Hentikan broadcast dulu atau tunggu sampai selesai, lalu coba lagi.");
      }

      return throwTelegramApiError(error);
    });

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
    const result = await mtprotoClient.verifyOtp(phone, code).catch((error): never => {
      const msg = error instanceof Error ? error.message : "";
      if (/AUTH_KEY_DUPLICATED/i.test(msg)) {
        throw new ApiError(409, "Akun ini sedang digunakan oleh broadcast yang aktif. Hentikan broadcast dulu atau tunggu sampai selesai, lalu coba lagi.");
      }

      return throwTelegramApiError(error);
    });

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
    const client = await mtprotoClient.connectFromSession(decrypted).catch((error): never => {
      return throwTelegramApiError(error);
    });

    await client.disconnect();

    return { connected: true, message: "Session valid" };
  }
}

export const telegramService = new TelegramService();
